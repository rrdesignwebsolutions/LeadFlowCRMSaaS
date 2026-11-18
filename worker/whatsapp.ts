import type { Env, Session } from "./index"
import { autoReply, classifyLead, requestHuman, TALK_TO_HUMAN_ID } from "./ai"
import { effectiveLeadStatus } from "./lead-status"

const GRAPH_VERSION = "v26.0"

const WINDOW_MS = 24 * 60 * 60 * 1000
const INBOUND_MEDIA_LIMIT = 16 * 1024 * 1024

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
    error?: MetaApiError
    [key: string]: unknown
  }
}

type MetaApiError = {
  code?: number
  error_subcode?: number
  title?: string
  message?: string
  error_user_msg?: string
  error_user_title?: string
  error_data?: { details?: string }
  fbtrace_id?: string
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

function metaErrorMessage(error: MetaApiError | undefined, fallback: string) {
  const details = [
    error?.title,
    error?.error_user_title,
    error?.error_user_msg,
    error?.message,
    error?.error_data?.details,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value)
  const uniqueDetails = [...new Set(details)]
  return (uniqueDetails.join(": ") || fallback).slice(0, 1000)
}

function logMetaApiError(event: string, result: GraphResult) {
  const error = result.data.error
  console.error(event, {
    httpStatus: result.status,
    code: error?.code ?? null,
    subcode: error?.error_subcode ?? null,
    fbtraceId: error?.fbtrace_id ?? null,
    message: metaErrorMessage(error, `HTTP ${result.status}`),
  })
}

const graphMessage = (result: GraphResult) =>
  metaErrorMessage(result.data.error, `HTTP ${result.status}`)

type WaMessage = {
  id?: string
  from?: string
  from_user_id?: string
  to?: string
  timestamp?: string
  type?: string
  history_context?: { status?: string }
  errors?: Array<{ code?: number }>
  unsupported?: { type?: string }

  text?: { body?: string }

  reaction?: { message_id?: string emoji?: string }

  image?: { id?: string caption?: string mime_type?: string }
  video?: { id?: string caption?: string mime_type?: string }
  document?: {
    id?: string
    caption?: string
    filename?: string
    mime_type?: string
  }
  audio?: { id?: string mime_type?: string }
  sticker?: { id?: string mime_type?: string }

  button?: { text?: string payload?: string }

  interactive?: {
    type?: string
    button_reply?: { id?: string title?: string }
    list_reply?: { id?: string title?: string description?: string }
    nfm_reply?: { body?: string name?: string response_json?: string }
  }
}

type WaStatus = {
  id?: string
  status?: string
  errors?: MetaApiError[]
}

type WaValue = {
  metadata?: { phone_number_id?: string display_phone_number?: string }

  contacts?: Array<{ wa_id?: string profile?: { name?: string } }>

  messages?: WaMessage[]

  message_echoes?: WaMessage[]

  statuses?: WaStatus[]

  history?: Array<{
    metadata?: { phase?: number chunk_order?: number progress?: number }
    threads?: Array<{
      id?: string
      context?: { wa_id?: string user_id?: string }
      messages?: WaMessage[]
    }>
    errors?: Array<{ code?: number }>
  }>

  errors?: Array<{ code?: number }>

  event?: string

  waba_info?: { partner_app_id?: string }
}

type Integration = {
  id: string
  organization_id: string
  display_phone_number?: string
}

export async function cleanupPendingWhatsappSignups(env: Env) {
  await env.DB.prepare(
    "DELETE FROM whatsapp_pending_signups WHERE expires_at<=CURRENT_TIMESTAMP",
  ).run()
}

export function accountUpdateAction(
  event: string | undefined,
  partnerAppId: string | undefined,
  appId: string | undefined,
): "disconnect" | "error" | "record" {
  if (event === "ACCOUNT_DELETED") return "disconnect"

  if (
    event === "PARTNER_APP_UNINSTALLED" &&
    partnerAppId &&
    appId &&
    partnerAppId === appId
  )
    return "disconnect"

  if (
    event &&
    [
      "ACCOUNT_OFFBOARDED",
      "ACCOUNT_RESTRICTION",
      "ACCOUNT_VIOLATION",
      "DISABLED_UPDATE",
    ].includes(event)
  )
    return "error"

  return "record"
}

async function handleAccountUpdate(
  env: Env,
  integration: Integration,
  value: WaValue,
) {
  const action = accountUpdateAction(
    value.event,
    value.waba_info?.partner_app_id,
    env.META_APP_ID,
  )

  if (action === "disconnect") {
    await env.DB.prepare(`UPDATE integrations
      SET status='disconnected',access_token_enc=NULL,error_code=?,error_summary=?,
      updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
      .bind(
        value.event ?? "account_update",
        "A conta WhatsApp foi removida ou o acesso do app foi revogado na Meta.",
        integration.id,
        integration.organization_id,
      )
      .run()

    return
  }

  if (action === "error") {
    const summary =
      value.event === "ACCOUNT_OFFBOARDED"
        ? "A conta WhatsApp foi desconectada na Meta. Revise a conexão antes de voltar a operar."
        : "A Meta informou uma restrição ou violação na conta WhatsApp. Revise o status no Meta Business."

    await env.DB.prepare(`UPDATE integrations
      SET status='error',error_code=?,error_summary=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND organization_id=?`)
      .bind(
        value.event ?? "account_update",
        summary,
        integration.id,
        integration.organization_id,
      )
      .run()
  }
}

function describeMessage(m: WaMessage) {
  const type = m.type ?? "unknown"

  const unsupportedKinds: Record<string, string> = {
    gif: "GIF",
    group_invite: "convite de grupo",
    poll_creation: "enquete",
    poll_update: "resposta de enquete",
    edit: "edição de mensagem",
    reaction: "reação",
    location: "localização",
    image: "imagem",
    interactive: "mensagem interativa",
    product: "produto",
    order: "pedido",
  }
  const code = m.errors?.[0]?.code
  const errorCode =
    type === "unsupported" &&
    typeof code === "number" &&
    Number.isSafeInteger(code) &&
    code > 0
      ? String(code)
      : null
  const kind =
    errorCode === "131051" && m.unsupported?.type
      ? unsupportedKinds[m.unsupported.type]
      : undefined
  const labels: Record<string, string> = {
    image: "[Imagem]",
    video: "[Vídeo]",
    audio: "[Áudio]",
    document: "[Documento]",
    sticker: "[Figurinha]",
    location: "[Localização]",
    contacts: "[Contato]",
    reaction: "[Reação]",
    errors: "[Mensagem indisponível no histórico]",
    unsupported:
      errorCode === "131060"
        ? "[A Meta não compartilhou o conteúdo desta mensagem com o AV Flow. Abra o WhatsApp Business para lê-la; a Meta não enviará esse conteúdo novamente.]"
      : errorCode === "131051"
          ? `[${
              kind ? `${kind}: tipo` : "Tipo"
            } de mensagem não suportado pela API da Meta. Confira no WhatsApp Business.]`
          : "[A Meta não enviou o conteúdo desta mensagem ao AV Flow. Consulte-a no WhatsApp Business; a Meta pode não reenviá-la.]",
  }

  const formReply = m.interactive?.nfm_reply
  let formReplyBody: string | null = null
  if (formReply) {
    const fields: string[] = []
    if (formReply.response_json) {
      try {
        const response = JSON.parse(formReply.response_json) as unknown
        if (
          response &&
          typeof response === "object" &&
          !Array.isArray(response)
        ) {
          for (const [key, value] of Object.entries(response)) {
            if (
              key.toLowerCase() === "flow_token" ||
              value == null ||
              value === ""
            )
              continue
            const formatted =
              typeof value === "string" ? value : JSON.stringify(value)
            if (formatted) fields.push(`${key}: ${formatted}`)
          }
        }
      } catch (error) {
        console.warn(
          "whatsapp_form_reply_invalid_json",
          m.id,
          error instanceof Error ? error.message : "unknown",
        )
      }
    }

    formReplyBody = [
      `O cliente concluiu um formulário no WhatsApp. Dê continuidade ao atendimento e responda ao interesse demonstrado usando as respostas abaixo.${formReply.name ? ` Formulário: ${formReply.name}.` : ""}`,
      ...fields,
    ].join("\n")
    if (fields.length === 0 && formReply.body?.trim())
      formReplyBody += `\n${formReply.body.trim()}`
  }

  const body =
    (type === "reaction" && m.reaction?.emoji
      ? `Reagiu com ${m.reaction.emoji}`
      : null) ??
    m.text?.body ??
    m.button?.text ??
    m.button?.payload ??
    formReplyBody ??
    m.interactive?.button_reply?.title ??
    m.interactive?.button_reply?.id ??
    m.interactive?.list_reply?.title ??
    m.interactive?.list_reply?.description ??
    m.interactive?.list_reply?.id ??
    [
      labels[type] ?? `[${type}]`,
      m.document?.filename,
      m.image?.caption ?? m.video?.caption ?? m.document?.caption,
    ]
      .filter(Boolean)
      .join(" ")

  return { type, body: body.slice(0, 4096), errorCode }
}

export function isWithinCustomerServiceWindow(
  lastInboundAt: string | null,
  now = Date.now(),
) {
  if (!lastInboundAt) return false
  const timestamp = new Date(lastInboundAt).getTime()
  return (
    Number.isFinite(timestamp) &&
    timestamp <= now &&
    now - timestamp < WINDOW_MS
  )
}

async function latestInboundMessageAt(
  env: Env,
  organizationId: string,
  conversationId: string,
) {
  return env.DB.prepare(
    `SELECT at FROM (
      SELECT COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ',external_created_at),
        strftime('%Y-%m-%dT%H:%M:%fZ',created_at)
      ) at
      FROM messages
      WHERE organization_id=? AND conversation_id=? AND direction='inbound'
      UNION ALL
      SELECT strftime('%Y-%m-%dT%H:%M:%fZ',external_created_at) at
      FROM deleted_whatsapp_messages
      WHERE organization_id=? AND conversation_id=? AND direction='inbound'
    ) WHERE at IS NOT NULL ORDER BY julianday(at) DESC LIMIT 1`,
  )
    .bind(organizationId, conversationId, organizationId, conversationId)
    .first<{ at: string | null }>()
    .then((result) => result?.at ?? null)
}

async function handleInbound(
  env: Env,
  integration: Integration,
  value: WaValue,
  m: WaMessage,
  direction: "inbound" | "outbound" = "inbound",
  countUnread = direction === "inbound",
) {
  const waId = m.from?.replace(/\D/g, "")

  if (!waId || !m.id) throw new Error("mensagem sem remetente ou id")

  const org = integration.organization_id

  const deleted = await env.DB.prepare(
    "SELECT 1 FROM deleted_whatsapp_messages WHERE organization_id=? AND external_id=?",
  )
    .bind(org, m.id)
    .first()
  if (deleted)
    return {
      conversationId: "",
      type: m.type ?? "unknown",
      externalId: m.id,
      inserted: false,
    }

  const duplicate = await env.DB.prepare(
    "SELECT conversation_id FROM messages WHERE organization_id=? AND external_id=?",
  )
    .bind(org, m.id)
    .first<{ conversation_id: string }>()
  if (duplicate)
    return {
      conversationId: duplicate.conversation_id,
      type: m.type ?? "unknown",
      externalId: m.id,
      inserted: false,
    }

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
    .first<{ id: string name: string | null }>()

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

  const { type, body, errorCode } = describeMessage(m)
  const media = m.document ?? m.image ?? m.video ?? m.audio ?? m.sticker
  const mediaFilename = m.document?.filename?.slice(0, 255) ?? null
  const inbound = direction === "inbound"

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
      "INSERT OR IGNORE INTO messages(id,organization_id,conversation_id,external_id,direction,type,body,status,external_created_at,media_id,media_filename,media_mime,error_code) VALUES(?,?,?,?,?,?,?, ?,?,?,?,?,?)",
    )

      .bind(
        uid(),
        org,
        conversationId,
        m.id,
        direction,
        type,
        body,
        inbound ? "received" : "sent",
        at,
        media?.id ?? null,
        mediaFilename,
        media?.mime_type ?? null,
        errorCode,
      ),

    env.DB.prepare(
      "UPDATE conversations SET last_message_at=CASE WHEN last_message_at IS NULL OR last_message_at<? THEN ? ELSE last_message_at END,unread_count=unread_count+?,status='open',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND changes()>0",
    ).bind(at, at, countUnread && inbound ? 1 : 0, conversationId, org),
  )

  const results = await env.DB.batch(batch)

  return {
    conversationId,
    type,
    externalId: m.id,
    inserted: !!results[results.length - 2]?.meta.changes,
  }
}

async function handleMessageEcho(
  env: Env,
  integration: Integration,
  value: WaValue,
  echo: WaMessage,
) {
  if (!echo.to) throw new Error("eco sem destinatário")
  if (echo.type === "edit" || echo.type === "revoke")
    throw new Error(
      "edição ou exclusão de mensagem do WhatsApp Business App ainda não suportada",
    )

  await handleInbound(
    env,
    integration,
    value,
    { ...echo, from: echo.to },
    "outbound",
  )
}

async function handleHistory(
  env: Env,
  integration: Integration,
  value: WaValue,
) {
  const history = value.history ?? []
  const errors = [
    ...(value.errors ?? []),
    ...history.flatMap((item) => item.errors ?? []),
  ]

  if (errors.some((error) => error.code === 2593109)) {
    await env.DB.prepare(`UPDATE integrations
      SET history_sync_status='declined',history_sync_error='O compartilhamento do histórico não foi autorizado no WhatsApp Business App.',updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND organization_id=?`)
      .bind(integration.id, integration.organization_id)
      .run()
    return
  }

  if (errors.length)
    throw new Error("A Meta retornou um erro ao sincronizar o histórico")

  const businessNumber = integration.display_phone_number?.replace(/\D/g, "")

  for (const item of history) {
    for (const thread of item.threads ?? []) {
      const contactNumber = (thread.id ?? thread.context?.wa_id)?.replace(
        /\D/g,
        "",
      )

      if (!contactNumber || !/^\d{5,20}$/.test(contactNumber)) {
        console.warn("whatsapp_history_contact_without_phone")
        continue
      }

      for (const message of thread.messages ?? []) {
        if (!message.id) throw new Error("mensagem histórica sem identificador")

        const from = message.from?.replace(/\D/g, "")
        const direction =
          from && businessNumber && from === businessNumber
            ? "outbound"
            : "inbound"

        await handleInbound(
          env,
          integration,
          value,
          { ...message, from: contactNumber },
          direction,
          false,
        )
      }
    }

    const progress = item.metadata?.progress
    if (typeof progress === "number" && progress >= 0 && progress <= 100) {
      await env.DB.prepare(`UPDATE integrations
        SET history_sync_progress=MAX(history_sync_progress,?),
        history_sync_status=CASE WHEN ?=100 THEN 'completed' ELSE history_sync_status END,
        history_sync_error=NULL,updated_at=CURRENT_TIMESTAMP
        WHERE id=? AND organization_id=?`)
        .bind(progress, progress, integration.id, integration.organization_id)
        .run()
    }
  }
}

async function handleStatus(env: Env, integration: Integration, s: WaStatus) {
  const next = s.status

  if (!s.id || !next) return

  const message = await env.DB.prepare(
    "SELECT id,status FROM messages WHERE organization_id=? AND external_id=? AND direction='outbound'",
  )

    .bind(integration.organization_id, s.id)
    .first<{ id: string status: string }>()

  if (!message) return

  if (next === "failed") {
    const error = s.errors?.[0]
    const errorMessage = metaErrorMessage(
      error,
      "A Meta informou falha na entrega.",
    )
    console.error("whatsapp_message_delivery_failed", {
      code: error?.code ?? null,
      subcode: error?.error_subcode ?? null,
      fbtraceId: error?.fbtrace_id ?? null,
      message: errorMessage,
    })
    await env.DB.prepare(
      "UPDATE messages SET status='failed',error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(
        String(error?.code ?? "unknown"),
        errorMessage,
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
    entry?: Array<{
      id?: string
      time?: number
      changes?: Array<{ field?: string value?: WaValue }>
    }>
  },

  payloadHash: string,
  after: (task: Promise<unknown>) => void = () => {},
) {
  if (payload.object !== "whatsapp_business_account") return

  let processingFailed = false
  for (const entry of payload.entry ?? [])
    for (const [changeIndex, change] of (entry.changes ?? []).entries()) {
      const value = change.value

      if (!value) continue

      const phone = value.metadata?.phone_number_id

      const byPhone = phone
        ? await env.DB.prepare(
            "SELECT id,organization_id,display_phone_number FROM integrations WHERE provider='meta_whatsapp' AND phone_number_id=? AND external_account_id=? AND status='connected'",
          )

            .bind(phone, entry.id ?? "")
            .first<Integration>()
        : null
      const accountIntegrations =
        !phone && change.field === "account_update" && entry.id
          ? await env.DB.prepare(
              "SELECT id,organization_id FROM integrations WHERE provider='meta_whatsapp' AND external_account_id=? AND status IN ('connected','error')",
            )
              .bind(entry.id)
              .all<Integration>()
          : null
      const integrations: Array<Integration | null> = byPhone
        ? [byPhone]
        : accountIntegrations?.results?.length
          ? accountIntegrations.results
          : [null]

      for (const integration of integrations) {
      const items = [
        ...(value.messages ?? []).map((item) => ({
          key: `${item.id}:message`,
          run: async () => {
            const result = await handleInbound(env, integration!, value, item)

              const humanRequest =
                item.interactive?.button_reply?.id === TALK_TO_HUMAN_ID ||
                item.button?.payload === TALK_TO_HUMAN_ID

              if (result.inserted && humanRequest)
              after(
                requestHuman(
                  env,
                  integration!.organization_id,
                  result.conversationId,
                  true,
                ).catch((error) =>
                  console.error(
                    "request_human_failed",
                    error instanceof Error ? error.message : "unknown",
                  ),
                ),
              )

              if (
                result.inserted &&
                (["text", "audio", "image", "button", "interactive"].includes(
                  result.type,
                ) ||
                  (item.type === "unsupported" &&
                    item.errors?.some((error) => error.code === 131060))) &&
                !humanRequest
              )
              after(
                autoReply(
                  env,
                  integration!.organization_id,
                  result.conversationId,
                  result.externalId,
                )
                  .then((classified) =>
                    classified
                      ? undefined
                      : classifyLead(
                          env,
                          integration!.organization_id,
                          result.conversationId,
                          result.externalId,
                        ),
                  )
                  .catch((error) =>
                    console.error(
                      "ai_reply_failed",
                      error instanceof Error ? error.message : "unknown",
                    ),
                  ),
              )
          },
        })),

        ...(change.field === "smb_message_echoes"
          ? (value.message_echoes ?? []).map((item) => ({
              key: `${item.id}:echo`,
              run: () => handleMessageEcho(env, integration!, value, item),
            }))
          : []),

        ...(value.statuses ?? []).map((item) => ({
          key: `${item.id}:${item.status}`,
          run: () => handleStatus(env, integration!, item),
        })),
        ...(change.field === "history"
            ? [
                {
              key: `${change.field}:${entry.id ?? "unknown"}:${changeIndex}:${payloadHash}`,
              run: () => handleHistory(env, integration!, value),
                },
              ]
          : []),
        ...(["smb_app_state_sync"].includes(change.field ?? "")
            ? [
                {
              key: `${change.field}:${entry.id ?? "unknown"}:${changeIndex}:${payloadHash}`,
              run: async () => {
                    throw new Error(
                      `O processamento de ${change.field} ainda não está disponível`,
                    )
                  },
              },
              ]
          : []),
        ...(change.field === "account_update" && entry.id
          ? [
              {
                key: `account_update:${entry.id}:${value.event ?? "unknown"}:${entry.time ?? "unknown"}:${changeIndex}:${payloadHash}`,
                run: () => handleAccountUpdate(env, integration!, value),
              },
            ]
          : []),
      ]

      for (const item of items) {
        const eventId = uid()

        const inserted =
          await env.DB.prepare(`INSERT INTO webhook_events(id,provider,external_event_id,phone_number_id,organization_id,payload_hash,status)
        VALUES(?,'meta_whatsapp',?,?,?,?,?)
        ON CONFLICT(provider,external_event_id) DO UPDATE SET status='received',error_summary=NULL,received_at=CURRENT_TIMESTAMP
        WHERE excluded.organization_id IS NOT NULL AND
          (webhook_events.status='failed' OR
          (webhook_events.status='received' AND webhook_events.received_at<datetime('now','-5 minutes')))`)
            .bind(
              eventId,
              `${integration?.id ?? "unmatched"}:${item.key}`,
              phone ?? null,
              integration?.organization_id ?? null,
              payloadHash,
              integration ? "received" : "ignored",
            )
            .run()

        if (!inserted.meta.changes || !integration) continue

        const event = await env.DB.prepare(
          "SELECT id FROM webhook_events WHERE provider='meta_whatsapp' AND external_event_id=?",
          )
            .bind(`${integration.id}:${item.key}`)
            .first<{ id: string }>()
          if (!event)
            throw new Error("Evento de webhook não encontrado após registro")

        try {
          await item.run()

          await env.DB.prepare(
            "UPDATE webhook_events SET status='processed',processed_at=CURRENT_TIMESTAMP WHERE id=?",
          )
            .bind(event.id)
            .run()
        } catch (error) {
          console.error(
            "webhook_item_failed",
            error instanceof Error ? error.message : "unknown",
          )

          if (change.field === "history")
            await env.DB.prepare(`UPDATE integrations
              SET history_sync_status='failed',history_sync_error='A Meta enviou histórico que não pôde ser processado.',updated_at=CURRENT_TIMESTAMP
              WHERE id=? AND organization_id=?`)
              .bind(integration!.id, integration!.organization_id)
              .run()

          await env.DB.prepare(
            "UPDATE webhook_events SET status='failed',error_summary=? WHERE id=?",
          )

            .bind(
              error instanceof Error
                ? error.message.slice(0, 200)
                : "erro desconhecido",
              event.id,
            )
            .run()
          processingFailed = true
        }
      }
      }
    }
  if (processingFailed)
    throw new Error(
      "Falha ao processar eventos do WhatsApp; reenvio necessário",
    )
}

async function connect(
  env: Env,
  auth: Session,
  body: {
    phoneNumberId?: string
    wabaId?: string
    accessToken?: string
    connectionMode?: "cloud_api" | "coexistence"
  },
) {
  const phoneNumberId = body.phoneNumberId?.trim(),
    wabaId = body.wabaId?.trim(),
    token = body.accessToken?.trim(),
    connectionMode = body.connectionMode ?? "cloud_api"

  if (connectionMode !== "cloud_api" && connectionMode !== "coexistence")
    return json({ error: "Modo de conexão inválido." }, 400)

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
    .first<{ id: string organization_id: string }>()

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
    await env.DB.prepare(`UPDATE integrations SET status='connected',external_account_id=?,display_phone_number=?,access_token_enc=?,connection_mode=?,error_code=NULL,error_summary=NULL,
      connected_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`)
      .bind(
        wabaId,
        display,
        encrypted,
        connectionMode,
        integrationId,
        auth.organizationId,
      )
      .run()
  } else {
    await env.DB.prepare(`INSERT INTO integrations(id,organization_id,provider,status,external_account_id,phone_number_id,display_phone_number,access_token_enc,connection_mode,connected_at)
      VALUES(?,?,'meta_whatsapp','connected',?,?,?,?,?,CURRENT_TIMESTAMP)`)
      .bind(
        integrationId,
        auth.organizationId,
        wabaId,
        phoneNumberId,
        display,
        encrypted,
        connectionMode,
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

  let subscription: GraphResult | null = null
  try {
    subscription = await graphFetch(env, `${wabaId}/subscribed_apps`, token, {})
  } catch (error) {
    console.error(
      "whatsapp_subscription_failed",
      error instanceof Error ? error.message : "unknown",
    )
  }
  const subscribed = !!subscription?.ok && subscription.data.success === true
  const subscribeError =
    subscription && !subscription.ok
    ? graphMessage(subscription)
    : "A Meta não confirmou a assinatura do webhook. Verifique a conexão e tente novamente."

  if (!subscribed)
    await env.DB.prepare(
      "UPDATE integrations SET status='error',error_code='webhook_subscription',error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(subscribeError, integrationId, auth.organizationId)
      .run()

  return json({
    ok: true,
    displayPhoneNumber: display,
    verifiedName,
    subscribed,
    subscribeError: subscribed ? undefined : subscribeError,
  })
}

async function connectWithEmbeddedSignup(
  env: Env,
  auth: Session,
  body: {
    code?: string
    phoneNumberId?: string
    wabaId?: string
    connectionMode?: "cloud_api" | "coexistence"
  },
) {
  const code = body.code?.trim()

  let phoneNumberId = body.phoneNumberId?.trim()

  const wabaId = body.wabaId?.trim()
  const connectionMode = body.connectionMode ?? "cloud_api"

  if (connectionMode !== "cloud_api" && connectionMode !== "coexistence")
    return json({ error: "Modo de conexão inválido." }, 400)

  if (!code || code.length > 4096 || /\s/.test(code))
    return json(
      { error: "Código de autorização inválido. Inicie o cadastro novamente." },
      400,
    )

  if (
    (connectionMode === "cloud_api" &&
      (!phoneNumberId || !/^\d{5,25}$/.test(phoneNumberId))) ||
    !wabaId ||
    !/^\d{5,25}$/.test(wabaId)
  )
    return json(
      {
        error:
          "A Meta não retornou os identificadores necessários. Inicie o cadastro novamente.",
      },
      400,
    )

  if (
    connectionMode === "coexistence" &&
    !env.META_COEXISTENCE_CONFIG_ID &&
    !env.META_CONFIG_ID
  )
    return json(
      {
        error:
          "A configuração de coexistência da Meta ainda não está definida.",
      },
      503,
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

    error?: { message?: string error_user_msg?: string }
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

  if (connectionMode === "coexistence") {
    const numbers = await graphFetch(
      env,
      `${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`,
      result.access_token,
    ).catch(() => null)

    if (!numbers)
      return json(
        {
          error:
            "Não foi possível consultar os números da conta WhatsApp na Meta. Tente novamente.",
        },
        502,
      )

    if (!numbers.ok)
      return json(
        {
          error: `Não foi possível localizar o número na conta WhatsApp: ${graphMessage(numbers)}`,
        },
        400,
      )

    const phoneNumbers = numbers.data.data as Array<{
      id?: string
      display_phone_number?: string
      verified_name?: string
    }> | undefined
    const paging = numbers.data.paging as { next?: string } | undefined

    if (!Array.isArray(phoneNumbers))
      return json(
        { error: "A Meta retornou uma lista de números inválida." },
        502,
      )

    if (phoneNumberId) {
      if (!/^\d{5,25}$/.test(phoneNumberId))
        return json(
          { error: "A Meta retornou um identificador de número inválido." },
          400,
        )
      if (!phoneNumbers.some((number) => number.id === phoneNumberId))
        return json(
          {
            error:
              "Não foi possível confirmar que o número pertence à conta WhatsApp selecionada.",
          },
          400,
        )
    } else if (paging?.next)
      return json(
        {
          error:
            "A conta possui mais números do que o limite suportado. Contate o suporte para concluir a conexão.",
        },
        400,
      )
    else if (phoneNumbers.length > 1) {
      if (
        phoneNumbers.some(
          (number) => !number.id || !/^\d{5,25}$/.test(number.id),
        )
      )
        return json(
          { error: "A Meta retornou identificadores de número inválidos." },
          502,
        )
      const pendingId = uid()
      await env.DB.prepare(
        "DELETE FROM whatsapp_pending_signups WHERE organization_id=? AND (user_id=? OR expires_at<=CURRENT_TIMESTAMP)",
      )
        .bind(auth.organizationId, auth.userId)
        .run()
      await env.DB.prepare(
        "INSERT INTO whatsapp_pending_signups(id,organization_id,user_id,waba_id,access_token_enc,expires_at) VALUES(?,?,?,?,?,datetime('now','+15 minutes'))",
      )
        .bind(
          pendingId,
          auth.organizationId,
          auth.userId,
          wabaId,
          await encryptToken(env, result.access_token),
        )
        .run()
      return json({
        selectionRequired: true,
        pendingId,
        phoneNumbers: phoneNumbers.map((number) => ({
          id: number.id,
          displayPhoneNumber: number.display_phone_number ?? number.id,
          verifiedName: number.verified_name ?? null,
        })),
      })
    } else if (!phoneNumbers[0]?.id) {
      return json(
        { error: "A Meta não retornou um número para esta conta WhatsApp." },
        400,
      )
    } else phoneNumberId = phoneNumbers[0].id
  }

  return connect(env, auth, {
    phoneNumberId,
    wabaId,
    accessToken: result.access_token,
    connectionMode,
  })
}

async function selectSignupNumber(
  env: Env,
  auth: Session,
  body: { pendingId?: string phoneNumberId?: string },
) {
  if (
    !body.pendingId ||
    !/^[0-9a-f-]{36}$/i.test(body.pendingId) ||
    !body.phoneNumberId ||
    !/^\d{5,25}$/.test(body.phoneNumberId)
  )
    return json({ error: "Seleção de número inválida." }, 400)

  const pending = await env.DB.prepare(
    "SELECT waba_id,access_token_enc FROM whatsapp_pending_signups WHERE id=? AND organization_id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP",
  )
    .bind(body.pendingId, auth.organizationId, auth.userId)
    .first<{ waba_id: string access_token_enc: string }>()
  if (!pending)
    return json(
      {
        error:
          "A seleção expirou ou não pertence à sua sessão. Inicie novamente o cadastro.",
      },
      404,
    )

  const token = await decryptToken(env, pending.access_token_enc)
  let numbers: GraphResult
  try {
    numbers = await graphFetch(
      env,
      `${pending.waba_id}/phone_numbers?fields=id&limit=100`,
      token,
    )
  } catch {
    return json(
      {
        error:
          "Não foi possível consultar os números na Meta. Tente novamente.",
      },
      502,
    )
  }
  if (!numbers.ok)
    return json(
      { error: `Não foi possível validar o número: ${graphMessage(numbers)}` },
      400,
    )
  const data = numbers.data.data
  if (
    !Array.isArray(data) ||
    !data.some((item: { id?: string }) => item.id === body.phoneNumberId)
  )
    return json(
      {
        error: "O número selecionado não pertence à conta WhatsApp autorizada.",
      },
      400,
    )

  const response = await connect(env, auth, {
    phoneNumberId: body.phoneNumberId,
    wabaId: pending.waba_id,
    accessToken: token,
    connectionMode: "coexistence",
  })
  if (response.ok)
    await env.DB.prepare(
      "DELETE FROM whatsapp_pending_signups WHERE id=? AND organization_id=? AND user_id=?",
    )
      .bind(body.pendingId, auth.organizationId, auth.userId)
      .run()
  return response
}

async function requestHistorySync(env: Env, auth: Session) {
  const integration =
    await env.DB.prepare(`SELECT id,phone_number_id phoneNumberId,
    access_token_enc accessTokenEnc,connection_mode connectionMode,connected_at connectedAt,
    history_sync_status historySyncStatus,
    CASE WHEN connected_at>=datetime('now','-24 hours') THEN 1 ELSE 0 END canSyncHistory
    FROM integrations WHERE organization_id=? AND provider='meta_whatsapp' AND status='connected'
    ORDER BY created_at DESC LIMIT 1`)
    .bind(auth.organizationId)
    .first<{
      id: string
      phoneNumberId: string
      accessTokenEnc: string
      connectionMode: string
      connectedAt: string | null
      historySyncStatus: string
      canSyncHistory: number
    }>()

  if (!integration)
    return json(
      { error: "Nenhuma conexão ativa do WhatsApp foi encontrada." },
      404,
    )

  if (integration.connectionMode !== "coexistence")
    return json(
      {
        error:
          "A importação de histórico só está disponível no modo de coexistência.",
      },
      409,
    )

  if (!integration.canSyncHistory)
    return json(
      {
        error:
          "O prazo de 24 horas para solicitar o histórico expirou. Será necessário refazer a conexão pela coexistência na Meta.",
      },
      409,
    )

  if (integration.historySyncStatus !== "not_started")
    return json(
      {
        error:
          "A solicitação de histórico já foi iniciada e não pode ser repetida.",
      },
      409,
    )

  const started = await env.DB.prepare(`UPDATE integrations
    SET history_sync_status='requesting',history_sync_requested_at=CURRENT_TIMESTAMP,
    history_sync_error=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND organization_id=? AND status='connected' AND history_sync_status='not_started'`)
    .bind(integration.id, auth.organizationId)
    .run()

  if (!started.meta.changes)
    return json(
      {
        error:
          "A solicitação de histórico já foi iniciada e não pode ser repetida.",
      },
      409,
    )

  await env.DB.prepare(
    "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,?,'integration.history_sync_requested','integration',?)",
  )
    .bind(uid(), auth.organizationId, auth.userId, integration.id)
    .run()

  let result: GraphResult
  try {
    result = await graphFetch(
      env,
      `${integration.phoneNumberId}/smb_app_data`,
      await decryptToken(env, integration.accessTokenEnc),
      { messaging_product: "whatsapp", sync_type: "history" },
    )
  } catch (error) {
    console.error(
      "whatsapp_history_sync_failed",
      error instanceof Error ? error.message : "unknown",
    )
    await env.DB.prepare(`UPDATE integrations
      SET history_sync_status='failed',history_sync_error='Não foi possível confirmar a solicitação com a Meta.',updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND organization_id=? AND history_sync_status='requesting'`)
      .bind(integration.id, auth.organizationId)
      .run()
    return json(
      {
        error:
          "Não foi possível confirmar a solicitação com a Meta. Por segurança, ela não pode ser repetida.",
      },
      502,
    )
  }

  const requestId =
    typeof result.data.request_id === "string" && result.data.request_id
      ? result.data.request_id
      : null
  if (!result.ok || !requestId) {
    const message = result.ok
      ? "A Meta não confirmou o identificador da solicitação."
      : graphMessage(result)
    await env.DB.prepare(`UPDATE integrations
      SET history_sync_status='failed',history_sync_error=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND organization_id=? AND history_sync_status='requesting'`)
      .bind(message.slice(0, 200), integration.id, auth.organizationId)
      .run()
    return json(
      { error: `A Meta não aceitou a sincronização: ${message}` },
      502,
    )
  }

  await env.DB.prepare(`UPDATE integrations
    SET history_sync_status=CASE WHEN history_sync_status='completed' THEN 'completed' ELSE 'requested' END,
    history_sync_request_id=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND organization_id=?`)
    .bind(requestId, integration.id, auth.organizationId)
    .run()

  return json({ ok: true, requestId })
}

async function downloadMedia(
  env: Env,
  auth: Session,
  messageId: string,
  inline = false,
  range: string | null = null,
) {
  const row = await env.DB.prepare(
    `SELECT m.media_id mediaId,m.media_filename filename,m.media_mime mime,m.type,i.access_token_enc token
    FROM messages m JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id
    JOIN integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id
    WHERE m.id=? AND m.organization_id=?`,
  )
    .bind(messageId, auth.organizationId)
    .first<{
      mediaId: string | null
      filename: string | null
      mime: string | null
      type: string
      token: string | null
    }>()

  if (!row?.mediaId) return json({ error: "Arquivo não encontrado." }, 404)

  if (!row.token)
    return json({ error: "WhatsApp desconectado. Reconecte para baixar." }, 409)

  const token = await decryptToken(env, row.token)
  const meta = await graphFetch(env, row.mediaId, token)
  const url = typeof meta.data.url === "string" ? meta.data.url : null

  if (!meta.ok || !url)
    return json(
      {
        error:
          "Não foi possível obter o arquivo. A Meta mantém mídias por 30 dias.",
      },
      502,
    )

  const file = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(inline && range ? { range } : {}),
    },
  })

  if (!file.ok || !file.body)
    return json({ error: "Não foi possível baixar o arquivo da Meta." }, 502)

  const mime =
    row.mime ?? file.headers.get("content-type") ?? "application/octet-stream"
  const ext = mime.split("/")[1]?.split(";")[0]?.replace(/[^\w]/g, "") || "bin"
  const name = (
    row.filename ?? `${row.type}-${messageId.slice(0, 8)}.${ext}`
  ).replace(/[\r\n"\\/]/g, "_")

  const showInline =
    inline &&
    /^(image\/(jpeg|png|webp|gif)|audio\/(ogg|mpeg|mp4|aac|webm)|video\/(mp4|webm))$/.test(
      mime.split(";")[0]!.trim(),
    )

  const headers: Record<string, string> = {
    "content-type": mime,
    "content-disposition": `${
      showInline ? "inline" : "attachment"
    }; filename="${name.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=3600",
    "accept-ranges": "bytes",
  }

  for (const key of ["content-range", "content-length"]) {
    const value = file.headers.get(key)
    if (value) headers[key] = value
  }

  return new Response(file.body, { status: file.status, headers })
}

export async function fetchInboundMessageMedia(
  env: Env,
  organizationId: string,
  conversationId: string,
  externalId: string,
) {
  const row = await env.DB.prepare(
    `SELECT m.media_id mediaId,m.media_mime mime,i.access_token_enc token
     FROM messages m
     JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id
     JOIN integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id
     WHERE m.organization_id=? AND m.conversation_id=? AND m.external_id=? AND m.direction='inbound'`,
  )
    .bind(organizationId, conversationId, externalId)
    .first<{
    mediaId: string | null
    mime: string | null
    token: string | null
  }>()

  if (!row?.mediaId)
    throw new Error("A mídia recebida não está disponível no WhatsApp.")
  if (!row.token)
    throw new Error("A integração do WhatsApp não tem token ativo.")

  const token = await decryptToken(env, row.token)
  const meta = await graphFetch(env, row.mediaId, token)
  const url = typeof meta.data.url === "string" ? meta.data.url : null
  if (!meta.ok || !url)
    throw new Error("A Meta não disponibilizou a mídia recebida.")

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!response.ok || !response.body)
    throw new Error("Não foi possível baixar a mídia da Meta.")

  const contentLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(contentLength) && contentLength > INBOUND_MEDIA_LIMIT) {
    await response.body.cancel()
    throw new Error("A mídia excede o limite de processamento de 16 MB.")
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > INBOUND_MEDIA_LIMIT) {
        await reader.cancel()
        throw new Error("A mídia excede o limite de processamento de 16 MB.")
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return {
    bytes,
    mime: (row.mime ?? response.headers.get("content-type") ?? "")
      .split(";")[0]!
      .trim()
      .toLowerCase(),
  }
}

const MEDIA_LIMITS: Record<string, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 25 * 1024 * 1024,
}

function mediaKind(mime: string) {
  if (/^image\/(jpeg|png)$/.test(mime)) return "image"
  if (/^video\/(mp4|3gpp)$/.test(mime)) return "video"
  if (/^audio\/(aac|mp4|mpeg|amr|ogg)$/.test(mime)) return "audio"
  return "document"
}

async function aiAssignmentValid(
  env: Env,
  organizationId: string,
  conversationId: string,
  revision: number | undefined,
) {
  if (revision === undefined) return true
  const row = await env.DB.prepare(
    "SELECT 1 FROM conversations WHERE id=? AND organization_id=? AND assigned_to IS NULL AND assignment_revision=?",
  )
    .bind(conversationId, organizationId, revision)
    .first()
  return !!row
}

async function sendAttachment(
  env: Env,
  auth: Session,
  conversationId: string,
  request: Request,
) {
  const form = await request.formData().catch(() => null)
  const file = form?.get("file")
  const caption = String(form?.get("caption") ?? "")
    .trim()
    .slice(0, 1024)

  return sendFile(env, auth, conversationId, file, caption)
}

export async function sendFile(
  env: Env,
  auth: Session,
  conversationId: string,
  file: unknown,
  caption: string,
  assignmentRevision?: number,
) {
  if (
    !(await aiAssignmentValid(
      env,
      auth.organizationId,
      conversationId,
      assignmentRevision,
    ))
  )
    return json({ error: "A conversa foi atribuída a outra pessoa." }, 409)
  if (!(file instanceof File) || file.size === 0)
    return json({ error: "Selecione um arquivo." }, 400)

  const mime = (file.type || "application/octet-stream").split(";")[0]!.trim()
  const kind = mediaKind(mime)

  if (file.size > MEDIA_LIMITS[kind]!)
    return json(
      {
        error: `Arquivo muito grande. O limite para ${
          kind === "image" ? "imagens" : "este tipo"
        } é ${MEDIA_LIMITS[kind]! / 1024 / 1024} MB.`,
      },
      413,
    )

  const conversation = await env.DB.prepare(
    `SELECT ct.phone_e164 phone,i.phone_number_id phoneNumberId,i.access_token_enc token,i.status integrationStatus,i.id integrationId
    FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
    JOIN integrations i ON i.id=c.integration_id AND i.organization_id=c.organization_id
    WHERE c.id=? AND c.organization_id=?`,
  )
    .bind(conversationId, auth.organizationId)
    .first<{
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

  const lastInboundAt = await latestInboundMessageAt(
    env,
    auth.organizationId,
    conversationId,
  )

  if (!isWithinCustomerServiceWindow(lastInboundAt))
    return json(
      {
        error:
          "A janela de 24 horas se encerrou. O cliente precisa enviar uma nova mensagem.",
      },
      422,
    )

  const messageId = uid()
  const filename = (
    file.name || `arquivo.${mime.split("/")[1] ?? "bin"}`
  ).slice(0, 255)
  const label = {
    image: "[Imagem]",
    video: "[Vídeo]",
    audio: "[Áudio]",
    document: filename,
  }[kind]!

  await env.DB.prepare(
    "INSERT INTO messages(id,organization_id,conversation_id,direction,type,body,status,sent_by,media_filename,media_mime,is_ai) VALUES(?,?,?,'outbound',?,?,'queued',?,?,?,?)",
  )
    .bind(
      messageId,
      auth.organizationId,
      conversationId,
      kind,
      caption && kind !== "audio" ? `${label}\n${caption}`.trim() : label,
      auth.userId || null,
      kind === "document" ? filename : null,
      mime,
      auth.role === "ai" ? 1 : 0,
    )
    .run()

  const fail = async (code: string, message: string, status = 502) => {
    await env.DB.prepare(
      "UPDATE messages SET status='failed',error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(code, message.slice(0, 1000), messageId, auth.organizationId)
      .run()

    return json({ error: message, messageId }, status)
  }

  let result: GraphResult

  try {
    const token = await decryptToken(env, conversation.token)
    const base = `${env.GRAPH_API_BASE ?? "https://graph.facebook.com"}/${GRAPH_VERSION}`

    const upload = new FormData()
    upload.set("messaging_product", "whatsapp")
    upload.set("type", mime)
    upload.set("file", file, filename)

    const uploaded = await fetch(
      `${base}/${conversation.phoneNumberId}/media`,
      {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: upload,
      },
    )
    const uploadData = (await uploaded.json().catch(() => ({}))) as {
      id?: string
      error?: MetaApiError
    }

    if (!uploaded.ok || !uploadData.id) {
      const errorMessage = metaErrorMessage(
        uploadData.error,
        `HTTP ${uploaded.status}`,
      )
      console.error("whatsapp_media_upload_api_error", {
        httpStatus: uploaded.status,
        code: uploadData.error?.code ?? null,
        subcode: uploadData.error?.error_subcode ?? null,
        fbtraceId: uploadData.error?.fbtrace_id ?? null,
        message: errorMessage,
      })
      return fail(
        String(uploadData.error?.code ?? uploaded.status),
        `A Meta recusou o arquivo: ${errorMessage}`,
      )
    }

    await env.DB.prepare(
      "UPDATE messages SET media_id=? WHERE id=? AND organization_id=?",
    )
      .bind(uploadData.id, messageId, auth.organizationId)
      .run()

    const media: Record<string, string> = { id: uploadData.id }
    if (caption && kind !== "audio") media.caption = caption
    if (kind === "document") media.filename = filename

    if (
      !(await aiAssignmentValid(
        env,
        auth.organizationId,
        conversationId,
        assignmentRevision,
      ))
    )
      return fail(
        "assignment_changed",
        "A conversa foi atribuída a outra pessoa.",
        409,
      )

    result = await graphFetch(
      env,
      `${conversation.phoneNumberId}/messages`,
      token,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: conversation.phone.replace(/\D/g, ""),
        type: kind,
        [kind]: media,
      },
    )
  } catch (error) {
    console.error(
      "send_attachment_failed",
      error instanceof Error ? error.message : "unknown",
    )

    return fail("network", "Não foi possível enviar agora. Tente novamente.")
  }

  if (!result.ok) {
    logMetaApiError("whatsapp_send_media_api_error", result)
    return fail(
      String(result.data.error?.code ?? result.status),
      `A Meta recusou o envio: ${graphMessage(result)}`,
    )
  }

  const externalId =
    (result.data.messages as Array<{ id?: string }> | undefined)?.[0]?.id ??
    null

  const missingExternalId = !externalId
  if (missingExternalId)
    console.error("whatsapp_send_media_missing_message_id", {
      httpStatus: result.status,
      messageId,
    })

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET status='accepted',external_id=?,error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(
      externalId,
      missingExternalId ? "missing_message_id" : null,
      missingExternalId
        ? "A Meta aceitou a solicitação, mas não retornou o ID da mensagem. O envio não será repetido automaticamente."
        : null,
      messageId,
      auth.organizationId,
    ),

    env.DB.prepare(
      "UPDATE conversations SET last_message_at=?,human_requested_at=CASE WHEN ? THEN NULL ELSE human_requested_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(
      new Date().toISOString(),
      auth.role === "ai" ? 0 : 1,
      conversationId,
      auth.organizationId,
    ),
  ])

  return json({ ok: true, messageId }, 201)
}

export async function sendText(
  env: Env,
  auth: Session,
  conversationId: string,
  text: unknown,
  options: { talkButton?: boolean assignmentRevision?: number } = {},
) {
  if (
    !(await aiAssignmentValid(
      env,
      auth.organizationId,
      conversationId,
      options.assignmentRevision,
    ))
  )
    return json({ error: "A conversa foi atribuída a outra pessoa." }, 409)
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

  const lastInboundAt = await latestInboundMessageAt(
    env,
    auth.organizationId,
    conversationId,
  )

  if (!isWithinCustomerServiceWindow(lastInboundAt))
    return json(
      {
        error:
          "A janela de 24 horas se encerrou. Só é possível reiniciar a conversa com um modelo aprovado pela Meta (ainda não disponível aqui).",
      },
      422,
    )

  const messageId = uid()

  await env.DB.prepare(
    "INSERT INTO messages(id,organization_id,conversation_id,direction,type,body,status,sent_by,is_ai) VALUES(?,?,?,'outbound','text',?,'queued',?,?)",
  )

    .bind(
      messageId,
      auth.organizationId,
      conversationId,
      body,
      auth.userId || null,
      auth.role === "ai" ? 1 : 0,
    )
    .run()

  const fail = async (code: string, message: string, status = 502) => {
    await env.DB.prepare(
      "UPDATE messages SET status='failed',error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(code, message.slice(0, 1000), messageId, auth.organizationId)
      .run()

    return json({ error: message, messageId }, status)
  }

  let result: GraphResult

  try {
    const token = await decryptToken(env, conversation.token)

    if (
      !(await aiAssignmentValid(
        env,
        auth.organizationId,
        conversationId,
        options.assignmentRevision,
      ))
    )
      return fail(
        "assignment_changed",
        "A conversa foi atribuída a outra pessoa.",
        409,
      )

    result = await graphFetch(
      env,
      `${conversation.phoneNumberId}/messages`,
      token,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: conversation.phone.replace(/\D/g, ""),
        ...(options.talkButton && body.length <= 1024
          ? {
              type: "interactive",
              interactive: {
                type: "button",
                body: { text: body },
                action: {
                  buttons: [
                    {
                      type: "reply",
                      reply: {
                        id: TALK_TO_HUMAN_ID,
                        title: "Falar com vendedor",
                      },
                    },
                  ],
                },
              },
            }
          : { type: "text", text: { body, preview_url: false } }),
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
    logMetaApiError("whatsapp_send_text_api_error", result)
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
  const missingExternalId = !externalId

  if (missingExternalId)
    console.error("whatsapp_send_text_missing_message_id", {
      httpStatus: result.status,
      messageId,
    })

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE messages SET status='accepted',external_id=?,error_code=?,error_message=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(
      externalId,
      missingExternalId ? "missing_message_id" : null,
      missingExternalId
        ? "A Meta aceitou a solicitação, mas não retornou o ID da mensagem. O envio não será repetido automaticamente."
        : null,
      messageId,
      auth.organizationId,
    ),

    env.DB.prepare(
      "UPDATE conversations SET last_message_at=?,human_requested_at=CASE WHEN ? THEN NULL ELSE human_requested_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(
      new Date().toISOString(),
      auth.role === "ai" ? 0 : 1,
      conversationId,
      auth.organizationId,
    ),
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
    path === "/api/integrations/whatsapp/embedded-signup" ||
    path === "/api/integrations/whatsapp/embedded-signup/select-number" ||
    path === "/api/integrations/whatsapp/history-sync"
  ) {
    if (path === "/api/integrations/whatsapp" && request.method === "GET") {
      await env.DB.prepare(
        "DELETE FROM whatsapp_pending_signups WHERE organization_id=? AND expires_at<=CURRENT_TIMESTAMP",
      )
        .bind(org)
        .run()
      const integration =
        await env.DB.prepare(`SELECT status,phone_number_id phoneNumberId,display_phone_number displayPhoneNumber,connection_mode connectionMode,error_summary errorSummary,connected_at connectedAt,
        history_sync_status historySyncStatus,history_sync_progress historySyncProgress,history_sync_error historySyncError,
        history_sync_requested_at historySyncRequestedAt,
        CASE WHEN connected_at>=datetime('now','-24 hours') THEN 1 ELSE 0 END historySyncAvailable
        FROM integrations WHERE organization_id=? AND provider='meta_whatsapp' AND status!='disconnected' ORDER BY created_at DESC LIMIT 1`)
          .bind(org)
          .first()

      return json({
        integration: integration ?? null,

        webhookUrl: `${new URL(env.APP_ORIGIN).origin}/api/webhooks/meta`,

        embeddedSignup: {
          appId: env.META_APP_ID ?? null,
          configId: env.META_CONFIG_ID ?? null,
          coexistenceConfigId:
            env.META_COEXISTENCE_CONFIG_ID ?? env.META_CONFIG_ID ?? null,
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
      path === "/api/integrations/whatsapp/history-sync" &&
      request.method === "POST"
    )
      return requestHistorySync(env, auth)

    if (
      path === "/api/integrations/whatsapp/embedded-signup" &&
      request.method === "POST"
    )
      return connectWithEmbeddedSignup(
        env,
        auth,
        (await request.json()) as {
          code?: string
          phoneNumberId?: string
          wabaId?: string
          connectionMode?: "cloud_api" | "coexistence"
        },
      )

    if (
      path === "/api/integrations/whatsapp/embedded-signup/select-number" &&
      request.method === "POST"
    )
      return selectSignupNumber(env, auth, await request.json())

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
      await env.DB.prepare(`SELECT c.id,c.unread_count unread,c.last_message_at lastMessageAt,c.human_requested_at humanRequestedAt,c.assigned_to assignedTo,ct.name,ct.phone_e164 phone,
      (SELECT ${effectiveLeadStatus("l")} FROM leads l WHERE l.contact_id=ct.id AND l.organization_id=c.organization_id LIMIT 1) leadStatus,
      (SELECT m.body FROM messages m WHERE m.conversation_id=c.id AND m.organization_id=c.organization_id ORDER BY COALESCE(m.external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',m.created_at)) DESC,m.rowid DESC LIMIT 1) preview,
      (SELECT m.type FROM messages m WHERE m.conversation_id=c.id AND m.organization_id=c.organization_id ORDER BY COALESCE(m.external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',m.created_at)) DESC,m.rowid DESC LIMIT 1) previewType
      FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
      WHERE c.organization_id=? ORDER BY (c.human_requested_at IS NOT NULL) DESC,c.last_message_at DESC LIMIT 200`)
        .bind(org)
        .all(),
    )
  }

  const mediaMatch = path.match(/^\/api\/messages\/([\w-]+)\/media$/)

  if (mediaMatch && request.method === "GET")
    return downloadMedia(
      env,
      auth,
      mediaMatch[1]!,
      new URL(request.url).searchParams.get("inline") === "1",
      request.headers.get("range"),
    )

  const messageDelete = path.match(/^\/api\/messages\/([\w-]+)$/)
  if (messageDelete && request.method === "DELETE") {
    if (auth.role !== "admin")
      return json(
        { error: "Apenas administradores podem excluir mensagens." },
        403,
      )
    const message = await env.DB.prepare(
      "SELECT conversation_id conversationId,status FROM messages WHERE id=? AND organization_id=?",
    )
      .bind(messageDelete[1], org)
      .first<{ conversationId: string status: string }>()
    if (!message) return json({ error: "Mensagem não encontrada." }, 404)
    if (message.status === "queued")
      return json(
        { error: "Aguarde o envio da mensagem antes de excluí-la." },
        409,
      )
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO deleted_whatsapp_messages(organization_id,external_id,conversation_id,direction,external_created_at)
         SELECT organization_id,external_id,conversation_id,direction,external_created_at FROM messages WHERE id=? AND organization_id=? AND external_id IS NOT NULL`,
      ).bind(messageDelete[1], org),
      env.DB.prepare(
        "DELETE FROM messages WHERE id=? AND organization_id=?",
      ).bind(messageDelete[1], org),
      env.DB.prepare(
        `UPDATE conversations SET last_message_at=(SELECT MAX(COALESCE(external_created_at,created_at)) FROM messages WHERE conversation_id=? AND organization_id=?),
         unread_count=MIN(unread_count,(SELECT COUNT(*) FROM messages WHERE conversation_id=? AND organization_id=? AND direction='inbound')),
         updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
      ).bind(
        message.conversationId,
        org,
        message.conversationId,
        org,
        message.conversationId,
        org,
      ),
      env.DB.prepare(
        "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,?,'message.deleted','message',?)",
      ).bind(uid(), org, auth.userId, messageDelete[1]),
    ])
    return json({ ok: true })
  }

  const conversationDelete = path.match(/^\/api\/conversations\/([\w-]+)$/)
  if (conversationDelete && request.method === "DELETE") {
    if (auth.role !== "admin")
      return json(
        { error: "Apenas administradores podem excluir conversas." },
        403,
      )
    const conversation = await env.DB.prepare(
      `SELECT c.id, EXISTS(SELECT 1 FROM messages m WHERE m.organization_id=c.organization_id AND m.conversation_id=c.id AND m.status='queued') queued,
       (c.ai_reply_lock IS NOT NULL AND c.ai_reply_lock_until>CURRENT_TIMESTAMP) aiBusy
       FROM conversations c WHERE c.id=? AND c.organization_id=?`,
    )
      .bind(conversationDelete[1], org)
      .first<{ id: string queued: number aiBusy: number }>()
    if (!conversation) return json({ error: "Conversa não encontrada." }, 404)
    if (conversation.queued || conversation.aiBusy)
      return json(
        {
          error:
            "Aguarde o término do envio ou da resposta da IA antes de excluir.",
        },
        409,
      )
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO deleted_whatsapp_messages(organization_id,external_id,conversation_id,direction,external_created_at)
         SELECT organization_id,external_id,conversation_id,direction,external_created_at FROM messages
         WHERE organization_id=? AND conversation_id=? AND external_id IS NOT NULL`,
      ).bind(org, conversationDelete[1]),
      env.DB.prepare(
        "DELETE FROM conversations WHERE id=? AND organization_id=?",
      ).bind(conversationDelete[1], org),
      env.DB.prepare(
        "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,?,'conversation.deleted','conversation',?)",
      ).bind(uid(), org, auth.userId, conversationDelete[1]),
    ])
    return json({ ok: true })
  }

  const match = path.match(
    /^\/api\/conversations\/([\w-]+)\/(messages|read|unread|attachments|assignment|human-request)$/,
  )

  if (!match) return null

  const conversationId = match[1]!

  if (match[2] === "attachments" && request.method === "POST")
    return sendAttachment(env, auth, conversationId, request)

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

  if (match[2] === "human-request" && request.method === "DELETE") {
    await env.DB.prepare(
      "UPDATE conversations SET human_requested_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(conversationId, org)
      .run()
    return json({ ok: true })
  }

  if (match[2] === "assignment" && request.method === "POST") {
    const body = await request.json<{ assignedTo?: unknown }>()
    if (
      body.assignedTo !== null &&
      (typeof body.assignedTo !== "string" || !body.assignedTo)
    )
      return json({ error: "Selecione a IA ou um membro da equipe." }, 400)
    if (body.assignedTo) {
      const member = await env.DB.prepare(
        "SELECT user_id FROM organization_members WHERE organization_id=? AND user_id=? AND status='active'",
      )
        .bind(org, body.assignedTo)
        .first()
      if (!member)
        return json({ error: "Membro ativo não encontrado na equipe." }, 400)
    }

    const current = await env.DB.prepare(
      "SELECT assigned_to assignedTo FROM conversations WHERE id=? AND organization_id=?",
    )
      .bind(conversationId, org)
      .first<{ assignedTo: string | null }>()
    if (!current) return json({ error: "Conversa não encontrada." }, 404)
    if (current.assignedTo === body.assignedTo && body.assignedTo !== null)
      return json({ ok: true })

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE conversations SET assigned_to=?,assignment_revision=assignment_revision+1,
         ai_resumed_at=CASE WHEN ? IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE ai_resumed_at END,
         human_requested_at=CASE WHEN ? IS NULL THEN NULL ELSE human_requested_at END,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=?`,
      ).bind(
        body.assignedTo,
        body.assignedTo,
        body.assignedTo,
        conversationId,
        org,
      ),
      ...(body.assignedTo === null
        ? [
            env.DB.prepare(
        `UPDATE leads SET ai_handoff_at=NULL,updated_at=CURRENT_TIMESTAMP
         WHERE organization_id=? AND contact_id=(SELECT contact_id FROM conversations WHERE id=? AND organization_id=?)`,
            ).bind(org, conversationId, org),
          ]
        : []),
    ])

    if (body.assignedTo === null) {
      const aiSettings = await env.DB.prepare(
        "SELECT enabled FROM ai_settings WHERE organization_id=?",
      )
        .bind(org)
        .first<{ enabled: number }>()
      if (!env.OPENAI_API_KEY || !aiSettings?.enabled)
        return json({
          ok: true,
          warning:
            "A conversa foi devolvida à IA, mas o assistente está desativado ou não está configurado.",
        })
      const pending = await env.DB.prepare(
        `SELECT direction,type,status,external_id externalId,
           COALESCE(external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at)) at FROM messages
         WHERE organization_id=? AND conversation_id=? AND status<>'failed'
         ORDER BY COALESCE(external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at)) DESC,rowid DESC LIMIT 1`,
      )
        .bind(org, conversationId)
        .first<{
          direction: string
          type: string
          status: string
          externalId: string | null
          at: string | null
        }>()
      if (pending?.direction === "outbound" && pending.status === "queued")
        return json({
          ok: true,
          warning:
            "Há uma mensagem em envio. Aguarde e use Retomar IA novamente para verificar se existe resposta pendente.",
        })
      if (pending?.direction === "inbound") {
        if (
          !["text", "audio", "image", "button", "interactive"].includes(
            pending.type,
          ) ||
          !pending.externalId
        )
          return json({
            ok: true,
            warning:
              "A última mensagem não pode ser processada automaticamente pela IA.",
          })
        if (!isWithinCustomerServiceWindow(pending.at))
          return json({
            ok: true,
            warning:
              "A janela de 24 horas expirou; a IA aguardará uma nova mensagem.",
          })
        try {
          const replied = await autoReply(
            env,
            org,
            conversationId,
            pending.externalId,
          )
          if (!replied)
            return json({
              ok: true,
              warning:
                "A IA não respondeu à mensagem pendente. Confira se está ativa e se a conversa ainda precisa de resposta.",
            })
        } catch (error) {
          console.error(
            "ai_resume_failed",
            error instanceof Error ? error.message : "unknown",
          )
          return json({
            ok: true,
            warning:
              "A conversa foi devolvida à IA, mas não foi possível responder à mensagem pendente.",
          })
        }
      }
    }
    return json({ ok: true })
  }

  if (match[2] === "read" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE conversations SET unread_count=0 WHERE id=? AND organization_id=?",
    )
      .bind(conversationId, org)
      .run()

    return json({ ok: true })
  }

  if (match[2] === "unread" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE conversations SET unread_count=MAX(unread_count,1),updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(conversationId, org)
      .run()
    return json({ ok: true })
  }

  if (match[2] === "messages" && request.method === "GET") {
    const rows =
      await env.DB.prepare(`SELECT id,direction,type,body,status,error_code errorCode,error_message errorMessage,media_id IS NOT NULL hasMedia,media_filename mediaFilename,media_mime mediaMime,COALESCE(external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at)) at
      FROM messages WHERE organization_id=? AND conversation_id=? ORDER BY COALESCE(external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at)) DESC,rowid DESC LIMIT 200`)
        .bind(org, conversationId)
        .all()

    const lastInboundAt = await latestInboundMessageAt(env, org, conversationId)
    const lastInboundTimestamp = lastInboundAt
      ? new Date(lastInboundAt).getTime()
      : NaN
    const windowEndsAt = Number.isFinite(lastInboundTimestamp)
      ? new Date(lastInboundTimestamp + WINDOW_MS).toISOString()
      : null

    return json({
      messages: rows.results.reverse(),
      windowOpen: isWithinCustomerServiceWindow(lastInboundAt),
      windowEndsAt,
    })
  }

  return null
}
