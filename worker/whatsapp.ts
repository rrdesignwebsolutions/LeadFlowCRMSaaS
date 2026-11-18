import type { Env, Session } from "./index"

import { autoReply, classifyLead, requestHuman, TALK_TO_HUMAN_ID } from "./ai"

import { effectiveLeadStatus } from "./lead-status"

import { executeInboundWorkflows } from "./workflows"

const DEFAULT_GRAPH_VERSION = "v26.0"

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

function graphVersion(env: Env) {
  const version = env.META_GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_VERSION

  if (version === "v26.0" || version === "v27.0") return version

  throw new Error(
    "META_GRAPH_API_VERSION deve ser v26.0 ou v27.0",
  )
}

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
    `${env.GRAPH_API_BASE ?? "https://graph.facebook.com"}/${graphVersion(env)}/${path}`,

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

  errors?: MetaApiError[]

  unsupported?: { type?: string }

  referral?: {
    source_url?: string

    source_id?: string

    source_type?: string

    headline?: string

    body?: string

    media_type?: string

    image_url?: string

    video_url?: string

    thumbnail_url?: string
  }

  context?: {
    from?: string

    id?: string

    forwarded?: boolean

    frequently_forwarded?: boolean
  }

  edit?: {
    original_message_id?: string

    message?: WaMessage
  }

  revoke?: { original_message_id?: string }

  text?: { body?: string }

  reaction?: {
    message_id?: string
    emoji?: string
  }

  image?: {
    id?: string
    caption?: string
    mime_type?: string
  }

  video?: {
    id?: string
    caption?: string
    mime_type?: string
  }

  document?: {
    id?: string

    caption?: string

    filename?: string

    mime_type?: string
  }

  audio?: { id?: string; mime_type?: string }

  sticker?: { id?: string; mime_type?: string }

  location?: {
    latitude?: number

    longitude?: number

    name?: string

    address?: string
  }

  contacts?: Array<{ name?: { formatted_name?: string } }>

  button?: { text?: string; payload?: string }

  interactive?: {
    type?: string

    body?: { text?: string }

    action?: {
      button?: string

      buttons?: Array<{ reply?: { id?: string; title?: string } }>

      sections?: Array<{
        title?: string

        rows?: Array<{ id?: string; title?: string; description?: string }>
      }>
    }

    button_reply?: { id?: string; title?: string }

    list_reply?: { id?: string; title?: string; description?: string }

    nfm_reply?: { body?: string; name?: string; response_json?: string }
  }
}

type WaStatus = {
  id?: string

  status?: string

  errors?: MetaApiError[]
}

type WaValue = {
  metadata?: { phone_number_id?: string; display_phone_number?: string }

  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>

  messages?: WaMessage[]

  message_echoes?: WaMessage[]

  statuses?: WaStatus[]

  history?: Array<{
    metadata?: { phase?: number; chunk_order?: number; progress?: number }

    threads?: Array<{
      id?: string

      context?: { wa_id?: string; user_id?: string }

      messages?: WaMessage[]
    }>

    errors?: MetaApiError[]
  }>

  state_sync?: Array<{
    type?: string

    action?: string

    contact?: {
      user_id?: string

      parent_user_id?: string

      username?: string

      phone_number?: string

      full_name?: string

      first_name?: string
    }

    metadata?: { timestamp?: string }
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

  const formFields: string[] = []

  if (formReply?.response_json) {
    try {
      const response = JSON.parse(formReply.response_json) as unknown

      if (
        response &&
        typeof response === "object" &&
        !Array.isArray(response)
      ) {
        for (const [key, value] of Object.entries(response).slice(0, 64)) {
          if (
            key.toLowerCase() === "flow_token" ||
            value == null ||
            value === ""
          )
            continue

          const formatted =
            typeof value === "string"
              ? value.slice(0, 500)
              : JSON.stringify(value)

          if (formatted) formFields.push(`${key.slice(0, 100)}: ${formatted}`)
        }
      }
    } catch {
      console.warn("whatsapp_form_reply_invalid_json", {
        messageId: m.id ?? null,
      })
    }
  }

  const formHasAnswers = formFields.length > 0

  const formBody =
    formReply?.body?.trim() &&
    !["sent", "submitted"].includes(formReply.body.trim().toLowerCase())
      ? formReply.body.trim().slice(0, 500)
      : null

  const formReplyBody = formReply
    ? [
        `O cliente concluiu um formulário no WhatsApp. Dê continuidade ao atendimento e responda ao interesse demonstrado usando as respostas abaixo.${
          formReply.name ? ` Formulário: ${formReply.name.slice(0, 120)}.` : ""
        }`,

        ...formFields,

        ...(formFields.length === 0 && formBody ? [formBody] : []),
      ].join("\n")
    : null

  const interactiveOptions = [
    ...(m.interactive?.action?.buttons ?? []).map(
      (button) => button.reply?.title,
    ),

    ...(m.interactive?.action?.sections ?? []).flatMap((section) =>
      (section.rows ?? []).map((row) => row.title),
    ),
  ].filter((value): value is string => !!value?.trim())

  const interactiveBody = [
    m.interactive?.body?.text?.trim(),

    m.interactive?.action?.button?.trim(),

    interactiveOptions.length
      ? `Opções: ${interactiveOptions.map((option) => option.slice(0, 100)).join(", ")}`
      : null,
  ]

    .filter(Boolean)

    .join("\n")

  const contentAvailable =
    (type === "text" && !!m.text?.body?.trim()) ||
    (type === "button" &&
      !!(m.button?.text?.trim() || m.button?.payload?.trim())) ||
    (type === "interactive" &&
      (formHasAnswers ||
        !!formBody ||
        !!m.interactive?.button_reply?.title?.trim() ||
        !!m.interactive?.button_reply?.id?.trim() ||
        !!m.interactive?.list_reply?.title?.trim() ||
        !!m.interactive?.list_reply?.description?.trim() ||
        !!m.interactive?.list_reply?.id?.trim())) ||
    (type === "image" && !!(m.image?.id || m.image?.caption?.trim())) ||
    (type === "audio" && !!m.audio?.id) ||
    (type === "video" && !!(m.video?.id || m.video?.caption?.trim())) ||
    (type === "document" &&
      !!(m.document?.id || m.document?.caption?.trim())) ||
    (type === "sticker" && !!m.sticker?.id) ||
    (type === "reaction" && !!m.reaction?.emoji?.trim()) ||
    (type === "location" &&
      typeof m.location?.latitude === "number" &&
      typeof m.location?.longitude === "number") ||
    (type === "contacts" && !!m.contacts?.length)

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
    (type === "interactive" && interactiveBody ? interactiveBody : null) ??
    [
      labels[type] ??
        (type === "interactive"
          ? "[Mensagem interativa sem conteúdo textual]"
          : `[${type}]`),

      m.document?.filename,

      m.image?.caption ?? m.video?.caption ?? m.document?.caption,
    ]

      .filter(Boolean)

      .join(" ")

  const serializeFields = (source: unknown, fields: string[]) => {
    if (!source || typeof source !== "object" || Array.isArray(source))
      return null

    const record = source as Record<string, unknown>

    const selected: Record<string, string | boolean> = {}

    for (const field of fields) {
      const value = record[field]

      if (typeof value === "string" && value.trim())
        selected[field] = value.trim().slice(0, 1000)
      else if (typeof value === "boolean") selected[field] = value
    }

    return Object.keys(selected).length ? JSON.stringify(selected) : null
  }

  const referralJson = serializeFields(m.referral, [
    "source_url",

    "source_id",

    "source_type",

    "headline",

    "body",

    "media_type",

    "image_url",

    "video_url",

    "thumbnail_url",
  ])

  const contextJson = serializeFields(m.context, [
    "from",

    "id",

    "forwarded",

    "frequently_forwarded",
  ])

  return {
    type,

    body: body.slice(0, 4096),

    errorCode,

    contentAvailable,

    referralJson,

    contextJson,
  }
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
      SELECT COALESCE(
        strftime('%Y-%m-%dT%H:%M:%fZ',external_created_at),
        strftime('%Y-%m-%dT%H:%M:%fZ',created_at)
      ) at
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

  origin: "customer" | "business_app" | "history" = direction === "inbound"
    ? "customer"
    : "business_app",

  scheduleAi = false,
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

      contentAvailable: false,

      jobId: null,
    }

  const { type, body, errorCode, contentAvailable, referralJson, contextJson } =
    describeMessage(m)

  const metaUnavailable = type === "unsupported" && errorCode === "131060"

  const jobId =
    scheduleAi && (contentAvailable || metaUnavailable)
      ? `${integration.id}:${m.id}`
      : null

  const duplicate = await env.DB.prepare(
    "SELECT conversation_id FROM messages WHERE organization_id=? AND external_id=?",
  )

    .bind(org, m.id)

    .first<{ conversation_id: string }>()

  if (duplicate) {
    if (direction === "outbound" && origin === "business_app")
      await env.DB.prepare(
        "UPDATE conversations SET ai_state='HUMANO',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      )

        .bind(duplicate.conversation_id, org)

        .run()

    if (jobId) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO whatsapp_processing_jobs(id,organization_id,conversation_id,inbound_external_id) VALUES(?,?,?,?)",
      )

        .bind(jobId, org, duplicate.conversation_id, m.id)

        .run()

      const queued = await env.DB.prepare(
        "SELECT 1 FROM whatsapp_processing_jobs WHERE organization_id=? AND inbound_external_id=?",
      )

        .bind(org, m.id)

        .first()

      if (!queued)
        throw new Error("A mensagem duplicada não foi colocada na fila da IA")
    }

    console.info("whatsapp_message_duplicate", {
      organizationId: org,

      integrationId: integration.id,

      direction,

      messageType: type,

      processingJobQueued: !!jobId,
    })

    return {
      conversationId: duplicate.conversation_id,

      type,

      externalId: m.id,

      inserted: false,

      contentAvailable,

      jobId,
    }
  }

  const profileName =
    value.contacts

      ?.find((c) => c.wa_id === waId)

      ?.profile?.name?.trim()

      .slice(0, 120) || null

  const variants = phoneVariants(waId)

  const atSeconds = Number(m.timestamp)

  const at =
    Number.isFinite(atSeconds) && atSeconds > 0
      ? new Date(atSeconds * 1000).toISOString()
      : new Date().toISOString()

  const media = m.document ?? m.image ?? m.video ?? m.audio ?? m.sticker

  const mediaFilename = m.document?.filename?.slice(0, 255) ?? null

  const inbound = direction === "inbound"

  const contactPhone = `+${waId}`

  const conversationCandidateId = uid()

  const insertMessageSql = `INSERT OR IGNORE INTO messages(
      id,organization_id,conversation_id,external_id,direction,type,body,status,
      external_created_at,media_id,media_filename,media_mime,error_code,origin,
      content_available,referral_json,context_json
    )
    SELECT ?,?,c.id,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    FROM conversations c
    JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
    WHERE c.organization_id=? AND c.integration_id=?
      AND ct.phone_e164 IN (${variants.map(() => "?").join(",")})
    LIMIT 1`

  const batch: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO contacts(id,organization_id,name,phone_e164)
       SELECT ?,?,?,?
       WHERE NOT EXISTS (
         SELECT 1 FROM contacts WHERE organization_id=?
           AND phone_e164 IN (${variants.map(() => "?").join(",")})
       )`,
    ).bind(uid(), org, profileName, contactPhone, org, ...variants),

    env.DB.prepare(
      `UPDATE contacts SET name=COALESCE(name,?),updated_at=CURRENT_TIMESTAMP
       WHERE id=(
         SELECT id FROM contacts WHERE organization_id=?
           AND phone_e164 IN (${variants.map(() => "?").join(",")}) LIMIT 1
       )`,
    ).bind(profileName, org, ...variants),

    env.DB.prepare(
      `INSERT OR IGNORE INTO leads(id,organization_id,contact_id,status)
       SELECT ?,?,ct.id,'new' FROM contacts ct
       WHERE ct.organization_id=? AND ct.phone_e164 IN (${variants.map(() => "?").join(",")})
       LIMIT 1`,
    ).bind(uid(), org, org, ...variants),

    env.DB.prepare(
      `INSERT OR IGNORE INTO conversations(id,organization_id,contact_id,integration_id,status,unread_count)
       SELECT ?,?,ct.id,?,'open',0 FROM contacts ct
       WHERE ct.organization_id=? AND ct.phone_e164 IN (${variants.map(() => "?").join(",")})
       LIMIT 1`,
    ).bind(
      conversationCandidateId,

      org,

      integration.id,

      org,

      ...variants,
    ),

    env.DB.prepare(insertMessageSql).bind(
      uid(),

      org,

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

      origin,

      inbound && contentAvailable ? 1 : 0,

      referralJson,

      contextJson,

      org,

      integration.id,

      ...variants,
    ),

    env.DB.prepare(
      `UPDATE conversations SET
        last_message_at=CASE WHEN last_message_at IS NULL OR last_message_at<? THEN ? ELSE last_message_at END,
        unread_count=unread_count+?,status='open',updated_at=CURRENT_TIMESTAMP
       WHERE id=(
         SELECT c.id FROM conversations c
         JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
         WHERE c.organization_id=? AND c.integration_id=?
           AND ct.phone_e164 IN (${variants.map(() => "?").join(",")})
         LIMIT 1
       ) AND organization_id=? AND changes()>0`,
    ).bind(
      at,

      at,

      countUnread && inbound ? 1 : 0,

      org,

      integration.id,

      ...variants,

      org,
    ),
  ]

  if (jobId)
    batch.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO whatsapp_processing_jobs(id,organization_id,conversation_id,inbound_external_id)
         SELECT ?,?,c.id,? FROM conversations c
         JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
         WHERE c.organization_id=? AND c.integration_id=?
           AND ct.phone_e164 IN (${variants.map(() => "?").join(",")})
         LIMIT 1`,
      ).bind(jobId, org, m.id, org, integration.id, ...variants),
    )

  const results = await env.DB.batch(batch)

  const persisted = await env.DB.prepare(
    "SELECT conversation_id conversationId FROM messages WHERE organization_id=? AND external_id=?",
  )

    .bind(org, m.id)

    .first<{ conversationId: string }>()

  if (!persisted)
    throw new Error("A mensagem recebida não foi persistida no D1")

  let processingJobQueued = false

  if (jobId) {
    const queued = await env.DB.prepare(
      "SELECT 1 FROM whatsapp_processing_jobs WHERE organization_id=? AND inbound_external_id=?",
    )

      .bind(org, m.id)

      .first()

    processingJobQueued = !!queued

    if (!processingJobQueued)
      throw new Error("A mensagem recebida não foi colocada na fila da IA")
  }

  if (
    direction === "outbound" &&
    origin === "business_app" &&
    results[4]?.meta.changes
  )
    await env.DB.prepare(
      "UPDATE conversations SET ai_state='HUMANO',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )

      .bind(persisted.conversationId, org)

      .run()

  console.info("whatsapp_message_persisted", {
    organizationId: org,

    integrationId: integration.id,

    direction,

    messageType: type,

    inserted: !!results[4]?.meta.changes,

    contactCreated: !!results[0]?.meta.changes,

    conversationCreated: !!results[3]?.meta.changes,

    contentAvailable: inbound && contentAvailable,

    metaErrorCode: errorCode,

    referralPresent: !!referralJson,

    processingJobEligible: !!jobId,

    processingJobQueued,
  })

  return {
    conversationId: persisted.conversationId,

    type,

    externalId: m.id,

    inserted: !!results[4]?.meta.changes,

    contentAvailable,

    jobId,
  }
}

async function handleMessageMutation(
  env: Env,

  integration: Integration,

  message: WaMessage,

  direction: "inbound" | "outbound",
) {
  const originalId =
    message.type === "edit"
      ? message.edit?.original_message_id
      : message.type === "revoke"
        ? message.revoke?.original_message_id
        : null

  if (!originalId || !message.id)
    throw new Error("evento de edição ou exclusão sem identificadores")

  let result: D1Result

  if (message.type === "edit") {
    const edited = message.edit?.message

    if (!edited) throw new Error("evento de edição sem conteúdo")

    const { type, body, contentAvailable } = describeMessage(edited)

    const media =
      edited.document ??
      edited.image ??
      edited.video ??
      edited.audio ??
      edited.sticker

    result = await env.DB.prepare(
      `UPDATE messages SET type=?,body=?,media_id=?,media_filename=?,media_mime=?,
       content_available=?,error_code=NULL,error_message=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=? AND external_id=? AND direction=?`,
    )

      .bind(
        type,

        body,

        media?.id ?? null,

        edited.document?.filename?.slice(0, 255) ?? null,

        media?.mime_type ?? null,

        direction === "inbound" && contentAvailable ? 1 : 0,

        integration.organization_id,

        originalId,

        direction,
      )

      .run()
  } else {
    result = await env.DB.prepare(
      `UPDATE messages SET type='text',body='[Mensagem apagada no WhatsApp Business.]',
       media_id=NULL,media_filename=NULL,media_mime=NULL,content_available=0,
       updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=? AND external_id=? AND direction=?`,
    )

      .bind(integration.organization_id, originalId, direction)

      .run()
  }

  if (!result.meta.changes)
    throw new Error("mensagem original de edição ou exclusão não encontrada")

  console.info("whatsapp_message_mutated", {
    organizationId: integration.organization_id,

    integrationId: integration.id,

    direction,

    mutation: message.type,

    originalMessageId: originalId,
  })
}

async function handleMessageEcho(
  env: Env,

  integration: Integration,

  value: WaValue,

  echo: WaMessage,
) {
  if (echo.type === "edit" || echo.type === "revoke") {
    await handleMessageMutation(env, integration, echo, "outbound")

    return
  }

  if (!echo.to) throw new Error("eco sem destinatário")

  await handleInbound(
    env,

    integration,

    value,

    { ...echo, from: echo.to },

    "outbound",

    false,

    "business_app",
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

          "history",
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

async function handleAppStateSync(
  env: Env,

  integration: Integration,

  value: WaValue,
) {
  const changes = value.state_sync ?? []

  let added = 0

  let removed = 0

  for (const change of changes) {
    if (change.type !== "contact")
      throw new Error("tipo desconhecido no smb_app_state_sync")

    const contact = change.contact

    const userId = contact?.user_id?.trim().slice(0, 200)

    if (!userId) throw new Error("contato sincronizado sem user_id")

    if (change.action !== "add" && change.action !== "remove")
      throw new Error("ação desconhecida no smb_app_state_sync")

    const rawPhone = contact.phone_number?.replace(/\D/g, "") ?? ""

    if (rawPhone && !/^\d{5,20}$/.test(rawPhone))
      throw new Error("telefone inválido no smb_app_state_sync")

    const phone = rawPhone ? `+${rawPhone}` : null

    const isRemoved = change.action === "remove"

    await env.DB.prepare(
      `INSERT INTO whatsapp_business_app_contacts(
        integration_id,organization_id,user_id,parent_user_id,username,
        phone_e164,full_name,first_name,is_removed
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(integration_id,user_id) DO UPDATE SET
        parent_user_id=COALESCE(excluded.parent_user_id,parent_user_id),
        username=COALESCE(excluded.username,username),
        phone_e164=COALESCE(excluded.phone_e164,phone_e164),
        full_name=COALESCE(excluded.full_name,full_name),
        first_name=COALESCE(excluded.first_name,first_name),
        is_removed=excluded.is_removed,updated_at=CURRENT_TIMESTAMP
      WHERE whatsapp_business_app_contacts.organization_id=excluded.organization_id`,
    )

      .bind(
        integration.id,

        integration.organization_id,

        userId,

        contact.parent_user_id?.slice(0, 200) ?? null,

        contact.username?.slice(0, 128) ?? null,

        phone,

        contact.full_name?.slice(0, 200) ?? null,

        contact.first_name?.slice(0, 100) ?? null,

        isRemoved ? 1 : 0,
      )

      .run()

    if (isRemoved) removed++
    else added++
  }

  console.info("whatsapp_business_app_contacts_synced", {
    organizationId: integration.organization_id,

    integrationId: integration.id,

    addedOrUpdated: added,

    removed,

    total: changes.length,

    contactsWithoutPhone: changes.filter(
      (change) => !change.contact?.phone_number,
    ).length,
  })
}

const AI_JOB_MAX_ATTEMPTS = 5

const AI_JOB_RETRY_SECONDS = [60, 300, 900, 3600]

export async function processWhatsAppJob(env: Env, jobId: string) {
  const claimed = await env.DB.prepare(
    `UPDATE whatsapp_processing_jobs
     SET status='processing',attempts=attempts+1,
       locked_until=datetime('now','+10 minutes'),updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND (
       (status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP) OR
       (status='processing' AND locked_until<=CURRENT_TIMESTAMP)
     )`,
  )

    .bind(jobId)

    .run()

  if (!claimed.meta.changes) return

  const job = await env.DB.prepare(
    `SELECT organization_id organizationId,conversation_id conversationId,
       inbound_external_id inboundExternalId,attempts
     FROM whatsapp_processing_jobs WHERE id=? AND status='processing'`,
  )

    .bind(jobId)

    .first<{
      organizationId: string

      conversationId: string

      inboundExternalId: string

      attempts: number
    }>()

  if (!job) return

  try {
    console.info("whatsapp_ai_job_started", {
      organizationId: job.organizationId,

      conversationId: job.conversationId,

      attempt: job.attempts,
    })

    let replied = await autoReply(
      env,

      job.organizationId,

      job.conversationId,

      job.inboundExternalId,
    )

    if (!replied) {
      const workflowOutcome = await executeInboundWorkflows(
        env,
        job.organizationId,
        job.conversationId,
        job.inboundExternalId,
        {
          sendMessage: async (text, idempotencyKey) => {
            const sent = await sendText(
              env,
              {
                userId: "",
                organizationId: job.organizationId,
                role: "ai",
              },
              job.conversationId,
              text,
              { aiReplyKey: idempotencyKey },
            )
            if (!sent.ok)
              throw new Error(
                `envio da mensagem do fluxo falhou (${sent.status})`,
              )
          },
        },
      )
      replied = workflowOutcome.sentMessage || workflowOutcome.assignedHuman
    }

    if (!replied)
      await classifyLead(
        env,

        job.organizationId,

        job.conversationId,

        job.inboundExternalId,
      )

    await env.DB.prepare(
      `UPDATE whatsapp_processing_jobs SET status='completed',locked_until=NULL,
       error_summary=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND status='processing'`,
    )

      .bind(jobId)

      .run()

    console.info("whatsapp_ai_job_completed", {
      organizationId: job.organizationId,

      conversationId: job.conversationId,

      replied: !!replied,
    })
  } catch (error) {
    const emitted = await env.DB.prepare(
      `SELECT 1 FROM messages
       WHERE organization_id=? AND direction='outbound' AND is_ai=1
         AND ai_reply_key IS NOT NULL AND substr(ai_reply_key,1,?)=? LIMIT 1`,
    )

      .bind(
        job.organizationId,

        `ai:${job.inboundExternalId}:`.length,

        `ai:${job.inboundExternalId}:`,
      )

      .first()

    const failed = job.attempts >= AI_JOB_MAX_ATTEMPTS

    const status = emitted ? "needs_review" : failed ? "failed" : "pending"

    const delay =
      AI_JOB_RETRY_SECONDS[
        Math.min(job.attempts - 1, AI_JOB_RETRY_SECONDS.length - 1)
      ] ?? 3600

    const summary =
      error instanceof Error ? error.message.slice(0, 200) : "Erro desconhecido"

    await env.DB.prepare(
      `UPDATE whatsapp_processing_jobs SET status=?,locked_until=NULL,
       next_attempt_at=CASE WHEN ?='pending' THEN datetime('now',?) ELSE next_attempt_at END,
       error_summary=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND status='processing'`,
    )

      .bind(status, status, `+${delay} seconds`, summary, jobId)

      .run()

    console.error("whatsapp_ai_job_failed", {
      organizationId: job.organizationId,

      conversationId: job.conversationId,

      attempts: job.attempts,

      status,

      error: summary,
    })
  }
}

export async function processPendingWhatsAppJobs(
  env: Env,

  limit = 20,
) {
  for (let count = 0; count < limit; count++) {
    const job = await env.DB.prepare(
      `SELECT id FROM whatsapp_processing_jobs
       WHERE (status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP)
         OR (status='processing' AND locked_until<=CURRENT_TIMESTAMP)
       ORDER BY created_at LIMIT 1`,
    ).first<{ id: string }>()

    if (!job) return

    await processWhatsAppJob(env, job.id)
  }
}

export async function recoverUnqueuedInboundMessages(env: Env) {
  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO whatsapp_processing_jobs(
       id,organization_id,conversation_id,inbound_external_id
     )
     SELECT 'recovered:'||m.organization_id||':'||m.external_id,
       m.organization_id,m.conversation_id,m.external_id
     FROM messages m
     WHERE m.direction='inbound'
       AND m.origin='customer'
       AND m.status='received'
       AND m.external_id IS NOT NULL
       AND (
         (m.content_available=1 AND m.type IN ('text','audio','image','button','interactive'))
         OR (m.content_available=0 AND m.type='unsupported' AND m.error_code='131060')
       )
       AND m.created_at>=datetime('now','-24 hours')
       AND NOT EXISTS (
         SELECT 1 FROM whatsapp_processing_jobs j
         WHERE j.organization_id=m.organization_id
           AND j.inbound_external_id=m.external_id
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages r
         WHERE r.organization_id=m.organization_id
           AND r.conversation_id=m.conversation_id
           AND r.direction='outbound'
           AND r.is_ai=1
           AND r.status<>'failed'
           AND r.ai_reply_key IS NOT NULL
           AND substr(r.ai_reply_key,1,length('ai:'||m.external_id||':'))
             ='ai:'||m.external_id||':'
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages r
         WHERE r.organization_id=m.organization_id
           AND r.conversation_id=m.conversation_id
           AND r.direction='outbound'
           AND r.is_ai=1
           AND r.status<>'failed'
           AND julianday(COALESCE(r.external_created_at,r.created_at))
             > julianday(COALESCE(m.external_created_at,m.created_at))
           AND NOT EXISTS (
             SELECT 1 FROM messages n
             WHERE n.organization_id=m.organization_id
               AND n.conversation_id=m.conversation_id
               AND n.direction='inbound'
               AND julianday(COALESCE(n.external_created_at,n.created_at))
                 > julianday(COALESCE(m.external_created_at,m.created_at))
               AND julianday(COALESCE(n.external_created_at,n.created_at))
                 <= julianday(COALESCE(r.external_created_at,r.created_at))
           )
       )`,
  ).run()

  const recovered = result.meta.changes ?? 0

  if (recovered)
    console.warn("whatsapp_orphaned_inbound_jobs_recovered", {
      count: recovered,
    })

  return recovered
}

async function updateCatalogDeliveryStatus(
  env: Env,

  organizationId: string,

  messageId: string,

  status: "accepted" | "sent" | "delivered" | "read" | "failed",
) {
  const batches = (
    await env.DB.prepare(
      `SELECT b.id,b.delivery_job_id deliveryJobId,b.message_id messageIds
       FROM catalog_delivery_batches b
       JOIN catalog_delivery_jobs j ON j.id=b.delivery_job_id
       WHERE j.organization_id=? AND b.message_id IS NOT NULL AND (
         b.message_id=? OR EXISTS (
           SELECT 1 FROM json_each(
             CASE WHEN json_valid(b.message_id) THEN b.message_id
               ELSE json_array(b.message_id) END
           ) tracked WHERE tracked.value=?
         )
     )`,
  )

      .bind(organizationId, messageId, messageId)

      .all<{
        id: string

        deliveryJobId: string

        messageIds: string
      }>()
  ).results

  if (!batches.length) return

  const affectedJobs = new Set<string>()

  for (const batch of batches) {
    const messageIds = (() => {
      try {
        const parsed: unknown = JSON.parse(batch.messageIds)

        return Array.isArray(parsed) &&
          parsed.every((id) => typeof id === "string")
          ? [...new Set(parsed)]
          : [batch.messageIds]
      } catch {
        return [batch.messageIds]
      }
    })()

    if (!messageIds.includes(messageId)) continue

    const statuses = (
      await env.DB.prepare(
        `SELECT status FROM messages WHERE organization_id=?
         AND id IN (${messageIds.map(() => "?").join(",")})`,
      )

        .bind(organizationId, ...messageIds)

        .all<{ status: string }>()
    ).results.map((message) => message.status)

    const deliveryStatus = statuses.includes("failed")
      ? "failed"
      : statuses.length && statuses.every((item) => item === "read")
        ? "read"
        : statuses.length &&
            statuses.every((item) => item === "delivered" || item === "read")
          ? "delivered"
          : statuses.length &&
              statuses.every((item) =>
                ["sent", "delivered", "read"].includes(item),
              )
            ? "sent"
            : status === "failed"
              ? "failed"
              : "accepted"

    await env.DB.prepare(
      "UPDATE catalog_delivery_batches SET delivery_status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
    )

      .bind(deliveryStatus, batch.id)

    .run()

    affectedJobs.add(batch.deliveryJobId)
  }

  for (const jobId of affectedJobs)
  await env.DB.prepare(
    `UPDATE catalog_delivery_jobs SET delivery_status=CASE
       WHEN EXISTS (
         SELECT 1 FROM catalog_delivery_batches b
         WHERE b.delivery_job_id=catalog_delivery_jobs.id AND b.delivery_status='failed'
       ) THEN 'failed'
       WHEN NOT EXISTS (
         SELECT 1 FROM catalog_delivery_batches b
         WHERE b.delivery_job_id=catalog_delivery_jobs.id
           AND b.delivery_status NOT IN ('delivered','read')
       ) THEN 'delivered'
       ELSE 'pending' END,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=?`,
  )

      .bind(jobId, organizationId)

    .run()

  if (status === "failed")
    console.error("whatsapp_catalog_batch_delivery_failed", {
      organizationId,

      messageId,
    })
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

    await updateCatalogDeliveryStatus(
      env,

      integration.organization_id,

      message.id,

      "failed",
    )

    return
  }

  if (message.status === "failed") return

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

  if (
    next === "accepted" ||
    next === "sent" ||
    next === "delivered" ||
    next === "read"
  )
    await updateCatalogDeliveryStatus(
      env,

      integration.organization_id,

      message.id,

      next,
    )
}

type WebhookWorkItem = {
  key: string

  run: (eventId: string) => Promise<void>

  ignored?: boolean

  errorSummary?: string
}

export async function handleMetaPayload(
  env: Env,

  payload: {
    object?: string

    entry?: Array<{
      id?: string

      time?: number

      changes?: Array<{ field?: string; value?: WaValue }>
    }>
  },

  payloadHash: string,

  after: (task: Promise<unknown>) => void = () => {},
) {
  if (payload.object !== "whatsapp_business_account") return

  const entries = payload.entry ?? []

  const fields = [
    ...new Set(
      entries.flatMap((entry) =>
        (entry.changes ?? []).map((change) => change.field ?? "unknown"),
      ),
    ),
  ]

  console.info("meta_webhook_received", {
    payloadHash,

    entryCount: entries.length,

    fields,
  })

  let processingFailed = false

  for (const entry of entries)
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

      const accountLevelFields = [
        "account_update",

        "smb_app_state_sync",

        "history",

        "smb_message_echoes",
      ]

      const accountIntegrations =
        !phone && entry.id && accountLevelFields.includes(change.field ?? "")
          ? await env.DB.prepare(
              "SELECT id,organization_id FROM integrations WHERE provider='meta_whatsapp' AND external_account_id=? AND status IN ('connected','error')",
            )

              .bind(entry.id)

              .all<Integration>()
          : null

      const accountOrganizations = new Set(
        (accountIntegrations?.results ?? []).map(
        (accountIntegration) => accountIntegration.organization_id,
        ),
      )

      const ambiguousAccount = accountOrganizations.size > 1

      const integrations: Array<Integration | null> = byPhone
        ? [byPhone]
        : ambiguousAccount
        ? [null]
        : accountIntegrations?.results?.length
          ? accountIntegrations.results
          : [null]

      for (const integration of integrations) {
        const items: WebhookWorkItem[] = []

        if (change.field === "messages") {
          for (const [messageIndex, item] of (value.messages ?? []).entries()) {
            const externalId =
              item.id ??
              `missing-id:${changeIndex}:${messageIndex}:${payloadHash}`

            items.push({
              key: `${externalId}:message`,

              run: async () => {
                if (item.type === "edit" || item.type === "revoke") {
                  await handleMessageMutation(
                    env,

                    integration!,

                    item,

                    "inbound",
                  )

                  return
                }

                const humanRequest =
                  item.interactive?.button_reply?.id === TALK_TO_HUMAN_ID ||
                  item.button?.payload === TALK_TO_HUMAN_ID

                const aiEligible =
                  [
                  "text",

                  "audio",

                  "image",

                  "button",

                  "interactive",
                ].includes(item.type ?? "") ||
                  (item.type === "unsupported" &&
                    item.errors?.some((error) => error.code === 131060) ===
                      true)

                const result = await handleInbound(
                  env,

                  integration!,

                  value,

                  item,

                  "inbound",

                  true,

                  "customer",

                  aiEligible && !humanRequest,
                )

                if (result.inserted && humanRequest)
                  after(
                    requestHuman(
                      env,

                      integration!.organization_id,

                      result.conversationId,

                      true,
                    ).catch((error) =>
                      console.error("request_human_failed", {
                        organizationId: integration!.organization_id,

                        error:
                          error instanceof Error ? error.message : "unknown",
                      }),
                    ),
                  )

                if (result.jobId) after(processWhatsAppJob(env, result.jobId))
              },
            })
          }

          for (const [statusIndex, item] of (value.statuses ?? []).entries()) {
            const externalId =
              item.id ??
              `missing-id:${changeIndex}:${statusIndex}:${payloadHash}`

            items.push({
              key: `${externalId}:${item.status ?? "unknown-status"}`,

              run: () => handleStatus(env, integration!, item),
            })
          }
        }

        if (change.field === "smb_message_echoes")
          for (const [echoIndex, item] of (
            value.message_echoes ?? []
          ).entries()) {
            const externalId =
              item.id ?? `missing-id:${changeIndex}:${echoIndex}:${payloadHash}`

            items.push({
              key: `${externalId}:echo`,

              run: () => handleMessageEcho(env, integration!, value, item),
            })
          }

        if (change.field === "history")
          items.push({
            key: `history:${entry.id ?? "unknown"}:${changeIndex}:${payloadHash}`,

            run: () => handleHistory(env, integration!, value),
          })

        if (change.field === "smb_app_state_sync")
          items.push({
            key: `smb_app_state_sync:${entry.id ?? "unknown"}:${changeIndex}:${payloadHash}`,

            run: () => handleAppStateSync(env, integration!, value),
          })

        if (change.field === "account_update" && entry.id)
          items.push({
            key: `account_update:${entry.id}:${value.event ?? "unknown"}:${entry.time ?? "unknown"}:${changeIndex}:${payloadHash}`,

            run: () => handleAccountUpdate(env, integration!, value),
          })

        for (const [errorIndex, error] of (value.errors ?? []).entries()) {
          const errorCode = error.code ?? "unknown"

          const summary =
            `Erro informado pela Meta (${errorCode}): ${metaErrorMessage(error, "sem detalhes")}`.slice(
            0,

            200,
          )

          items.push({
            key: `meta-error:${change.field ?? "unknown"}:${errorCode}:${changeIndex}:${errorIndex}:${payloadHash}`,

            errorSummary: summary,

            run: async (eventId) => {
              console.error("whatsapp_webhook_meta_error", {
                organizationId: integration!.organization_id,

                integrationId: integration!.id,

                field: change.field ?? "unknown",

                code: error.code ?? null,

                subcode: error.error_subcode ?? null,

                fbtraceId: error.fbtrace_id ?? null,
              })

              await env.DB.prepare(
                "UPDATE webhook_events SET error_summary=? WHERE id=? AND organization_id=?",
              )

                .bind(summary, eventId, integration!.organization_id)

                .run()
            },
          })
        }

        if (items.length === 0)
          items.push({
            key: `ignored:${change.field ?? "unknown"}:${changeIndex}:${payloadHash}`,

            ignored: true,

            errorSummary:
              `Campo de webhook recebido sem processamento configurado: ${change.field ?? "unknown"}`.slice(
              0,

              200,
            ),

            run: async () => {},
          })

        for (const item of items) {
          const eventId = uid()

          const externalEventId = `${integration?.id ?? "unmatched"}:${item.key}`

          const inserted = await env.DB.prepare(
            `INSERT INTO webhook_events(id,provider,external_event_id,phone_number_id,event_type,organization_id,payload_hash,status,error_summary)
             VALUES(?,'meta_whatsapp',?,?,?,?,?,?,?)
             ON CONFLICT(provider,external_event_id) DO UPDATE
               SET status='received',error_summary=NULL,received_at=CURRENT_TIMESTAMP
             WHERE excluded.organization_id IS NOT NULL AND ?=0 AND
               (webhook_events.status='failed' OR
               (webhook_events.status='received' AND webhook_events.received_at<datetime('now','-5 minutes')))`,
          )

            .bind(
              eventId,

              externalEventId,

              phone ?? null,

              change.field ?? "unknown",

              integration?.organization_id ?? null,

              payloadHash,

              item.ignored || !integration ? "ignored" : "received",

              item.errorSummary ?? null,

              item.ignored ? 1 : 0,
            )

            .run()

          if (!inserted.meta.changes) continue

          if (!integration) {
            console.warn("whatsapp_webhook_unmatched", {
              phoneNumberId: phone ?? null,

              wabaId: entry.id ?? null,

              field: change.field ?? "unknown",

              ambiguousTenant: ambiguousAccount,
            })

            continue
          }

          if (item.ignored) {
            console.info("whatsapp_webhook_event_ignored", {
              organizationId: integration.organization_id,

              integrationId: integration.id,

              field: change.field ?? "unknown",

              reason: item.errorSummary,
            })

            continue
          }

          const event = await env.DB.prepare(
            "SELECT id FROM webhook_events WHERE provider='meta_whatsapp' AND external_event_id=? AND organization_id=?",
          )

            .bind(externalEventId, integration.organization_id)

            .first<{ id: string }>()

          if (!event)
            throw new Error("Evento de webhook não encontrado após registro")

          try {
            await item.run(event.id)

            await env.DB.prepare(
              "UPDATE webhook_events SET status='processed',processed_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
            )

              .bind(event.id, integration.organization_id)

              .run()
          } catch (error) {
            const summary =
              error instanceof Error
                ? error.message.slice(0, 200)
                : "Erro desconhecido"

            console.error("whatsapp_webhook_item_failed", {
              organizationId: integration.organization_id,

              integrationId: integration.id,

              eventId: event.id,

              field: change.field ?? "unknown",

              error: summary,
            })

            if (change.field === "history")
              await env.DB.prepare(`UPDATE integrations
                SET history_sync_status='failed',history_sync_error='A Meta enviou histórico que não pôde ser processado.',updated_at=CURRENT_TIMESTAMP
                WHERE id=? AND organization_id=?`)

                .bind(integration.id, integration.organization_id)

                .run()

            await env.DB.prepare(
              "UPDATE webhook_events SET status='failed',error_summary=? WHERE id=? AND organization_id=?",
            )

              .bind(summary, event.id, integration.organization_id)

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

async function subscribeWaba(
  env: Env,

  organizationId: string,

  integrationId: string,

  wabaId: string,

  token: string,
) {
  let result: GraphResult | null = null

  try {
    result = await graphFetch(env, `${wabaId}/subscribed_apps`, token, {})
  } catch {
    console.error("whatsapp_subscription_request_failed", {
      organizationId,

      integrationId,

      apiVersion: graphVersion(env),
    })
  }

  const subscribed = result?.ok === true && result.data.success === true

  if (!subscribed) {
    const message = result
      ? graphMessage(result)
      : "Não foi possível confirmar a solicitação com a Meta."

    const summary = `Assinatura do webhook da Meta falhou: ${message}`.slice(
      0,

      200,
    )

    await env.DB.prepare(
      "UPDATE integrations SET status='error',error_code='webhook_subscription',error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )

      .bind(summary, integrationId, organizationId)

      .run()

    if (result && !result.ok)
      logMetaApiError("whatsapp_subscription_api_error", result)

    return { subscribed: false, error: summary }
  }

  await env.DB.prepare(
    `UPDATE integrations SET
      status=CASE WHEN error_code='webhook_subscription' THEN 'connected' ELSE status END,
      error_code=CASE WHEN error_code='webhook_subscription' THEN NULL ELSE error_code END,
      error_summary=CASE WHEN error_code='webhook_subscription' THEN NULL ELSE error_summary END,
      updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND organization_id=?`,
  )

    .bind(integrationId, organizationId)

    .run()

  return { subscribed: true as const }
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

    .first<{ id: string; organization_id: string }>()

  if (sameNumber && sameNumber.organization_id !== auth.organizationId)
    return json(
      { error: "Este número já está conectado a outra empresa." },

      409,
    )

  const sameWaba = await env.DB.prepare(
    "SELECT organization_id FROM integrations WHERE provider='meta_whatsapp' AND external_account_id=? AND status IN ('connected','error') LIMIT 1",
  )

    .bind(wabaId)

    .first<{ organization_id: string }>()

  if (sameWaba && sameWaba.organization_id !== auth.organizationId)
    return json(
      { error: "Esta conta WhatsApp já está conectada a outra empresa." },

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

  const subscription = await subscribeWaba(
    env,

    auth.organizationId,

    integrationId,

    wabaId,

    token,
  )

  return json({
    ok: true,

    displayPhoneNumber: display,

    verifiedName,

    subscribed: subscription.subscribed,

    subscribeError: subscription.subscribed ? undefined : subscription.error,
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
    `${env.GRAPH_API_BASE ?? "https://graph.facebook.com"}/${graphVersion(env)}/oauth/access_token`,
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

  body: { pendingId?: string; phoneNumberId?: string },
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

    .first<{ waba_id: string; access_token_enc: string }>()

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

  const name = (row.filename ?? `${row.type}-${messageId.slice(0, 8)}.${ext}`)

    .replace(/[\r\n"\\/]/g, "_")

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

  role: Session["role"],

  organizationId: string,

  conversationId: string,
) {
  if (role !== "ai") return true

  const row = await env.DB.prepare(
    `SELECT c.ai_state aiState,
       EXISTS(
         SELECT 1 FROM messages m
         WHERE m.organization_id=c.organization_id
           AND m.conversation_id=c.id
           AND m.direction='outbound'
           AND m.is_ai=0
           AND m.status<>'failed'
           AND (
             c.ai_resumed_at IS NULL
             OR julianday(COALESCE(m.external_created_at,m.created_at))
               > julianday(c.ai_resumed_at)
           )
       ) humanActive
     FROM conversations c WHERE c.id=? AND c.organization_id=?`,
  )

    .bind(conversationId, organizationId)

    .first<{ aiState: string; humanActive: number }>()

  return !!row && row.aiState === "IA_ATIVA" && !row.humanActive
}

async function existingAiReply(
  env: Env,

  organizationId: string,

  key: string | undefined,
) {
  if (!key) return null

  const existing = await env.DB.prepare(
    "SELECT id,status FROM messages WHERE organization_id=? AND ai_reply_key=? AND direction='outbound' AND is_ai=1",
  )

    .bind(organizationId, key)

    .first<{ id: string; status: string }>()

  if (!existing) return null

  if (["accepted", "sent", "delivered", "read"].includes(existing.status))
    return json({
      ok: true,

      messageId: existing.id,

      alreadyAttempted: true,
    })

  return json(
    {
      error:
        "Esta resposta já teve uma tentativa de envio e não será repetida automaticamente.",

      messageId: existing.id,
    },

    409,
  )
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

  _assignmentRevision?: number,

  aiReplyKey?: string,
) {
  if (aiReplyKey && auth.role !== "ai")
    return json({ error: "Chave de idempotência reservada à IA." }, 403)

  if (
    !(await aiAssignmentValid(
      env,

      auth.role,

      auth.organizationId,

      conversationId,
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

  const priorReply = await existingAiReply(
    env,

    auth.organizationId,

    aiReplyKey,
  )

  if (priorReply) return priorReply

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

  const filename = (file.name || `arquivo.${mime.split("/")[1] ?? "bin"}`)

    .slice(0, 255)

  const label = {
    image: "[Imagem]",

    video: "[Vídeo]",

    audio: "[Áudio]",

    document: filename,
  }[kind]!

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages(
      id,organization_id,conversation_id,direction,type,body,status,sent_by,
      media_filename,media_mime,is_ai,origin,ai_reply_key
    ) VALUES(?,?,?,'outbound',?,?,'queued',?,?,?,?,'business_api',?)`,
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

      aiReplyKey ?? null,
    )

    .run()

  if (!inserted.meta.changes) {
    const prior = await existingAiReply(
      env,

      auth.organizationId,

      aiReplyKey,
    )

    return prior ?? json({ error: "A mensagem já foi registrada." }, 409)
  }

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

    const base = `${env.GRAPH_API_BASE ?? "https://graph.facebook.com"}/${graphVersion(env)}`

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

        auth.role,

        auth.organizationId,

        conversationId,
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
      "UPDATE conversations SET last_message_at=?,human_requested_at=CASE WHEN ? THEN NULL ELSE human_requested_at END,ai_state=CASE WHEN ? THEN 'HUMANO' ELSE ai_state END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(
      new Date().toISOString(),

      auth.role === "ai" ? 0 : 1,

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

  options: {
    talkButton?: boolean

    assignmentRevision?: number

    aiReplyKey?: string
  } = {},
) {
  if (options.aiReplyKey && auth.role !== "ai")
    return json({ error: "Chave de idempotência reservada à IA." }, 403)

  if (
    !(await aiAssignmentValid(
      env,

      auth.role,

      auth.organizationId,

      conversationId,
    ))
  )
    return json({ error: "A conversa foi atribuída a outra pessoa." }, 409)

  const body = typeof text === "string" ? text.trim() : ""

  if (!body || body.length > 4096)
    return json(
      { error: "A mensagem deve ter entre 1 e 4096 caracteres." },

      400,
    )

  const priorReply = await existingAiReply(
    env,

    auth.organizationId,

    options.aiReplyKey,
  )

  if (priorReply) return priorReply

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

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages(
      id,organization_id,conversation_id,direction,type,body,status,sent_by,
      is_ai,origin,ai_reply_key
    ) VALUES(?,?,?,'outbound','text',?,'queued',?,?,'business_api',?)`,
  )

    .bind(
      messageId,

      auth.organizationId,

      conversationId,

      body,

      auth.userId || null,

      auth.role === "ai" ? 1 : 0,

      options.aiReplyKey ?? null,
    )

    .run()

  if (!inserted.meta.changes) {
    const prior = await existingAiReply(
      env,

      auth.organizationId,

      options.aiReplyKey,
    )

    return prior ?? json({ error: "A mensagem já foi registrada." }, 409)
  }

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

        auth.role,

        auth.organizationId,

        conversationId,
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
      "UPDATE conversations SET last_message_at=?,human_requested_at=CASE WHEN ? THEN NULL ELSE human_requested_at END,ai_state=CASE WHEN ? THEN 'HUMANO' ELSE ai_state END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(
      new Date().toISOString(),

      auth.role === "ai" ? 0 : 1,

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

  schedule?: (task: Promise<unknown>) => void,
): Promise<Response | null> {
  const path = url.pathname

  const org = auth.organizationId

  if (
    path === "/api/integrations/whatsapp" ||
    path === "/api/integrations/whatsapp/embedded-signup" ||
    path === "/api/integrations/whatsapp/embedded-signup/select-number" ||
    path === "/api/integrations/whatsapp/history-sync" ||
    path === "/api/integrations/whatsapp/resubscribe"
  ) {
    if (path === "/api/integrations/whatsapp" && request.method === "GET") {
      await env.DB.prepare(
        "DELETE FROM whatsapp_pending_signups WHERE organization_id=? AND expires_at<=CURRENT_TIMESTAMP",
      )

        .bind(org)

        .run()

      const integration =
        await env.DB.prepare(`SELECT id,status,phone_number_id phoneNumberId,display_phone_number displayPhoneNumber,connection_mode connectionMode,error_code errorCode,error_summary errorSummary,connected_at connectedAt,
        history_sync_status historySyncStatus,history_sync_progress historySyncProgress,history_sync_error historySyncError,
        history_sync_requested_at historySyncRequestedAt,
        CASE WHEN connected_at>=datetime('now','-24 hours') THEN 1 ELSE 0 END historySyncAvailable
        FROM integrations WHERE organization_id=? AND provider='meta_whatsapp' AND status!='disconnected' ORDER BY created_at DESC LIMIT 1`)

          .bind(org)

          .first()

      const diagnostics =
        auth.role === "admin"
          ? await env.DB.prepare(
              `WITH events AS (
                 SELECT status,error_summary,received_at,event_type
                 FROM webhook_events WHERE organization_id=? AND provider='meta_whatsapp'
               ),
               jobs AS (
                 SELECT status,error_summary,updated_at
                 FROM whatsapp_processing_jobs WHERE organization_id=?
               ),
               wa_messages AS (
                 SELECT direction,status,error_code,referral_json,external_created_at,created_at
                 FROM messages WHERE organization_id=?
               )
               SELECT
                 (SELECT MAX(received_at) FROM events) lastWebhookAt,
                 (SELECT COUNT(*) FROM events WHERE status='failed' AND julianday(received_at)>=julianday('now','-1 day')) failedWebhooks24h,
                 (SELECT COUNT(*) FROM events WHERE status='ignored' AND julianday(received_at)>=julianday('now','-1 day')) ignoredWebhooks24h,
                 (SELECT COUNT(*) FROM events WHERE error_summary IS NOT NULL AND julianday(received_at)>=julianday('now','-1 day')) metaErrors24h,
                 (SELECT COUNT(*) FROM jobs WHERE status='pending') pendingAiJobs,
                 (SELECT COUNT(*) FROM jobs WHERE status='processing') processingAiJobs,
                 (SELECT COUNT(*) FROM jobs WHERE status='failed') failedAiJobs,
                 (SELECT COUNT(*) FROM jobs WHERE status='needs_review') needsReviewAiJobs,
                 (SELECT error_summary FROM jobs WHERE error_summary IS NOT NULL ORDER BY updated_at DESC LIMIT 1) lastAiError,
                 (SELECT COUNT(*) FROM wa_messages WHERE direction='inbound' AND error_code='131060'
                   AND julianday(COALESCE(external_created_at,created_at))>=julianday('now','-1 day')) unavailableMessages24h,
                 (SELECT COUNT(*) FROM wa_messages WHERE referral_json IS NOT NULL
                   AND julianday(COALESCE(external_created_at,created_at))>=julianday('now','-1 day')) adReferralMessages24h,
                 (SELECT COUNT(*) FROM wa_messages WHERE direction='outbound' AND status='failed'
                   AND julianday(COALESCE(external_created_at,created_at))>=julianday('now','-1 day')) failedSends24h`,
            )

              .bind(org, org, org)

              .first()
          : null

      const recentEvents =
        auth.role === "admin"
          ? (
              await env.DB.prepare(
                `SELECT event_type eventType,status,error_summary errorSummary,received_at receivedAt
                 FROM webhook_events WHERE organization_id=? AND provider='meta_whatsapp'
                 ORDER BY received_at DESC LIMIT 8`,
              )

                .bind(org)

                .all()
            ).results
          : undefined

      return json({
        integration: integration ?? null,

        diagnostics: diagnostics && {
            ...diagnostics,

            recentEvents,
          },

        webhookUrl: `${new URL(env.APP_ORIGIN).origin}/api/webhooks/meta`,

        embeddedSignup: {
          appId: env.META_APP_ID ?? null,

          configId: env.META_CONFIG_ID ?? null,

          graphApiVersion: graphVersion(env),

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
      path === "/api/integrations/whatsapp/resubscribe" &&
      request.method === "POST"
    ) {
      const integration = await env.DB.prepare(
        `SELECT id,external_account_id wabaId,access_token_enc accessTokenEnc,status,error_code errorCode
         FROM integrations
         WHERE organization_id=? AND provider='meta_whatsapp'
           AND status IN ('connected','error')
         ORDER BY created_at DESC LIMIT 1`,
      )

        .bind(org)

        .first<{
          id: string

          wabaId: string | null

          accessTokenEnc: string | null

          status: string

          errorCode: string | null
        }>()

      if (!integration?.wabaId || !integration.accessTokenEnc)
        return json({ error: "Integração WhatsApp não encontrada." }, 404)

      if (
        integration.status === "error" &&
        integration.errorCode !== "webhook_subscription"
      )
        return json(
          {
            error:
              "Corrija o erro atual da integração antes de verificar a assinatura do webhook.",
          },

          409,
        )

      const result = await subscribeWaba(
        env,

        org,

        integration.id,

        integration.wabaId,

        await decryptToken(env, integration.accessTokenEnc),
      )

      return json(result, result.subscribed ? 200 : 502)
    }

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
      await env.DB.prepare(`SELECT c.id,c.unread_count unread,c.last_message_at lastMessageAt,c.human_requested_at humanRequestedAt,c.priority priority,c.assigned_to assignedTo,c.ai_state aiState,ct.name,ct.phone_e164 phone,
      l.id leadId,${effectiveLeadStatus("l")} leadStatus,l.product_interest productInterest,l.next_action nextAction,
      l.follow_up_at followUpAt,l.notes leadNotes,l.loss_reason lossReason,l.ai_score aiScore,l.ai_summary aiSummary,
      (SELECT m.body FROM messages m WHERE m.conversation_id=c.id AND m.organization_id=c.organization_id ORDER BY COALESCE(m.external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',m.created_at)) DESC,m.rowid DESC LIMIT 1) preview,
      (SELECT m.type FROM messages m WHERE m.conversation_id=c.id AND m.organization_id=c.organization_id ORDER BY COALESCE(m.external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',m.created_at)) DESC,m.rowid DESC LIMIT 1) previewType
      FROM conversations c JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
      LEFT JOIN leads l ON l.contact_id=ct.id AND l.organization_id=c.organization_id
      WHERE c.organization_id=? ORDER BY
        c.priority DESC,
        (c.human_requested_at IS NOT NULL) DESC,
        (leadStatus='hot') DESC,
        c.last_message_at DESC LIMIT 200`)

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

      .first<{ conversationId: string; status: string }>()

    if (!message) return json({ error: "Mensagem não encontrada." }, 404)

    if (message.status === "queued")
      return json(
        { error: "Aguarde o envio da mensagem antes de excluí-la." },

        409,
      )

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO deleted_whatsapp_messages(organization_id,external_id,conversation_id,direction,external_created_at,content_available,created_at)
         SELECT organization_id,external_id,conversation_id,direction,external_created_at,content_available,created_at FROM messages WHERE id=? AND organization_id=? AND external_id IS NOT NULL`,
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
      `SELECT c.id, EXISTS(SELECT 1 FROM messages m
         WHERE m.organization_id=c.organization_id AND m.conversation_id=c.id
           AND m.status='queued' AND m.created_at>=datetime('now','-5 minutes')) queued,
       (c.ai_reply_lock IS NOT NULL AND c.ai_reply_lock_until>CURRENT_TIMESTAMP) aiBusy
       FROM conversations c WHERE c.id=? AND c.organization_id=?`,
    )

      .bind(conversationDelete[1], org)

      .first<{ id: string; queued: number; aiBusy: number }>()

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
        `INSERT OR IGNORE INTO deleted_whatsapp_messages(organization_id,external_id,conversation_id,direction,external_created_at,content_available,created_at)
         SELECT organization_id,external_id,conversation_id,direction,external_created_at,content_available,created_at FROM messages
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
    /^\/api\/conversations\/([\w-]+)\/(messages|read|unread|attachments|assignment|human-request|priority)$/,
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

  if (match[2] === "priority" && request.method === "POST") {
    const body = await request.json<{ priority?: unknown }>().catch(() => ({}))
    if (typeof body.priority !== "boolean")
      return json({ error: "Informe se a conversa deve ter prioridade." }, 400)

    await env.DB.prepare(
      "UPDATE conversations SET priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(body.priority ? 1 : 0, conversationId, org)
      .run()

    return json({ ok: true, priority: body.priority })
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
        `UPDATE conversations SET assigned_to=?,ai_state=CASE WHEN ? IS NULL THEN 'IA_ATIVA' ELSE ai_state END,
         assignment_revision=assignment_revision+1,
         ai_resumed_at=CASE WHEN ? IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE ai_resumed_at END,
         human_requested_at=CASE WHEN ? IS NULL THEN NULL ELSE human_requested_at END,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=?`,
      ).bind(
        body.assignedTo,

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
          const inboundExternalId = pending.externalId

          const jobId = uid()

          await env.DB.prepare(
            `INSERT OR IGNORE INTO whatsapp_processing_jobs(
               id,organization_id,conversation_id,inbound_external_id
             ) VALUES(?,?,?,?)`,
          )

            .bind(jobId, org, conversationId, inboundExternalId)

            .run()

          const job = await env.DB.prepare(
            `SELECT id,status,(status='processing' AND locked_until>CURRENT_TIMESTAMP) active
             FROM whatsapp_processing_jobs
             WHERE organization_id=? AND inbound_external_id=?`,
          )

            .bind(org, inboundExternalId)

            .first<{ id: string; status: string; active: number }>()

          if (!job)
            throw new Error(
              "Não foi possível criar o processamento da mensagem.",
            )

          if (!job.active) {
            await env.DB.prepare(
              `UPDATE whatsapp_processing_jobs SET status='pending',attempts=0,
                 next_attempt_at=CURRENT_TIMESTAMP,locked_until=NULL,error_summary=NULL,
                 updated_at=CURRENT_TIMESTAMP
               WHERE id=? AND (status<>'processing' OR locked_until<=CURRENT_TIMESTAMP)`,
            )

              .bind(job.id)

              .run()

            const task = processWhatsAppJob(env, job.id)

            if (schedule) schedule(task)
            else await task
          }

          return json({
            ok: true,

            notice: job.active
              ? "A IA já está processando a mensagem pendente."
              : "A mensagem pendente foi colocada na fila de resposta da IA.",
          })
        } catch (error) {
          console.error(
            "ai_resume_enqueue_failed",

            error instanceof Error ? error.message : "unknown",
          )

          return json({
            ok: true,

            warning:
              "A conversa foi devolvida à IA, mas não foi possível colocar a mensagem pendente na fila.",
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
      await env.DB.prepare(`SELECT id,direction,type,body,status,error_code errorCode,error_message errorMessage,origin,referral_json referralJson,media_id IS NOT NULL hasMedia,media_filename mediaFilename,media_mime mediaMime,COALESCE(external_created_at,strftime('%Y-%m-%dT%H:%M:%fZ',created_at)) at
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
