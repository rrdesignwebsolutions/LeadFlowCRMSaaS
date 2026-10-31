import type { Env, Session } from "./index"

const GRAPH_VERSION = "v26.0"

const WINDOW_MS = 24 * 60 * 60 * 1000

const STATUS_RANK: Record<string, number> = {
  queued: 0,
  accepted: 1,
  sent: 2,
  delivered: 3,
  read: 4,
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })

const uid = () => crypto.randomUUID()

const enc = new TextEncoder()

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

const unb64 = (value: string) =>
  Uint8Array.from(atob(value), (c) => c.charCodeAt(0))

async function aesKey(env: Env) {
  if (!env.ENCRYPTION_KEY) throw new Error("ENCRYPTION_KEY não configurada")

  return crypto.subtle.importKey(
    "raw",
    unb64(env.ENCRYPTION_KEY),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  )
}

export async function encryptToken(env: Env, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))

  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await aesKey(env),
    enc.encode(plain),
  )

  return `${b64(iv)}.${b64(new Uint8Array(cipher))}`
}

export async function decryptToken(env: Env, stored: string) {
  const [iv, cipher] = stored.split(".")

  if (!iv || !cipher) throw new Error("Token armazenado em formato inválido")

  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(iv) },
    await aesKey(env),
    unb64(cipher),
  )

  return new TextDecoder().decode(plain)
}

// A Meta pode enviar números brasileiros sem o nono dígito; aceitamos as duas formas ao localizar contatos.

export function phoneVariants(digits: string) {
  const variants = new Set([`+${digits}`])

  if (digits.startsWith("55") && digits.length === 12)
    variants.add(`+${digits.slice(0, 4)}9${digits.slice(4)}`)

  if (digits.startsWith("55") && digits.length === 13 && digits[4] === "9")
    variants.add(`+${digits.slice(0, 4)}${digits.slice(5)}`)

  return [...variants]
}

type GraphResult = {
  ok: boolean
  status: number
  data: {
    error?: { message?: string; code?: number; error_user_msg?: string }
    [key: string]: unknown
  }
}

async function graphFetch(
  env: Env,
  path: string,
  token: string,
  body?: unknown,
): Promise<GraphResult> {
  const response = await fetch(
    `${env.GRAPH_API_BASE ?? "https://graph.facebook.com"}/${GRAPH_VERSION}/${path}`,
    {
      method: body ? "POST" : "GET",

      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },

      body: body ? JSON.stringify(body) : undefined,
    },
  )

  const data = (await response.json().catch(() => ({}))) as GraphResult["data"]

  return { ok: response.ok, status: response.status, data }
}

const graphMessage = (result: GraphResult) =>
  result.data.error?.error_user_msg ??
  result.data.error?.message ??
  `HTTP ${result.status}`

type WaMessage = {
  id?: string
  from?: string
  timestamp?: string
  type?: string

  text?: { body?: string }

  image?: { caption?: string }
  video?: { caption?: string }
  document?: { caption?: string }

  button?: { text?: string }

  interactive?: {
    button_reply?: { title?: string }
    list_reply?: { title?: string }
  }
}

type WaStatus = {
  id?: string
  status?: string
  errors?: Array<{ code?: number }>
}

type WaValue = {
  metadata?: { phone_number_id?: string }

  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>

  messages?: WaMessage[]

  statuses?: WaStatus[]
}

type Integration = { id: string; organization_id: string }

function describeMessage(m: WaMessage) {
  const type = m.type ?? "unknown"

  const labels: Record<string, string> = {
    image: "[Imagem]",
    video: "[Vídeo]",
    audio: "[Áudio]",
    document: "[Documento]",
    sticker: "[Figurinha]",
    location: "[Localização]",
    contacts: "[Contato]",
    reaction: "[Reação]",
  }

  const body =
    m.text?.body ??
    m.button?.text ??
    m.interactive?.button_reply?.title ??
    m.interactive?.list_reply?.title ??
    [
      labels[type] ?? `[${type}]`,
      m.image?.caption ?? m.video?.caption ?? m.document?.caption,
    ]
      .filter(Boolean)
      .join(" ")

  return { type, body: body.slice(0, 4096) }
}

async function handleInbound(
  env: Env,
  integration: Integration,
  value: WaValue,
  m: WaMessage,
) {
  const waId = m.from?.replace(/\D/g, "")

  if (!waId || !m.id) throw new Error("mensagem sem remetente ou id")

  const org = integration.organization_id

  const profileName =
    value.contacts
      ?.find((c) => c.wa_id === waId)
      ?.profile?.name?.trim()
      .slice(0, 120) || null

  const variants = phoneVariants(waId)

  const existing = await env.DB.prepare(
    `SELECT id,name FROM contacts WHERE organization_id=? AND phone_e164 IN (${variants.map(() => "?").join(",")}) LIMIT 1`,
  )

    .bind(org, ...variants)
    .first<{ id: string; name: string | null }>()

  const contactId = existing?.id ?? uid()

  const conversation = await env.DB.prepare(
    "SELECT id FROM conversations WHERE organization_id=? AND contact_id=? AND integration_id=?",
  )

    .bind(org, contactId, integration.id)
    .first<{ id: string }>()

  const conversationId = conversation?.id ?? uid()

  const at = m.timestamp
    ? new Date(Number(m.timestamp) * 1000).toISOString()
    : new Date().toISOString()

  const { type, body } = describeMessage(m)

  const batch: D1PreparedStatement[] = []

  if (!existing)
    batch.push(
      env.DB.prepare(
        "INSERT INTO contacts(id,organization_id,name,phone_e164) VALUES(?,?,?,?)",
      ).bind(contactId, org, profileName, `+${waId}`),
    )
  else if (!existing.name && profileName)
    batch.push(
      env.DB.prepare(
        "UPDATE contacts SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      ).bind(profileName, contactId, org),
    )

  batch.push(
    env.DB.prepare(
      "INSERT OR IGNORE INTO leads(id,organization_id,contact_id,status) VALUES(?,?,?,'new')",
    ).bind(uid(), org, contactId),
  )

  if (!conversation)
    batch.push(
      env.DB.prepare(
        "INSERT INTO conversations(id,organization_id,contact_id,integration_id,status,unread_count) VALUES(?,?,?,?,'open',0)",
      ).bind(conversationId, org, contactId, integration.id),
    )

  batch.push(
    env.DB.prepare(
      "INSERT INTO messages(id,organization_id,conversation_id,external_id,direction,type,body,status,external_created_at) VALUES(?,?,?,?,'inbound',?,?,'received',?)",
    )

      .bind(uid(), org, conversationId, m.id, type, body, at),

    env.DB.prepare(
      "UPDATE conversations SET last_message_at=?,unread_count=unread_count+1,status='open',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(at, conversationId, org),
  )

  await env.DB.batch(batch)
}

async function handleStatus(env: Env, integration: Integration, s: WaStatus) {
  const next = s.status

  if (!s.id || !next) return

  const message = await env.DB.prepare(
    "SELECT id,status FROM messages WHERE organization_id=? AND external_id=? AND direction='outbound'",
  )

    .bind(integration.organization_id, s.id)
    .first<{ id: string; status: string }>()

  if (!message) return

  if (next === "failed") {
    await env.DB.prepare(
      "UPDATE messages SET status='failed',error_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )

      .bind(
        String(s.errors?.[0]?.code ?? "unknown"),
        message.id,
        integration.organization_id,
      )
      .run()

    return
  }

  if (
    !(next in STATUS_RANK) ||
    STATUS_RANK[next]! <= (STATUS_RANK[message.status] ?? -1)
  )
    return

  await env.DB.prepare(
    "UPDATE messages SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
  )
    .bind(next, message.id, integration.organization_id)
    .run()
}

export async function handleMetaPayload(
  env: Env,

  payload: {
    object?: string
    entry?: Array<{ changes?: Array<{ value?: WaValue }> }>
  },

  payloadHash: string,
) {
  if (payload.object !== "whatsapp_business_account") return

  for (const entry of payload.entry ?? [])
    for (const change of entry.changes ?? []) {
      const value = change.value

      if (!value) continue

      const phone = value.metadata?.phone_number_id

      const integration = phone
        ? await env.DB.prepare(
            "SELECT id,organization_id FROM integrations WHERE provider='meta_whatsapp' AND phone_number_id=? AND status='connected'",
          )

            .bind(phone)
            .first<Integration>()
        : null

      const items = [
        ...(value.messages ?? []).map((item) => ({
          key: `${item.id}:message`,
          run: () => handleInbound(env, integration!, value, item),
        })),

        ...(value.statuses ?? []).map((item) => ({
          key: `${item.id}:${item.status}`,
          run: () => handleStatus(env, integration!, item),
        })),
      ]

      for (const item of items) {
        const eventId = uid()

        const inserted =
          await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(id,provider,external_event_id,phone_number_id,organization_id,payload_hash,status)
        VALUES(?,'meta_whatsapp',?,?,?,?,?)`)
            .bind(
              eventId,
              item.key,
              phone ?? null,
              integration?.organization_id ?? null,
              payloadHash,
              integration ? "received" : "ignored",
            )
            .run()

        if (!inserted.meta.changes || !integration) continue

        try {
          await item.run()

          await env.DB.prepare(
            "UPDATE webhook_events SET status='processed',processed_at=CURRENT_TIMESTAMP WHERE id=?",
          )
            .bind(eventId)
            .run()
        } catch (error) {
          console.error(
            "webhook_item_failed",
            error instanceof Error ? error.message : "unknown",
          )

          await env.DB.prepare(
            "UPDATE webhook_events SET status='failed',error_summary=? WHERE id=?",
          )

            .bind(
              error instanceof Error
                ? error.message.slice(0, 200)
                : "erro desconhecido",
              eventId,
            )
            .run()
        }
      }
    }
}

async function connect(
  env: Env,
  auth: Session,
  body: { phoneNumberId?: string; wabaId?: string; accessToken?: string },
) {
  const phoneNumberId = body.phoneNumberId?.trim(),
    wabaId = body.wabaId?.trim(),
    token = body.accessToken?.trim()

  if (
    !phoneNumberId ||
    !/^\d{5,25}$/.test(phoneNumberId) ||
    !wabaId ||
    !/^\d{5,25}$/.test(wabaId)
  )
    return json(
      { error: "Informe o Phone Number ID e o WABA ID (apenas números)." },
      400,
    )

  if (!token || token.length < 20 || /\s/.test(token))
    return json({ error: "Informe o token de acesso permanente." }, 400)

  if (!env.ENCRYPTION_KEY)
    return json(
      { error: "Servidor sem chave de criptografia configurada." },
      503,
    )

  const check = await graphFetch(
    env,
    `${phoneNumberId}?fields=display_phone_number,verified_name`,
    token,
  ).catch(() => null)

  if (!check)
    return json(
      { error: "Não foi possível contatar a API da Meta. Tente novamente." },
      502,
    )

  if (!check.ok)
    return json(
      { error: `A Meta recusou as credenciais: ${graphMessage(check)}` },
      400,
    )

  const sameNumber = await env.DB.prepare(
    "SELECT id,organization_id FROM integrations WHERE provider='meta_whatsapp' AND phone_number_id=?",
  )

    .bind(phoneNumberId)
    .first<{ id: string; organization_id: string }>()

  if (sameNumber && sameNumber.organization_id !== auth.organizationId)
    return json(
      { error: "Este número já está conectado a outra empresa." },
      409,
    )

  if (!sameNumber) {
    const active = await env.DB.prepare(
      "SELECT 1 x FROM integrations WHERE organization_id=? AND provider='meta_whatsapp' AND status IN ('connected','error')",
    )
      .bind(auth.organizationId)
      .first()

    if (active)
      return json(
        {
          error:
            "Já existe um número conectado. Desconecte-o antes de conectar outro.",
        },
        409,
      )
  }

  const display = String(check.data.display_phone_number ?? ""),
    verifiedName = String(check.data.verified_name ?? "")

  const encrypted = await encryptToken(env, token)

  const integrationId = sameNumber?.id ?? uid()

  if (sameNumber) {
    await env.DB.prepare(`UPDATE integrations SET status='connected',external_account_id=?,display_phone_number=?,access_token_enc=?,error_code=NULL,error_summary=NULL,
      connected_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
      .bind(wabaId, display, encrypted, integrationId, auth.organizationId)
      .run()
  } else {
    await env.DB.prepare(`INSERT INTO integrations(id,organization_id,provider,status,external_account_id,phone_number_id,display_phone_number,access_token_enc,connected_at)
      VALUES(?,?,'meta_whatsapp','connected',?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(
        integrationId,
        auth.organizationId,
        wabaId,
        phoneNumberId,
        display,
        encrypted,
      )
      .run()
  }

  await env.DB.prepare(
    "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,?,?,?,?)",
  )

    .bind(
      uid(),
      auth.organizationId,
      auth.userId,
      "integration.connected",
      "integration",
      integrationId,
    )
    .run()

  const subscription = await graphFetch(
    env,
    `${wabaId}/subscribed_apps`,
    token,
    {},
  ).catch(() => null)

  return json({
    ok: true,
    displayPhoneNumber: display,
    verifiedName,
    subscribed: !!subscription?.ok,
    subscribeError:
      subscription && !subscription.ok ? graphMessage(subscription) : undefined,
  })
}

async function connectWithEmbeddedSignup(
  env: Env,
  auth: Session,
  body: { code?: string; phoneNumberId?: string; wabaId?: string },
) {
  const code = body.code?.trim()

  const phoneNumberId = body.phoneNumberId?.trim()

  const wabaId = body.wabaId?.trim()

  if (!code || code.length > 4096 || /\s/.test(code))
    return json(
      { error: "Código de autorização inválido. Inicie o cadastro novamente." },
      400,
    )

  if (
    !phoneNumberId ||
    !/^\d{5,25}$/.test(phoneNumberId) ||
    !wabaId ||
    !/^\d{5,25}$/.test(wabaId)
  )
    return json(
      {
        error:
          "A Meta não retornou o Phone Number ID e o WABA ID. Inicie o cadastro novamente.",
      },
      400,
    )

  if (!env.META_APP_ID || !env.META_APP_SECRET || !env.ENCRYPTION_KEY)
    return json(
      {
        error:
          "Configuração do servidor incompleta para concluir o cadastro incorporado.",
      },
      503,
    )

  const exchangeUrl = new URL(
    `${env.GRAPH_API_BASE ?? "https://graph.facebook.com"}/${GRAPH_VERSION}/oauth/access_token`,
  )

  exchangeUrl.searchParams.set("client_id", env.META_APP_ID)

  exchangeUrl.searchParams.set("client_secret", env.META_APP_SECRET)

  exchangeUrl.searchParams.set("code", code)

  let response: Response

  try {
    response = await fetch(exchangeUrl)
  } catch {
    return json(
      {
        error:
          "Não foi possível concluir a autorização com a Meta. Tente novamente.",
      },
      502,
    )
  }

  const result = (await response.json().catch(() => ({}))) as {
    access_token?: string

    error?: { message?: string; error_user_msg?: string }
  }

  if (!response.ok || !result.access_token) {
    const message = result.error?.error_user_msg ?? result.error?.message

    return json(
      {
        error: `A Meta não concluiu a autorização${
          message ? `: ${message}` : "."
        }`,
      },
      400,
    )
  }

  return connect(env, auth, {
    phoneNumberId,
    wabaId,
    accessToken: result.access_token,
  })
}

async function sendText(
  env: Env,
  auth: Session,
  conversationId: string,
  text: unknown,
) {
  const body = typeof text === "string" ? text.trim() : ""

  if (!body || body.length > 4096)
    return json(
      { error: "A mensagem deve ter entre 1 e 4096 caracteres." },
      400,
    )

  const conversation =
    await env.DB.prepare(`SELECT c.id,ct.phone_e164 phone,i.phone_number_id phoneNumberId,i.access_token_enc token,i.status integrationStatus,i.id integrationId
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
    JOIN integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id
    WHERE c.id=? AND c.organization_id=?`)
      .bind(conversationId, auth.organizationId)

      .first<{
        id: string
        phone: string
        phoneNumberId: string
        token: string | null
        integrationStatus: string
        integrationId: string
      }>()

  if (!conversation) return json({ error: "Conversa não encontrada." }, 404)

  if (conversation.integrationStatus !== "connected" || !conversation.token)
    return json(
      {
        error:
          "O WhatsApp está desconectado ou com erro. Reconecte em Configurações.",
      },
      409,
    )

  const lastInbound = await env.DB.prepare(
    "SELECT MAX(external_created_at) at FROM messages WHERE organization_id=? AND conversation_id=? AND direction='inbound'",
  )

    .bind(auth.organizationId, conversationId)
    .first<{ at: string | null }>()

  if (
    !lastInbound?.at ||
    Date.now() - new Date(lastInbound.at).getTime() > WINDOW_MS
  )
    return json(
      {
        error:
          "A janela de 24 horas se encerrou. Só é possível reiniciar a conversa com um modelo aprovado pela Meta (ainda não disponível aqui).",
      },
      422,
    )

  const messageId = uid()

  await env.DB.prepare(
    "INSERT INTO messages(id,organization_id,conversation_id,direction,type,body,status,sent_by) VALUES(?,?,?,'outbound','text',?,'queued',?)",
  )

    .bind(messageId, auth.organizationId, conversationId, body, auth.userId)
    .run()

  const fail = async (code: string, message: string, status = 502) => {
    await env.DB.prepare(
      "UPDATE messages SET status='failed',error_code=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(code, messageId, auth.organizationId)
      .run()

    return json({ error: message, messageId }, status)
  }

  let result: GraphResult

  try {
    const token = await decryptToken(env, conversation.token)

    result = await graphFetch(
      env,
      `${conversation.phoneNumberId}/messages`,
      token,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: conversation.phone.replace(/\D/g, ""),
        type: "text",
        text: { body, preview_url: false },
      },
    )
  } catch (error) {
    console.error(
      "send_failed",
      error instanceof Error ? error.message : "unknown",
    )

    return fail("network", "Não foi possível enviar agora. Tente novamente.")
  }

  if (!result.ok) {
    const code = String(result.data.error?.code ?? result.status)

    if (result.data.error?.code === 190)
      await env.DB.prepare(
        "UPDATE integrations SET status='error',error_code='190',error_summary='Token inválido ou expirado',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      )
        .bind(conversation.integrationId, auth.organizationId)
        .run()

    return fail(code, `A Meta recusou o envio: ${graphMessage(result)}`)
  }

  const externalId =
    (result.data.messages as Array<{ id?: string }> | undefined)?.[0]?.id ??
    null

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET status='accepted',external_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(externalId, messageId, auth.organizationId),

    env.DB.prepare(
      "UPDATE conversations SET last_message_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(new Date().toISOString(), conversationId, auth.organizationId),
  ])

  return json({ ok: true, messageId }, 201)
}

export async function whatsappRoutes(
  request: Request,
  env: Env,
  url: URL,
  auth: Session,
): Promise<Response | null> {
  const path = url.pathname

  const org = auth.organizationId

  if (
    path === "/api/integrations/whatsapp" ||
    path === "/api/integrations/whatsapp/embedded-signup"
  ) {
    if (path === "/api/integrations/whatsapp" && request.method === "GET") {
      const integration =
        await env.DB.prepare(`SELECT status,phone_number_id phoneNumberId,display_phone_number displayPhoneNumber,error_summary errorSummary,connected_at connectedAt
        FROM integrations WHERE organization_id=? AND provider='meta_whatsapp' AND status!='disconnected' ORDER BY created_at DESC LIMIT 1`)
          .bind(org)
          .first()

      return json({
        integration: integration ?? null,

        webhookUrl: `${new URL(env.APP_ORIGIN).origin}/api/webhooks/meta`,

        embeddedSignup: {
          appId: env.META_APP_ID ?? null,
          configId: env.META_CONFIG_ID ?? null,
        },

        serverReady: {
          appSecret: !!env.META_APP_SECRET,
          verifyToken: !!env.META_VERIFY_TOKEN,
          encryptionKey: !!env.ENCRYPTION_KEY,
        },
      })
    }

    if (auth.role !== "admin")
      return json(
        { error: "Apenas administradores podem alterar a integração." },
        403,
      )

    if (
      path === "/api/integrations/whatsapp/embedded-signup" &&
      request.method === "POST"
    )
      return connectWithEmbeddedSignup(env, auth, await request.json())

    if (path === "/api/integrations/whatsapp" && request.method === "POST")
      return connect(env, auth, await request.json())

    if (path === "/api/integrations/whatsapp" && request.method === "DELETE") {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE integrations SET status='disconnected',access_token_enc=NULL,updated_at=CURRENT_TIMESTAMP WHERE organization_id=? AND provider='meta_whatsapp' AND status IN ('connected','error')",
        ).bind(org),

        env.DB.prepare(
          "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type) VALUES(?,?,?,'integration.disconnected','integration')",
        ).bind(uid(), org, auth.userId),
      ])

      return json({ ok: true })
    }
  }

  if (path === "/api/conversations" && request.method === "GET") {
    return json(
      await env.DB.prepare(`SELECT c.id,c.unread_count unread,c.last_message_at lastMessageAt,ct.name,ct.phone_e164 phone,
      (SELECT m.body FROM messages m WHERE m.conversation_id=c.id AND m.organization_id=c.organization_id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) preview
      FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
      WHERE c.organization_id=? ORDER BY c.last_message_at DESC LIMIT 200`)
        .bind(org)
        .all(),
    )
  }

  const match = path.match(/^\/api\/conversations\/([\w-]+)\/(messages|read)$/)

  if (!match) return null

  const conversationId = match[1]!

  if (match[2] === "messages" && request.method === "POST")
    return sendText(
      env,
      auth,
      conversationId,
      (await request.json<{ body?: unknown }>()).body,
    )

  const owned = await env.DB.prepare(
    "SELECT id FROM conversations WHERE id=? AND organization_id=?",
  )
    .bind(conversationId, org)
    .first()

  if (!owned) return json({ error: "Conversa não encontrada." }, 404)

  if (match[2] === "read" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE conversations SET unread_count=0 WHERE id=? AND organization_id=?",
    )
      .bind(conversationId, org)
      .run()

    return json({ ok: true })
  }

  if (match[2] === "messages" && request.method === "GET") {
    const rows =
      await env.DB.prepare(`SELECT id,direction,type,body,status,error_code errorCode,COALESCE(external_created_at,created_at) at
      FROM messages WHERE organization_id=? AND conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200`)
        .bind(org, conversationId)
        .all()

    const last = await env.DB.prepare(
      "SELECT MAX(external_created_at) at FROM messages WHERE organization_id=? AND conversation_id=? AND direction='inbound'",
    )
      .bind(org, conversationId)
      .first<{ at: string | null }>()

    const windowEndsAt = last?.at
      ? new Date(new Date(last.at).getTime() + WINDOW_MS).toISOString()
      : null

    return json({
      messages: rows.results.reverse(),
      windowOpen:
        !!windowEndsAt && new Date(windowEndsAt).getTime() > Date.now(),
      windowEndsAt,
    })
  }

  return null
}
