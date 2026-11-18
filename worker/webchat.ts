import type { Env, Session } from "./index"
import { replyToWebchat } from "./ai"

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const uid = () => crypto.randomUUID()

async function hash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function parseDomains(value: string | null) {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]")
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

function hostForOrigin(origin: string) {
  try {
    const url = new URL(origin)
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password)
      return null
    const host = url.hostname.toLowerCase()
    const local =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "[::1]"
    if (!local && url.protocol !== "https:") return null
    if (local) return host
    if (!host.includes(".") || host.includes("*")) return null
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null
    return host
  } catch {
    return null
  }
}

type WidgetSettings = {
  organizationId: string
  publicKey: string
  enabled: number
  displayName: string
  color: string
  welcomeMessage: string
  allowedDomains: string[]
}

async function findWidget(env: Env, publicKey: string) {
  const row = await env.DB.prepare(
    `SELECT organization_id organizationId,public_key publicKey,enabled,
       display_name displayName,color,welcome_message welcomeMessage,
       allowed_domains_json allowedDomainsJson
     FROM webchat_settings WHERE public_key=?`,
  )
    .bind(publicKey)
    .first<Omit<WidgetSettings, "allowedDomains"> & { allowedDomainsJson: string }>()
  if (!row) return null
  return {
    ...row,
    allowedDomains: parseDomains(row.allowedDomainsJson),
  } satisfies WidgetSettings
}

function originAllowed(settings: WidgetSettings, origin: string | null) {
  if (!origin) return false
  const host = hostForOrigin(origin)
  return !!host && settings.allowedDomains.includes(host)
}

function corsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Authorization,Content-Type",
    "access-control-max-age": "600",
    vary: "Origin",
  }
}

async function createSession(
  env: Env,
  settings: WidgetSettings,
  origin: string,
  body: Record<string, unknown>,
) {
  const token = `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`
  const sessionId = uid()
  await env.DB.prepare(
    `INSERT INTO webchat_sessions(
       id,organization_id,public_key,visitor_token_hash,visitor_name,
       visitor_email,origin_domain,expires_at
     ) VALUES(?,?,?,?,?,?,?,datetime('now','+30 days'))`,
  )
    .bind(
      sessionId,
      settings.organizationId,
      settings.publicKey,
      await hash(token),
      typeof body.name === "string" ? body.name.trim().slice(0, 120) || null : null,
      typeof body.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)
        ? body.email.trim().slice(0, 160)
        : null,
      hostForOrigin(origin),
    )
    .run()
  return { token, sessionId }
}

async function findSession(
  env: Env,
  settings: WidgetSettings,
  origin: string,
  token: string,
) {
  return env.DB.prepare(
    `SELECT id,organization_id organizationId,ai_state aiState,status
     FROM webchat_sessions WHERE organization_id=? AND public_key=?
       AND visitor_token_hash=? AND origin_domain=? AND expires_at>CURRENT_TIMESTAMP`,
  )
    .bind(
      settings.organizationId,
      settings.publicKey,
      await hash(token),
      hostForOrigin(origin),
    )
    .first<{
      id: string
      organizationId: string
      aiState: string
      status: string
    }>()
}

function bearer(request: Request) {
  return request.headers.get("authorization")?.match(/^Bearer ([\w-]+)$/)?.[1] ?? ""
}

export async function webchatPublicRoutes(
  request: Request,
  env: Env,
  url: URL,
  schedule: (task: Promise<unknown>) => void,
) {
  if (!url.pathname.startsWith("/api/widget/public/")) return null
  const origin = request.headers.get("origin")
  const publicKey =
    url.searchParams.get("key") ??
    (request.method === "POST"
      ? await request.clone().json<Record<string, unknown>>().then((body) =>
          typeof body.key === "string" ? body.key : "",
        ).catch(() => "")
      : "")
  const settings = publicKey ? await findWidget(env, publicKey) : null
  if (!settings || !originAllowed(settings, origin))
    return json({ error: "Widget não permitido para esta origem." }, 403)
  const cors = corsHeaders(origin!)
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors })
  if (!settings.enabled) return json({ error: "O chat do site está desativado." }, 404, cors)

  const route = url.pathname.slice("/api/widget/public/".length)
  if (route === "config" && request.method === "GET")
    return json(
      {
        displayName: settings.displayName,
        color: settings.color,
        welcomeMessage: settings.welcomeMessage,
      },
      200,
      cors,
    )

  if (route === "session" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>()
    const created = await createSession(env, settings, origin!, body)
    return json(created, 201, cors)
  }

  if (route === "messages" && request.method === "GET") {
    const session = await findSession(env, settings, origin!, bearer(request))
    if (!session) return json({ error: "Sessão expirada. Reabra o chat." }, 401, cors)
    const messages = await env.DB.prepare(
      `SELECT id,direction,body,status,created_at createdAt
       FROM webchat_messages WHERE organization_id=? AND session_id=?
       ORDER BY created_at DESC LIMIT 60`,
    )
      .bind(settings.organizationId, session.id)
      .all()
    return json({ messages: messages.results.reverse() }, 200, cors)
  }

  if (route === "messages" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>()
    const session = await findSession(
      env,
      settings,
      origin!,
      bearer(request),
    )
    if (!session) return json({ error: "Sessão expirada. Reabra o chat." }, 401, cors)
    const text = typeof body.text === "string" ? body.text.trim() : ""
    if (!text || text.length > 4000)
      return json({ error: "A mensagem deve ter entre 1 e 4.000 caracteres." }, 400, cors)
    if (session.status === "resolved")
      return json({ error: "Esta conversa foi encerrada. Inicie um novo chat." }, 409, cors)
    const count = await env.DB.prepare(
      `SELECT COUNT(*) count FROM webchat_messages
       WHERE organization_id=? AND session_id=? AND direction='customer'
         AND created_at>=datetime('now','-1 minute')`,
    )
      .bind(settings.organizationId, session.id)
      .first<{ count: number }>()
    if ((count?.count ?? 0) >= 8)
      return json({ error: "Aguarde um momento antes de enviar outra mensagem." }, 429, cors)

    const messageId = uid()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webchat_messages(
           id,organization_id,session_id,direction,body,status
         ) VALUES(?,?,?,'customer',?,'received')`,
      ).bind(messageId, settings.organizationId, session.id, text),
      env.DB.prepare(
        `UPDATE webchat_sessions SET last_message_at=CURRENT_TIMESTAMP,
         unread_count=unread_count+1,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=?`,
      ).bind(session.id, settings.organizationId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO webchat_jobs(
           id,organization_id,session_id,inbound_message_id
         )
         SELECT ?,?,?,? WHERE EXISTS (
           SELECT 1 FROM ai_settings WHERE organization_id=? AND enabled=1
         )`,
      ).bind(messageId, settings.organizationId, session.id, messageId, settings.organizationId),
    ])
    if (env.OPENAI_API_KEY)
      schedule(processWebchatJob(env, messageId))
    return json({ ok: true, id: messageId }, 201, cors)
  }

  return json({ error: "Rota do widget não encontrada." }, 404, cors)
}

async function processWebchatJob(env: Env, jobId: string) {
  const claimed = await env.DB.prepare(
    `UPDATE webchat_jobs SET status='processing',attempts=attempts+1,
       locked_until=datetime('now','+3 minutes'),updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND (
       (status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP) OR
       (status='processing' AND locked_until<=CURRENT_TIMESTAMP)
     )`,
  )
    .bind(jobId)
    .run()
  if (!claimed.meta.changes) return
  const job = await env.DB.prepare(
    `SELECT organization_id organizationId,session_id sessionId,
       inbound_message_id inboundMessageId,attempts
     FROM webchat_jobs WHERE id=? AND status='processing'`,
  )
    .bind(jobId)
    .first<{
      organizationId: string
      sessionId: string
      inboundMessageId: string
      attempts: number
    }>()
  if (!job) return
  try {
    await replyToWebchat(
      env,
      job.organizationId,
      job.sessionId,
      job.inboundMessageId,
    )
    await env.DB.prepare(
      `UPDATE webchat_jobs SET status='completed',locked_until=NULL,
       error_summary=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    )
      .bind(jobId)
      .run()
  } catch (error) {
    const summary =
      error instanceof Error ? error.message.slice(0, 300) : "Erro desconhecido"
    const failed = job.attempts >= 5
    await env.DB.prepare(
      `UPDATE webchat_jobs SET status=?,locked_until=NULL,error_summary=?,
       next_attempt_at=datetime('now','+'||?||' seconds'),updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    )
      .bind(failed ? "failed" : "pending", summary, [30, 120, 600, 1800, 3600][Math.min(job.attempts - 1, 4)], jobId)
      .run()
    console.error("webchat_ai_job_failed", {
      organizationId: job.organizationId,
      sessionId: job.sessionId,
      error: summary,
    })
  }
}

export async function processPendingWebchatJobs(env: Env, limit = 10) {
  for (let count = 0; count < limit; count++) {
    const job = await env.DB.prepare(
      `SELECT id FROM webchat_jobs
       WHERE (status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP)
         OR (status='processing' AND locked_until<=CURRENT_TIMESTAMP)
       ORDER BY created_at LIMIT 1`,
    ).first<{ id: string }>()
    if (!job) return
    await processWebchatJob(env, job.id)
  }
}

export async function webchatAssetRoutes(
  request: Request,
  env: Env,
  url: URL,
) {
  if (url.pathname !== "/widget/embed.js" || request.method !== "GET") return null
  const appOrigin = new URL(env.APP_ORIGIN).origin
  const source = `(() => {
  const script = document.currentScript;
  const key = script && script.dataset.key;
  if (!key) return;
  const base = ${JSON.stringify(appOrigin)};
  const api = (path, options = {}) => fetch(base + path, { ...options, headers: { ...(options.headers || {}), "content-type": "application/json" } });
  api("/api/widget/public/config?key=" + encodeURIComponent(key))
    .then((response) => { if (!response.ok) throw new Error("Chat indisponível"); return response.json(); })
    .then((config) => {
      const style = document.createElement("style");
      style.textContent = ".avf-button{position:fixed;right:24px;bottom:24px;z-index:2147483000;border:0;border-radius:28px;padding:14px 20px;color:#fff;font:600 14px system-ui;cursor:pointer;box-shadow:0 6px 24px #0003}.avf-panel{position:fixed;right:24px;bottom:82px;z-index:2147483000;width:min(360px,calc(100vw - 32px));height:min(520px,calc(100vh - 110px));display:none;flex-direction:column;background:#fff;border-radius:16px;box-shadow:0 8px 36px #0003;overflow:hidden;font:14px system-ui;color:#172033}.avf-head{padding:16px;color:#fff;font-weight:700}.avf-messages{flex:1;overflow:auto;padding:12px;background:#f7f8fa}.avf-msg{max-width:85%;margin:8px 0;padding:10px 12px;border-radius:12px;background:#fff;white-space:pre-wrap;overflow-wrap:anywhere}.avf-msg.customer{margin-left:auto;color:#fff}.avf-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb}.avf-input{min-width:0;flex:1;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}.avf-send{border:0;border-radius:8px;padding:0 14px;color:#fff;font:600 14px system-ui;cursor:pointer}.avf-error{padding:0 12px;color:#b91c1c;font-size:12px}";
      document.head.appendChild(style);
      const panel = document.createElement("section");
      panel.className = "avf-panel";
      panel.setAttribute("aria-label", config.displayName);
      const header = document.createElement("div");
      header.className = "avf-head"; header.style.background = config.color; header.textContent = config.displayName;
      const messages = document.createElement("div"); messages.className = "avf-messages";
      const error = document.createElement("div"); error.className = "avf-error";
      const form = document.createElement("form"); form.className = "avf-form";
      const input = document.createElement("input"); input.className = "avf-input"; input.maxLength = 4000; input.placeholder = "Escreva sua mensagem"; input.setAttribute("aria-label", "Escreva sua mensagem");
      const send = document.createElement("button"); send.className = "avf-send"; send.type = "submit"; send.textContent = "Enviar"; send.style.background = config.color;
      form.append(input, send); panel.append(header, messages, error, form);
      const button = document.createElement("button"); button.className = "avf-button"; button.type = "button"; button.textContent = "Fale conosco"; button.style.background = config.color; button.setAttribute("aria-expanded", "false");
      document.body.append(panel, button);
      let token = "";
      try { token = localStorage.getItem("avf-widget-" + key) || ""; } catch {}
      const addMessage = (body, direction) => { const item = document.createElement("div"); item.className = "avf-msg " + direction; item.textContent = body; if (direction === "customer" || direction === "ai" || direction === "agent") item.style.background = direction === "customer" ? config.color : "#fff"; if (direction === "customer") item.style.color = "#fff"; messages.appendChild(item); };
      addMessage(config.welcomeMessage, "ai");
      const load = async () => {
        if (!token) return;
        const response = await api("/api/widget/public/messages?key=" + encodeURIComponent(key), { headers: { authorization: "Bearer " + token } });
        if (!response.ok) { if (response.status === 401) { token = ""; try { localStorage.removeItem("avf-widget-" + key); } catch {} } return; }
        const data = await response.json(); messages.replaceChildren(); addMessage(config.welcomeMessage, "ai");
        for (const item of data.messages || []) addMessage(item.body, item.direction);
        messages.scrollTop = messages.scrollHeight;
      };
      button.addEventListener("click", () => { const open = panel.style.display !== "flex"; panel.style.display = open ? "flex" : "none"; button.setAttribute("aria-expanded", String(open)); if (open) { void load(); input.focus(); } });
      form.addEventListener("submit", async (event) => {
        event.preventDefault(); const text = input.value.trim(); if (!text) return;
        send.disabled = true; error.textContent = "";
        try {
          if (!token) { const created = await api("/api/widget/public/session?key=" + encodeURIComponent(key), { method: "POST", body: "{}" }); if (!created.ok) throw new Error("Não foi possível iniciar o atendimento."); const session = await created.json(); token = session.token; try { localStorage.setItem("avf-widget-" + key, token); } catch {} }
          const response = await api("/api/widget/public/messages?key=" + encodeURIComponent(key), { method: "POST", headers: { authorization: "Bearer " + token }, body: JSON.stringify({ text }) });
          const data = await response.json(); if (!response.ok) throw new Error(data.error || "Falha ao enviar mensagem.");
          input.value = ""; addMessage(text, "customer"); messages.scrollTop = messages.scrollHeight; setTimeout(() => void load(), 800);
        } catch (failure) { error.textContent = failure instanceof Error ? failure.message : "Falha ao enviar."; }
        finally { send.disabled = false; input.focus(); }
      });
      setInterval(() => { if (panel.style.display === "flex") void load(); }, 5000);
    }).catch((error) => {
      console.error("webchat_widget_load_failed", error);
    });
})();`
  return new Response(source, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
    },
  })
}

async function ensureSettings(env: Env, org: string) {
  let settings = await env.DB.prepare(
    `SELECT organization_id organizationId,public_key publicKey,enabled,
       display_name displayName,color,welcome_message welcomeMessage,
       allowed_domains_json allowedDomainsJson
     FROM webchat_settings WHERE organization_id=?`,
  )
    .bind(org)
    .first<{
      organizationId: string
      publicKey: string
      enabled: number
      displayName: string
      color: string
      welcomeMessage: string
      allowedDomainsJson: string
    }>()
  if (!settings) {
    const publicKey = crypto.randomUUID().replaceAll("-", "")
    await env.DB.prepare(
      `INSERT OR IGNORE INTO webchat_settings(organization_id,public_key)
       VALUES(?,?)`,
    )
      .bind(org, publicKey)
      .run()
    settings = await env.DB.prepare(
      `SELECT organization_id organizationId,public_key publicKey,enabled,
         display_name displayName,color,welcome_message welcomeMessage,
         allowed_domains_json allowedDomainsJson
       FROM webchat_settings WHERE organization_id=?`,
    )
      .bind(org)
      .first()
  }
  if (!settings) throw new Error("Não foi possível inicializar as configurações do widget.")
  return {
    ...settings,
    allowedDomains: parseDomains(settings.allowedDomainsJson),
  }
}

function normalizeDomain(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null
  const raw = value.trim().toLowerCase()
  if (raw.includes("*")) return null
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`)
    if (url.username || url.password || (url.pathname !== "/" && url.pathname) || url.search || url.hash)
      return null
    const host = url.hostname.toLowerCase()
    const local =
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.includes(":") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
    if (!local && (url.protocol !== "https:" || !host.includes("."))) return null
    return host
  } catch {
    return null
  }
}

export async function webchatRoutes(
  request: Request,
  env: Env,
  url: URL,
  auth: Session,
) {
  if (!url.pathname.startsWith("/api/widget/")) return null
  const path = url.pathname.slice("/api/widget".length)
  const org = auth.organizationId
  const canEdit = auth.role === "admin" || auth.role === "manager"

  if (path === "/settings" && request.method === "GET") {
    const settings = await ensureSettings(env, org)
    return json({
      enabled: !!settings.enabled,
      publicKey: settings.publicKey,
      displayName: settings.displayName,
      color: settings.color,
      welcomeMessage: settings.welcomeMessage,
      allowedDomains: settings.allowedDomains,
      embedCode: `<script async src="${new URL("/widget/embed.js", env.APP_ORIGIN)}" data-key="${settings.publicKey}"></script>`,
      installConfirmed: !!(await env.DB.prepare(
        "SELECT 1 FROM webchat_sessions WHERE organization_id=? LIMIT 1",
      )
        .bind(org)
        .first()),
    })
  }

  if (path.startsWith("/settings") && !canEdit)
    return json({ error: "Apenas administradores e gerentes podem configurar o widget." }, 403)

  if (path === "/settings" && request.method === "PUT") {
    const body = await request.json<Record<string, unknown>>()
    if (
      !Array.isArray(body.allowedDomains) ||
      body.allowedDomains.length > 20 ||
      body.allowedDomains.some((domain) => !normalizeDomain(domain))
    )
      return json({ error: "Informe até 20 domínios públicos válidos, sem curingas." }, 400)
    const domains = [...new Set((body.allowedDomains as unknown[]).map(normalizeDomain))]
      .filter((domain): domain is string => !!domain)
    const color = typeof body.color === "string" ? body.color.trim() : "#1769e0"
    if (!/^#[0-9a-f]{6}$/i.test(color))
      return json({ error: "A cor deve estar no formato hexadecimal #RRGGBB." }, 400)
    const current = await ensureSettings(env, org)
    await env.DB.prepare(
      `UPDATE webchat_settings SET enabled=?,display_name=?,color=?,
       welcome_message=?,allowed_domains_json=?,updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=?`,
    )
      .bind(
        body.enabled === true ? 1 : 0,
        typeof body.displayName === "string" ? body.displayName.trim().slice(0, 100) || "Atendimento" : current.displayName,
        color,
        typeof body.welcomeMessage === "string" ? body.welcomeMessage.trim().slice(0, 500) || "Oi! Como podemos ajudar?" : current.welcomeMessage,
        JSON.stringify(domains),
        org,
      )
      .run()
    return json({ ok: true })
  }

  if (path === "/settings/rotate-key" && request.method === "POST") {
    if (!canEdit) return json({ error: "Apenas administradores e gerentes." }, 403)
    await ensureSettings(env, org)
    const publicKey = crypto.randomUUID().replaceAll("-", "")
    await env.DB.prepare(
      "UPDATE webchat_settings SET public_key=?,updated_at=CURRENT_TIMESTAMP WHERE organization_id=?",
    )
      .bind(publicKey, org)
      .run()
    return json({ ok: true, publicKey })
  }

  if (path === "/conversations" && request.method === "GET")
    return json(
      await env.DB.prepare(
        `SELECT s.id,s.visitor_name visitorName,s.visitor_email visitorEmail,
           s.status,s.ai_state aiState,s.assigned_to assignedTo,s.unread_count unread,
           s.last_message_at lastMessageAt,s.origin_domain originDomain,
           (SELECT body FROM webchat_messages m WHERE m.session_id=s.id
             AND m.organization_id=s.organization_id ORDER BY created_at DESC LIMIT 1) preview
         FROM webchat_sessions s WHERE s.organization_id=?
         ORDER BY (s.unread_count>0) DESC,s.last_message_at DESC LIMIT 200`,
      )
        .bind(org)
        .all(),
    )

  const match = path.match(/^\/conversations\/([\w-]+)(?:\/(messages|resolve|resume-ai|reopen))?$/)
  if (!match) return json({ error: "Rota do widget não encontrada." }, 404)
  const sessionId = match[1]!
  const action = match[2] ?? ""
  const session = await env.DB.prepare(
    `SELECT id FROM webchat_sessions WHERE id=? AND organization_id=?`,
  )
    .bind(sessionId, org)
    .first()
  if (!session) return json({ error: "Conversa do site não encontrada." }, 404)

  if (action === "messages" && request.method === "GET")
    {
      await env.DB.prepare(
        `UPDATE webchat_sessions SET unread_count=0
         WHERE id=? AND organization_id=?`,
      )
        .bind(sessionId, org)
        .run()
      return json(
        await env.DB.prepare(
        `SELECT m.id,m.direction,m.body,m.status,m.created_at createdAt,
           u.name senderName FROM webchat_messages m
         LEFT JOIN users u ON u.id=m.sent_by
         WHERE m.organization_id=? AND m.session_id=?
         ORDER BY m.created_at LIMIT 500`,
        )
          .bind(org, sessionId)
          .all(),
      )
    }

  if (!action && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>()
    const text = typeof body.body === "string" ? body.body.trim() : ""
    if (!text || text.length > 4000)
      return json({ error: "A mensagem deve ter entre 1 e 4.000 caracteres." }, 400)
    const messageId = uid()
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO webchat_messages(
           id,organization_id,session_id,direction,body,status,sent_by
         ) VALUES(?,?,?,'agent',?,'accepted',?)`,
      ).bind(messageId, org, sessionId, text, auth.userId),
      env.DB.prepare(
        `UPDATE webchat_sessions SET ai_state='HUMANO',assigned_to=?,
         status='open',unread_count=0,last_message_at=CURRENT_TIMESTAMP,
         updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
      ).bind(auth.userId, sessionId, org),
    ])
    return json({ ok: true, id: messageId }, 201)
  }

  if (action === "resolve" && request.method === "POST") {
    await env.DB.prepare(
      `UPDATE webchat_sessions SET status='resolved',unread_count=0,
       updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
    )
      .bind(sessionId, org)
      .run()
    return json({ ok: true })
  }

  if (action === "resume-ai" && request.method === "POST") {
    await env.DB.prepare(
      `UPDATE webchat_sessions SET ai_state='IA_ATIVA',assigned_to=NULL,
       status='open',updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=?`,
    )
      .bind(sessionId, org)
      .run()
    return json({ ok: true })
  }

  if (action === "reopen" && request.method === "POST") {
    await env.DB.prepare(
      `UPDATE webchat_sessions SET status='open',updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=?`,
    )
      .bind(sessionId, org)
      .run()
    return json({ ok: true })
  }

  return json({ error: "Método ou ação não suportada." }, 405)
}

export function webchatSessionForPublicTesting(
  settings: WidgetSettings,
  origin: string | null,
) {
  return originAllowed(settings, origin)
}
