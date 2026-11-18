import type { Env, Session } from "./index"

import { decryptToken, encryptToken } from "./whatsapp"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,

    headers: { "content-type": "application/json" },
  })

const uid = () => crypto.randomUUID()

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1"

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",

  "https://www.googleapis.com/auth/gmail.send",
].join(" ")

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function googleRedirectUri(env: Env) {
  return (
    env.GOOGLE_REDIRECT_URI ??
    new URL("/api/gmail/callback", env.APP_ORIGIN).toString()
  )
}

function redirectToApp(env: Env, result: "connected" | "error") {
  const url = new URL("/", env.APP_ORIGIN)

  url.searchParams.set("gmail", result)

  return Response.redirect(url, 303)
}

type GmailAccount = {
  organizationId: string

  email: string

  accessTokenEnc: string

  refreshTokenEnc: string

  tokenExpiresAt: string

  historyId: string | null

  historyPageToken: string | null

  initialSyncDone: number

  initialSyncPageToken: string | null

  status: string

  errorSummary: string | null

  lastSyncedAt: string | null
}

type GoogleTokenResponse = {
  access_token?: string

  refresh_token?: string

  expires_in?: number

  scope?: string

  error?: string

  error_description?: string
}

async function accountForOrganization(env: Env, organizationId: string) {
  return env.DB.prepare(
    `SELECT organization_id organizationId,email,access_token_enc accessTokenEnc,
       refresh_token_enc refreshTokenEnc,token_expires_at tokenExpiresAt,
       history_id historyId,history_page_token historyPageToken,
       initial_sync_done initialSyncDone,initial_sync_page_token initialSyncPageToken,
       status,error_summary errorSummary,last_synced_at lastSyncedAt
     FROM gmail_accounts WHERE organization_id=?`,
  )

    .bind(organizationId)

    .first<GmailAccount>()
}

async function refreshAccessToken(env: Env, account: GmailAccount) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    throw new Error("Gmail OAuth não está configurado no Worker.")

  const refreshToken = await decryptToken(env, account.refreshTokenEnc)

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",

    headers: { "content-type": "application/x-www-form-urlencoded" },

    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,

      client_secret: env.GOOGLE_CLIENT_SECRET,

      refresh_token: refreshToken,

      grant_type: "refresh_token",
    }),
  })

  const data = (await response.json().catch(() => ({}))) as GoogleTokenResponse

  if (!response.ok || !data.access_token) {
    const message =
      data.error === "invalid_grant"
        ? "A autorização do Gmail expirou. Desconecte e conecte a conta novamente."
        : `Falha ao renovar o token do Gmail (${response.status}).`

    await env.DB.prepare(
      `UPDATE gmail_accounts SET status='error',error_summary=?,
       updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`,
    )

      .bind(message, account.organizationId)

      .run()

    throw new Error(message)
  }

  const expiresAt = new Date(
    Date.now() + Math.max(60, data.expires_in ?? 3600) * 1000,
  ).toISOString()

  await env.DB.prepare(
    `UPDATE gmail_accounts SET access_token_enc=?,token_expires_at=?,
     status='connected',error_summary=NULL,updated_at=CURRENT_TIMESTAMP
     WHERE organization_id=?`,
  )

    .bind(
      await encryptToken(env, data.access_token),

      expiresAt,

      account.organizationId,
    )

    .run()

  return data.access_token
}

async function accessToken(env: Env, account: GmailAccount) {
  if (account.status !== "connected")
    throw new Error("A conta Gmail não está conectada.")

  if (Date.parse(account.tokenExpiresAt) <= Date.now() + 60_000)
    return refreshAccessToken(env, account)

  return decryptToken(env, account.accessTokenEnc)
}

async function gmailFetch(
  env: Env,

  account: GmailAccount,

  path: string,

  init: RequestInit = {},
) {
  const token = await accessToken(env, account)

  let response = await fetch(`${GMAIL_API}${path}`, {
    ...init,

    headers: {
      ...(init.headers ?? {}),

      authorization: `Bearer ${token}`,

      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  })

  if (response.status === 401) {
    const refreshed = await refreshAccessToken(env, account)

    response = await fetch(`${GMAIL_API}${path}`, {
      ...init,

      headers: {
        ...(init.headers ?? {}),

        authorization: `Bearer ${refreshed}`,

        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    })
  }

  return response
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")

  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)

  const binary = atob(padded)

  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  )
}

type GmailPart = {
  mimeType?: string

  body?: { data?: string }

  parts?: GmailPart[]
}

function collectBody(part: GmailPart): { plain: string; html: string } {
  let plain = ""

  let html = ""

  if (part.mimeType === "text/plain" && part.body?.data)
    plain += decodeBase64Url(part.body.data)
  else if (part.mimeType === "text/html" && part.body?.data)
    html += decodeBase64Url(part.body.data)

  for (const child of part.parts ?? []) {
    const nested = collectBody(child)

    if (!plain) plain = nested.plain

    if (!html) html = nested.html
  }

  return { plain, html }
}

function cleanHtml(html: string) {
  return html

    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")

    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi, "\n")

    .replace(/<[^>]+>/g, " ")

    .replace(/&nbsp;|&#160;/gi, " ")

    .replace(/&amp;/gi, "&")

    .replace(/&quot;/gi, '"')

    .replace(/&#39;|&apos;/gi, "'")

    .replace(/&lt;/gi, "<")

    .replace(/&gt;/gi, ">")

    .replace(/[ \t]+/g, " ")

    .replace(/\n\s+/g, "\n")

    .trim()
}

function safeHeader(value: string | undefined) {
  return (value ?? "")
    .replace(/[\r\n]/g, " ")
    .trim()
    .slice(0, 1000)
}

function headerValue(
  headers: Array<{ name?: string; value?: string }> | undefined,
  name: string,
) {
  return safeHeader(
    headers?.find((item) => item.name?.toLowerCase() === name.toLowerCase())
      ?.value,
  )
}

function parseAddress(value: string) {
  const match = value.match(/^(.*?)\s*<([^<>]+)>$/)

  if (match) {
    const name = match[1]!.replace(/^["']|["']$/g, "").trim()

    const address = match[2]!.trim()

    return {
      name: name || null,
      address: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : "",
    }
  }

  const address = value.trim()

  return {
    name: null,
    address: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : "",
  }
}

type GmailApiMessage = {
  id: string

  threadId: string

  internalDate?: string

  labelIds?: string[]

  snippet?: string

  payload?: GmailPart & {
    headers?: Array<{ name?: string; value?: string }>
  }
}

async function importMessage(
  env: Env,

  account: GmailAccount,

  messageId: string,
) {
  const existing = await env.DB.prepare(
    "SELECT 1 FROM email_messages WHERE organization_id=? AND gmail_message_id=?",
  )

    .bind(account.organizationId, messageId)

    .first()

  if (existing) return

  const response = await gmailFetch(
    env,

    account,

    `/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
  )

  if (!response.ok)
    throw new Error(`Falha ao ler mensagem Gmail (${response.status}).`)

  const message = (await response.json()) as GmailApiMessage

  const headers = message.payload?.headers

  const from = parseAddress(headerValue(headers, "From"))

  const to = parseAddress(headerValue(headers, "To"))

  if (!from.address) return

  const subject = headerValue(headers, "Subject")

  const bodyParts = collectBody(message.payload ?? {})

  const body = (
    bodyParts.plain ||
    cleanHtml(bodyParts.html) ||
    message.snippet ||
    ""
  )

    .replace(/\u0000/g, "")

    .slice(0, 40_000)

  const direction =
    from.address.toLowerCase() === account.email.toLowerCase()
      ? "outbound"
      : "inbound"

  const createdAt = new Date(
    message.internalDate ? Number(message.internalDate) : Date.now(),
  )

    .toISOString()

    .replace("T", " ")

    .replace(/\.\d{3}Z$/, "")

  const initialUnread =
    direction === "inbound" && message.labelIds?.includes("UNREAD") ? 1 : 0

  await env.DB.prepare(
    `INSERT OR IGNORE INTO email_threads(
       id,organization_id,gmail_thread_id,subject,from_name,from_address,
       snippet,last_message_at,unread_count
     ) VALUES(?,?,?,?,?,?,?,?,?)`,
  )

    .bind(
      uid(),

      account.organizationId,

      message.threadId,

      subject,

      from.name,

      from.address,

      (message.snippet ?? body).slice(0, 500),

      createdAt,

      0,
    )

    .run()

  const thread = await env.DB.prepare(
    `SELECT id FROM email_threads WHERE organization_id=? AND gmail_thread_id=?`,
  )

    .bind(account.organizationId, message.threadId)

    .first<{ id: string }>()

  if (!thread) throw new Error("Não foi possível registrar a conversa Gmail.")

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO email_messages(
       id,organization_id,thread_id,gmail_message_id,direction,from_address,
       to_address,subject,body,rfc_message_id,in_reply_to,status,created_at
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )

    .bind(
      uid(),

      account.organizationId,

      thread.id,

      message.id,

      direction,

      from.address,

      to.address || account.email,

      subject,

      body,

      headerValue(headers, "Message-ID"),

      headerValue(headers, "In-Reply-To"),

      "received",

      createdAt,
    )

    .run()

  if (inserted.meta.changes) {
    await env.DB.prepare(
      `UPDATE email_threads SET
         subject=CASE WHEN ?='' THEN subject ELSE ? END,
         from_name=CASE WHEN ?='inbound' THEN ? ELSE from_name END,
         from_address=CASE WHEN ?='inbound' THEN ? ELSE from_address END,
         snippet=?,last_message_at=MAX(last_message_at,?),
         unread_count=unread_count+?,status='open',updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=?`,
    )

      .bind(
        subject,

        subject,

        direction,

        from.name,

        direction,

        from.address,

        (message.snippet ?? body).slice(0, 500),

        createdAt,

        initialUnread,

        thread.id,

        account.organizationId,
      )

      .run()
  }
}

async function listInitialPage(
  env: Env,

  account: GmailAccount,
) {
  const params = new URLSearchParams({
    userId: "me",

    q: "in:inbox",

    maxResults: "20",
  })

  if (account.initialSyncPageToken)
    params.set("pageToken", account.initialSyncPageToken)

  const response = await gmailFetch(
    env,

    account,

    `/users/me/messages?${params.toString()}`,
  )

  if (!response.ok)
    throw new Error(`Falha ao listar mensagens Gmail (${response.status}).`)

  const result = (await response.json()) as {
    messages?: Array<{ id: string }>

    nextPageToken?: string
  }

  const messages = result.messages ?? []

  for (let index = 0; index < messages.length; index += 5) {
    await Promise.all(
      messages
        .slice(index, index + 5)
        .map((message) => importMessage(env, account, message.id)),
    )
  }

  if (result.nextPageToken) {
    await env.DB.prepare(
      `UPDATE gmail_accounts SET initial_sync_page_token=?,
       last_synced_at=CURRENT_TIMESTAMP WHERE organization_id=?`,
    )

      .bind(result.nextPageToken, account.organizationId)

      .run()
  } else {
    await env.DB.prepare(
      `UPDATE gmail_accounts SET initial_sync_done=1,initial_sync_page_token=NULL,
       last_synced_at=CURRENT_TIMESTAMP,status='connected',error_summary=NULL
       WHERE organization_id=?`,
    )

      .bind(account.organizationId)

      .run()
  }
}

async function syncHistory(env: Env, account: GmailAccount) {
  if (!account.historyId) {
    await env.DB.prepare(
      `UPDATE gmail_accounts SET initial_sync_done=0,initial_sync_page_token=NULL
       WHERE organization_id=?`,
    )

      .bind(account.organizationId)

      .run()

    return
  }

  const params = new URLSearchParams({
    userId: "me",

    startHistoryId: account.historyId,

    historyTypes: "messageAdded",

    maxResults: "100",
  })

  if (account.historyPageToken)
    params.set("pageToken", account.historyPageToken)

  const response = await gmailFetch(
    env,

    account,

    `/users/me/history?${params.toString()}`,
  )

  if (response.status === 404) {
    const profileResponse = await gmailFetch(env, account, "/users/me/profile")

    if (!profileResponse.ok)
      throw new Error(
        `Falha ao reiniciar a sincronização Gmail (${profileResponse.status}).`,
      )

    const profile = (await profileResponse.json()) as { historyId?: string }

    await env.DB.prepare(
      `UPDATE gmail_accounts SET history_id=?,history_page_token=NULL,
       initial_sync_done=0,initial_sync_page_token=NULL
       WHERE organization_id=?`,
    )

      .bind(profile.historyId ?? null, account.organizationId)

      .run()

    return
  }

  if (!response.ok)
    throw new Error(`Falha ao sincronizar Gmail (${response.status}).`)

  const result = (await response.json()) as {
    historyId?: string

    nextPageToken?: string

    history?: Array<{
      messagesAdded?: Array<{ message?: { id?: string; labelIds?: string[] } }>
    }>
  }

  const ids = new Set<string>()

  for (const history of result.history ?? [])
    for (const item of history.messagesAdded ?? [])
      if (item.message?.id && item.message.labelIds?.includes("INBOX"))
        ids.add(item.message.id)

  for (const id of ids) await importMessage(env, account, id)

  await env.DB.prepare(
    `UPDATE gmail_accounts SET history_id=?,history_page_token=?,
     last_synced_at=CURRENT_TIMESTAMP,status='connected',error_summary=NULL
     WHERE organization_id=?`,
  )

    .bind(
      result.nextPageToken
        ? account.historyId
        : (result.historyId ?? account.historyId),

      result.nextPageToken ?? null,

      account.organizationId,
    )

    .run()
}

async function syncAccount(env: Env, account: GmailAccount) {
  if (account.status !== "connected") return

  if (!account.initialSyncDone) await listInitialPage(env, account)
  else await syncHistory(env, account)
}

export async function syncAllGmailAccounts(env: Env) {
  const accounts = await env.DB.prepare(
    `SELECT organization_id organizationId,email,access_token_enc accessTokenEnc,
       refresh_token_enc refreshTokenEnc,token_expires_at tokenExpiresAt,
       history_id historyId,history_page_token historyPageToken,
       initial_sync_done initialSyncDone,initial_sync_page_token initialSyncPageToken,
       status,error_summary errorSummary,last_synced_at lastSyncedAt
     FROM gmail_accounts WHERE status='connected'
     ORDER BY last_synced_at,RANDOM() LIMIT 20`,
  )

    .all<GmailAccount>()

  for (const account of accounts.results) {
    try {
      await syncAccount(env, account)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message.slice(0, 300)
          : "Erro desconhecido"

      console.error("gmail_sync_failed", {
        organizationId: account.organizationId,

        error: message,
      })

      if (/autorização do Gmail|não está configurado/i.test(message))
        await env.DB.prepare(
          `UPDATE gmail_accounts SET status='error',error_summary=?,
           updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`,
        )

          .bind(message, account.organizationId)

          .run()
    }
  }
}

export async function gmailOAuthCallback(
  request: Request,

  env: Env,

  url: URL,
) {
  if (url.pathname !== "/api/gmail/callback" || request.method !== "GET")
    return null

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
    return redirectToApp(env, "error")

  const code = url.searchParams.get("code")

  const state = url.searchParams.get("state")

  if (!code || !state) return redirectToApp(env, "error")

  try {
    const savedState = await env.DB.prepare(
      `SELECT organization_id organizationId,user_id userId
       FROM gmail_oauth_states WHERE state_hash=? AND expires_at>CURRENT_TIMESTAMP`,
    )

      .bind(await sha256(state))

      .first<{ organizationId: string; userId: string }>()

    if (!savedState) return redirectToApp(env, "error")

    await env.DB.prepare(
      "DELETE FROM gmail_oauth_states WHERE state_hash=?",
    )

      .bind(await sha256(state))

      .run()

    const member = await env.DB.prepare(
      `SELECT 1 FROM organization_members
       WHERE organization_id=? AND user_id=? AND status='active'`,
    )

      .bind(savedState.organizationId, savedState.userId)

      .first()

    if (!member) return redirectToApp(env, "error")

    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",

      headers: { "content-type": "application/x-www-form-urlencoded" },

      body: new URLSearchParams({
        code,

        client_id: env.GOOGLE_CLIENT_ID,

        client_secret: env.GOOGLE_CLIENT_SECRET,

        redirect_uri: googleRedirectUri(env),

        grant_type: "authorization_code",
      }),
    })

    const token = (await tokenResponse
      .json()
      .catch(() => ({}))) as GoogleTokenResponse

    if (!tokenResponse.ok || !token.access_token)
      throw new Error(`Google OAuth respondeu ${tokenResponse.status}.`)

    if (
      token.scope &&
      GMAIL_SCOPES.split(" ").some(
        (scope) => !token.scope!.split(" ").includes(scope),
      )
    )
      throw new Error(
        "A conta Google não concedeu as permissões de leitura e envio do Gmail.",
      )

    const current = await accountForOrganization(env, savedState.organizationId)

    const refreshToken = token.refresh_token
      ? await encryptToken(env, token.refresh_token)
      : current?.refreshTokenEnc

    if (!refreshToken)
      throw new Error(
        "Google não retornou autorização offline para esta conta.",
      )

    const accessTokenEnc = await encryptToken(env, token.access_token)

    const profileResponse = await fetch(`${GMAIL_API}/users/me/profile`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    })

    if (!profileResponse.ok)
      throw new Error(
        `Não foi possível verificar a conta Gmail (${profileResponse.status}).`,
      )

    const profile = (await profileResponse.json()) as {
      emailAddress?: string

      historyId?: string
    }

    const email = profile.emailAddress?.trim().toLowerCase()

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error("Google não retornou um endereço de e-mail válido.")

    const expiresAt = new Date(
      Date.now() + Math.max(60, token.expires_in ?? 3600) * 1000,
    ).toISOString()

    await env.DB.prepare(
      `INSERT INTO gmail_accounts(
         organization_id,email,access_token_enc,refresh_token_enc,token_expires_at,
         history_id,history_page_token,initial_sync_done,initial_sync_page_token,
         status,error_summary,connected_by
       ) VALUES(?,?,?,?,?,?,NULL,0,NULL,'connected',NULL,?)
       ON CONFLICT(organization_id) DO UPDATE SET
         email=excluded.email,access_token_enc=excluded.access_token_enc,
         refresh_token_enc=excluded.refresh_token_enc,
         token_expires_at=excluded.token_expires_at,history_id=excluded.history_id,
         history_page_token=NULL,initial_sync_done=0,initial_sync_page_token=NULL,
         status='connected',error_summary=NULL,connected_by=excluded.connected_by,
         updated_at=CURRENT_TIMESTAMP`,
    )

      .bind(
        savedState.organizationId,

        email,

        accessTokenEnc,

        refreshToken,

        expiresAt,

        profile.historyId ?? null,

        savedState.userId,
      )

      .run()

    return redirectToApp(env, "connected")
  } catch (error) {
    console.error("gmail_oauth_callback_failed", {
      error: error instanceof Error ? error.message : "unknown",
    })

    return redirectToApp(env, "error")
  }
}

export async function gmailRoutes(
  request: Request,

  env: Env,

  url: URL,

  auth: Session,
) {
  if (!url.pathname.startsWith("/api/gmail/")) return null

  const path = url.pathname.slice("/api/gmail".length)

  const org = auth.organizationId

  const canEdit = auth.role === "admin" || auth.role === "manager"

  if (path === "/status" && request.method === "GET") {
    const account = await accountForOrganization(env, org)

    return json({
      configured: !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET,

      connected: account?.status === "connected",

      email: account?.email ?? null,

      status: account?.status ?? "disconnected",

      error: account?.errorSummary ?? null,

      lastSyncedAt: account?.lastSyncedAt ?? null,
    })
  }

  if (path === "/connect" && request.method === "GET") {
    if (!canEdit)
      return json(
        { error: "Apenas administradores e gerentes podem conectar o Gmail." },
        403,
      )

    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET)
      return json(
        {
          error: "Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET no Worker.",
        },
        503,
      )

    if (!env.ENCRYPTION_KEY)
      return json(
        {
          error: "Configure ENCRYPTION_KEY no Worker para proteger os tokens.",
        },
        503,
      )

    const state = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`

    await env.DB.prepare(
      `INSERT INTO gmail_oauth_states(state_hash,organization_id,user_id,expires_at)
       VALUES(?,?,?,datetime('now','+10 minutes'))`,
    )

      .bind(await sha256(state), org, auth.userId)

      .run()

    const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth")

    authorize.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,

      redirect_uri: googleRedirectUri(env),

      response_type: "code",

      scope: GMAIL_SCOPES,

      access_type: "offline",

      prompt: "consent",

      include_granted_scopes: "true",

      state,
    }).toString()

    return Response.redirect(authorize.toString(), 302)
  }

  if (path === "/disconnect" && request.method === "POST") {
    if (!canEdit)
      return json(
        {
          error: "Apenas administradores e gerentes podem desconectar o Gmail.",
        },
        403,
      )

    await env.DB.prepare(
      `UPDATE gmail_accounts SET status='disconnected',access_token_enc='',
       refresh_token_enc='',error_summary=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=?`,
    )

      .bind(org)

      .run()

    return json({ ok: true })
  }

  if (path === "/sync" && request.method === "POST") {
    if (!canEdit)
      return json(
        {
          error:
            "Apenas administradores e gerentes podem iniciar a sincronização.",
        },
        403,
      )

    const account = await accountForOrganization(env, org)

    if (!account || account.status !== "connected")
      return json(
        { error: "Conecte uma conta Gmail antes de sincronizar." },
        409,
      )

    await syncAccount(env, account)

    return json({ ok: true })
  }

  if (path === "/threads" && request.method === "GET")
    return json(
      await env.DB.prepare(
        `SELECT id,subject,from_name fromName,from_address fromAddress,snippet,
           last_message_at lastMessageAt,unread_count unread,status
         FROM email_threads WHERE organization_id=?
         ORDER BY (unread_count>0) DESC,last_message_at DESC LIMIT 200`,
      )

        .bind(org)

        .all(),
    )

  const match = path.match(
    /^\/threads\/([\w-]+)(?:\/(messages|resolve|reopen))?$/,
  )

  if (!match) return json({ error: "Rota do Gmail não encontrada." }, 404)

  const threadId = match[1]!

  const action = match[2] ?? ""

  const thread = await env.DB.prepare(
    "SELECT id,gmail_thread_id gmailThreadId,subject FROM email_threads WHERE id=? AND organization_id=?",
  )

    .bind(threadId, org)

    .first<{ id: string; gmailThreadId: string; subject: string }>()

  if (!thread) return json({ error: "Conversa de e-mail não encontrada." }, 404)

  if (action === "messages" && request.method === "GET") {
    await env.DB.prepare(
      "UPDATE email_threads SET unread_count=0 WHERE id=? AND organization_id=?",
    )

      .bind(threadId, org)

      .run()

    return json(
      await env.DB.prepare(
        `SELECT id,direction,from_address fromAddress,to_address toAddress,
           subject,body,status,sent_by sentBy,created_at createdAt
         FROM email_messages WHERE organization_id=? AND thread_id=?
         ORDER BY created_at LIMIT 500`,
      )

        .bind(org, threadId)

        .all(),
    )
  }

  if (action === "resolve" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE email_threads SET status='resolved',unread_count=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )

      .bind(threadId, org)

      .run()

    return json({ ok: true })
  }

  if (action === "reopen" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE email_threads SET status='open',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )

      .bind(threadId, org)

      .run()

    return json({ ok: true })
  }

  if ((!action || action === "messages") && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>()

    const text = typeof body.body === "string" ? body.body.trim() : ""

    if (!text || text.length > 10_000)
      return json(
        { error: "A resposta deve ter entre 1 e 10.000 caracteres." },
        400,
      )

    const account = await accountForOrganization(env, org)

    if (!account || account.status !== "connected")
      return json({ error: "A conta Gmail não está conectada." }, 409)

    const inbound = await env.DB.prepare(
      `SELECT gmail_message_id gmailMessageId,rfc_message_id rfcMessageId,
         from_address fromAddress,subject FROM email_messages
       WHERE organization_id=? AND thread_id=? AND direction='inbound'
       ORDER BY created_at DESC LIMIT 1`,
    )

      .bind(org, threadId)

      .first<{
        gmailMessageId: string

        rfcMessageId: string | null

        fromAddress: string

        subject: string
      }>()

    if (!inbound)
      return json(
        { error: "Não há uma mensagem recebida para responder." },
        409,
      )

    const accountEmail = account.email

    const subject = safeHeader(inbound.subject).startsWith("Re:")
      ? safeHeader(inbound.subject)
      : `Re: ${safeHeader(inbound.subject)}`

    const rfcId = safeHeader(inbound.rfcMessageId)

    const mime = [
      `From: ${accountEmail}`,

      `To: ${safeHeader(inbound.fromAddress)}`,

      `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,

      ...(rfcId ? [`In-Reply-To: ${rfcId}`, `References: ${rfcId}`] : []),

      "MIME-Version: 1.0",

      "Content-Type: text/plain; charset=UTF-8",

      "Content-Transfer-Encoding: 8bit",

      "",

      text,
    ].join("\r\n")

    const raw = btoa(unescape(encodeURIComponent(mime)))

      .replace(/\+/g, "-")

      .replace(/\//g, "_")

      .replace(/=+$/g, "")

    const response = await gmailFetch(
      env,

      account,

      "/users/me/messages/send",

      {
        method: "POST",

        body: JSON.stringify({ raw, threadId: thread.gmailThreadId }),
      },
    )

    if (!response.ok) {
      console.error("gmail_send_failed", {
        organizationId: org,

        status: response.status,
      })

      return json(
        { error: `O Gmail recusou o envio (${response.status}).` },
        502,
      )
    }

    const result = (await response.json()) as { id: string; threadId: string }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO email_messages(
           id,organization_id,thread_id,gmail_message_id,direction,from_address,
           to_address,subject,body,status,sent_by,created_at
         ) VALUES(?,?,?,?,'outbound',?,?,?,?, 'accepted',?,CURRENT_TIMESTAMP)`,
      ).bind(
        uid(),

        org,

        threadId,

        result.id,

        accountEmail,

        inbound.fromAddress,

        subject,

        text,

        auth.userId,
      ),

      env.DB.prepare(
        `UPDATE email_threads SET last_message_at=CURRENT_TIMESTAMP,
         snippet=?,unread_count=0,status='open',updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=?`,
      ).bind(text.slice(0, 500), threadId, org),
    ])

    return json({ ok: true }, 201)
  }

  return json({ error: "Método ou ação não suportada." }, 405)
}
