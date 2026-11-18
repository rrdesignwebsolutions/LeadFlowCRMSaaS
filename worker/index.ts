/// <reference types="@cloudflare/workers-types" />

import { aiRoutes } from "./ai"
import { quickReplyRoutes } from "./quick-replies"
import { effectiveLeadStatus } from "./lead-status"
import {
  catalogRoutes,
  processPendingCatalogDeliveries,
  recoverUnqueuedCatalogDeliveries,
} from "./catalog"
import { brandingRoutes } from "./branding"
import {
  confirmOrder,
  confirmPublicCheckout,
  claimPublicCheckout,
  createCheckout,
  createPublicCheckout,
  dynamicBillingEnabled,
  hasAccess,
  PLAN_PRICES,
  publicCheckoutStatus,
  sendBillingReminders,
  subscriptionFor,
} from "./billing"
import { cleanupInactiveAccounts } from "./cleanup"
import {
  canResend,
  consumeVerificationToken,
  emailVerificationEnabled,
  sendVerificationEmail,
} from "./verification"
import { supportRoutes } from "./support"
import { workflowRoutes } from "./workflows"
import {
  cleanupPendingWhatsappSignups,
  handleMetaPayload,
  processPendingWhatsAppJobs,
  recoverUnqueuedInboundMessages,
  whatsappRoutes,
} from "./whatsapp"
import {
  gmailOAuthCallback,
  gmailRoutes,
  syncAllGmailAccounts,
} from "./gmail"
import {
  processPendingWebchatJobs,
  webchatAssetRoutes,
  webchatPublicRoutes,
  webchatRoutes,
} from "./webchat"

export interface Env {
  DB: D1Database

  ASSETS: Fetcher

  /** Bucket R2 privado com as fotos do catálogo. */
  CATALOG?: R2Bucket

  APP_ORIGIN: string

  SESSION_SECRET?: string

  META_APP_ID?: string

  META_CONFIG_ID?: string

  META_COEXISTENCE_CONFIG_ID?: string

  META_APP_SECRET?: string

  META_VERIFY_TOKEN?: string

  META_GRAPH_API_VERSION?: string

  ENCRYPTION_KEY?: string

  GRAPH_API_BASE?: string

  OPENAI_API_KEY?: string

  OPENAI_MODEL?: string

  OPENAI_VISION_MODEL?: string

  OPENAI_TRANSCRIPTION_MODEL?: string

  INFINITEPAY_ESSENCIAL_URL?: string

  INFINITEPAY_PRO_URL?: string

  INFINITEPAY_SCALE_URL?: string
  /** Chave da API de Checkout da InfinitePay (secret). Habilita a ativação automática. */
  INFINITEPAY_API_KEY?: string
  /** InfiniteTag da conta (sem o $). */
  INFINITEPAY_HANDLE?: string
  /** Chave da API Resend para enviar e-mails de confirmação (secret). */
  RESEND_API_KEY?: string
  /** Remetente verificado, ex.: "AV Flow CRM <no-reply@seudominio.com>". */
  EMAIL_FROM?: string

  GOOGLE_CLIENT_ID?: string

  GOOGLE_CLIENT_SECRET?: string

  GOOGLE_REDIRECT_URI?: string

  /** E-mail destinatário das solicitações enviadas pela tela de suporte. */
  SUPPORT_EMAIL?: string
}

export type Session = { userId: string; organizationId: string; role: string }

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })

const id = () => crypto.randomUUID()

const billingPlanUrls = (env: Env) => ({
  essencial: env.INFINITEPAY_ESSENCIAL_URL,
  pro: env.INFINITEPAY_PRO_URL,
  scale: env.INFINITEPAY_SCALE_URL,
})

export const isValidInfinitePayCheckoutUrl = (value: string | undefined) => {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" &&
      (url.hostname === "infinitepay.io" || url.hostname.endsWith(".infinitepay.io"))
  } catch {
    return false
  }
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")

export const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))

export const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false

  let diff = 0

  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)

  return diff === 0
}

async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  )

  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(salt),
        iterations: 100000,
      },
      key,
      256,
    ),
  )
}

function cookie(request: Request, name: string) {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

async function session(request: Request, env: Env): Promise<Session | null> {
  const token = cookie(request, "__Host-av_flow_crm_session")

  if (!token) return null

  const row = await env.DB.prepare(`
    SELECT s.user_id userId, s.organization_id organizationId, m.role
    FROM sessions s JOIN organization_members m ON m.user_id=s.user_id AND m.organization_id=s.organization_id
    WHERE s.token_hash=? AND s.expires_at > CURRENT_TIMESTAMP AND m.status='active'
  `)
    .bind(await sha256(token))
    .first<Session>()

  return row ?? null
}

async function audit(
  env: Env,
  auth: Session,
  action: string,
  resourceType: string,
  resourceId?: string,
) {
  await env.DB.prepare(
    "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,?,?,?,?)",
  )

    .bind(
      id(),
      auth.organizationId,
      auth.userId,
      action,
      resourceType,
      resourceId ?? null,
    )
    .run()
}

async function authRoutes(request: Request, env: Env, path: string) {
  if (path === "/api/auth/register" && request.method === "POST") {
    const body = await request.json<{
      company?: string
      name?: string
      email?: string
      password?: string
      inviteToken?: string
      order_nsu?: string
    }>()

    if (body.inviteToken) return acceptInvite(env, body)

    if (
      !body.company?.trim() ||
      !body.name?.trim() ||
      !body.email?.includes("@") ||
      (body.password?.length ?? 0) < 12
    )
      return json(
        {
          error: "Dados inválidos. A senha deve ter pelo menos 12 caracteres.",
        },
        400,
      )

    const orderNsu = body.order_nsu?.trim() ?? ""
    const order = await env.DB.prepare(
      `SELECT status,claimed_organization_id claimedOrganizationId
       FROM public_checkout_orders WHERE order_nsu=?`,
    )
      .bind(orderNsu)
      .first<{ status: string; claimedOrganizationId: string | null }>()

    if (!order || order.status !== "paid")
      return json(
        {
          error: "O cadastro só é liberado após a confirmação do pagamento de um plano.",
          code: "payment_required",
        },
        402,
      )
    if (order.claimedOrganizationId)
      return json(
        { error: "Este pagamento já foi vinculado a uma conta.", code: "payment_used" },
        409,
      )

    const userId = id(),
      orgId = id(),
      salt = id(),
      email = body.email.toLowerCase().trim()

    try {
      const password = await passwordHash(body.password!, salt)
      const company = body.company.trim()
      const companySlug = `${company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${orgId.slice(0, 6)}`
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE public_checkout_orders
           SET claimed_organization_id=?,claimed_at=CURRENT_TIMESTAMP
           WHERE order_nsu=? AND status='paid' AND claimed_organization_id IS NULL`,
        ).bind(orgId, orderNsu),

        env.DB.prepare(
          `INSERT INTO organizations(id,name,slug)
           SELECT ?,?,? WHERE EXISTS (
             SELECT 1 FROM public_checkout_orders
             WHERE order_nsu=? AND claimed_organization_id=?
           )`,
        ).bind(orgId, company, companySlug, orderNsu, orgId),
        env.DB.prepare(
          `INSERT INTO users(id,email,name,password_hash,password_salt)
           SELECT ?,?,?,?,? WHERE EXISTS (
             SELECT 1 FROM public_checkout_orders
             WHERE order_nsu=? AND claimed_organization_id=?
           )`,
        ).bind(
          userId,
          email,
          body.name.trim(),
          password,
          salt,
          orderNsu,
          orgId,
        ),
        env.DB.prepare(
          `INSERT INTO organization_members(organization_id,user_id,role)
           SELECT ?,?,'admin' WHERE EXISTS (
           SELECT 1 FROM public_checkout_orders
           WHERE order_nsu=? AND claimed_organization_id=?
           )`,
        ).bind(orgId, userId, orderNsu, orgId),
        env.DB.prepare(
          `INSERT INTO subscriptions(id,organization_id,status,plan,period_ends_at)
           SELECT ?,?,'active',plan,datetime('now','+'||period_days||' days')
           FROM public_checkout_orders WHERE order_nsu=? AND claimed_organization_id=?`,
        ).bind(id(), orgId, orderNsu, orgId),
        env.DB.prepare(
          `INSERT INTO billing_orders(
           order_nsu,organization_id,plan,amount_cents,status,transaction_nsu,created_at,paid_at,period_days
           )
           SELECT order_nsu,?,plan,amount_cents,'paid',transaction_nsu,created_at,paid_at,period_days
           FROM public_checkout_orders WHERE order_nsu=? AND claimed_organization_id=?`,
        ).bind(orgId, orderNsu, orgId),
      ])

      if (!results[0]?.meta.changes)
        return json(
          { error: "Este pagamento já foi vinculado a uma conta.", code: "payment_used" },
          409,
        )

      if (emailVerificationEnabled(env)) {
        const sent = await sendVerificationEmail(env, userId, email, body.name.trim())

        return json({ verify: true, email, sent }, 202)
      }

      await env.DB.prepare(
        "UPDATE users SET email_verified_at=CURRENT_TIMESTAMP WHERE id=?",
      )
        .bind(userId)
        .run()

      return await createSession(env, userId, orgId, 201)
    } catch (error) {
      console.error(
        "register_failed",
        error instanceof Error ? error.message : "unknown",
      )

      return json(
        {
          error:
            "Não foi possível criar a conta. Verifique se o e-mail já existe.",
        },
        409,
      )
    }
  }

  if (path === "/api/auth/login" && request.method === "POST") {
    const body = await request.json<{ email?: string; password?: string }>()

    const user = await env.DB.prepare(
      "SELECT id,name,password_hash,password_salt,failed_login_count,locked_until,email_verified_at FROM users WHERE email=? COLLATE NOCASE",
    )

      .bind(body.email?.trim() ?? "")
      .first<{
        id: string
        name: string
        password_hash: string
        password_salt: string
        failed_login_count: number
        locked_until: string | null
        email_verified_at: string | null
      }>()

    if (
      !user ||
      (user.locked_until && new Date(user.locked_until) > new Date())
    )
      return json(
        { error: "Credenciais inválidas ou acesso temporariamente bloqueado." },
        401,
      )

    const valid = constantTimeEqual(
      await passwordHash(body.password ?? "", user.password_salt),
      user.password_hash,
    )

    if (!valid) {
      const attempts = user.failed_login_count + 1

      await env.DB.prepare(
        "UPDATE users SET failed_login_count=?,locked_until=CASE WHEN ?>=5 THEN datetime('now','+15 minutes') ELSE NULL END WHERE id=?",
      )
        .bind(attempts, attempts, user.id)
        .run()

      return json({ error: "Credenciais inválidas." }, 401)
    }

    const member = await env.DB.prepare(
      "SELECT organization_id FROM organization_members WHERE user_id=? AND status='active' LIMIT 1",
    )
      .bind(user.id)
      .first<{ organization_id: string }>()

    if (!member) return json({ error: "Usuário sem organização ativa." }, 403)

    if (emailVerificationEnabled(env) && !user.email_verified_at)
      return json(
        {
          error: "Confirme seu e-mail para acessar. Verifique sua caixa de entrada.",
          code: "email_not_verified",
        },
        403,
      )

    await env.DB.prepare(
      "UPDATE users SET failed_login_count=0,locked_until=NULL WHERE id=?",
    )
      .bind(user.id)
      .run()

    return createSession(env, user.id, member.organization_id)
  }

  if (path === "/api/auth/verify" && request.method === "POST") {
    const body = await request.json<{ token?: string }>()

    const userId = await consumeVerificationToken(env, body.token ?? "")

    if (!userId)
      return json({ error: "Link inválido ou expirado. Peça um novo e-mail." }, 400)

    const member = await env.DB.prepare(
      "SELECT organization_id FROM organization_members WHERE user_id=? AND status='active' LIMIT 1",
    )
      .bind(userId)
      .first<{ organization_id: string }>()

    if (!member) return json({ error: "Usuário sem organização ativa." }, 403)

    return createSession(env, userId, member.organization_id)
  }

  if (path === "/api/auth/resend" && request.method === "POST") {
    const body = await request.json<{ email?: string }>()

    const user = emailVerificationEnabled(env)
      ? await env.DB.prepare(
          "SELECT id,name,email FROM users WHERE email=? COLLATE NOCASE AND email_verified_at IS NULL",
        )
          .bind(body.email?.trim() ?? "")
          .first<{ id: string; name: string; email: string }>()
      : null

    if (user && (await canResend(env, user.id)))
      await sendVerificationEmail(env, user.id, user.email, user.name)

    // Resposta idêntica para não revelar quais e-mails existem.
    return json({ ok: true })
  }

  return null
}

const PLAN_USER_LIMIT = 3

const ROLES = ["admin", "manager", "agent"]

const LEAD_STATUSES = [
  "new",
  "not_contacted",
  "in_service",
  "hot",
  "qualified",
  "negotiating",
  "follow_up",
  "financial_pending",
  "cold",
  "lost",
  "sold",
]

async function findInvite(env: Env, token: string) {
  return env.DB.prepare(`SELECT i.id,i.organization_id organizationId,i.email,i.role,o.name organization FROM invitations i
    JOIN organizations o ON o.id=i.organization_id
    WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP`)

    .bind(await sha256(token))
    .first<{
      id: string
      organizationId: string
      email: string
      role: string
      organization: string
    }>()
}

async function seatsUsed(env: Env, orgId: string) {
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM organization_members WHERE organization_id=? AND status='active') +
    (SELECT COUNT(*) FROM invitations WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP) n`)

    .bind(orgId, orgId)
    .first<{ n: number }>()

  return row?.n ?? 0
}

async function acceptInvite(
  env: Env,
  body: { name?: string; email?: string; password?: string; inviteToken?: string },
) {
  if (!body.name?.trim() || (body.password?.length ?? 0) < 12)
    return json(
      { error: "Dados inválidos. A senha deve ter pelo menos 12 caracteres." },
      400,
    )

  const invite = await findInvite(env, body.inviteToken!)

  if (!invite) return json({ error: "Convite inválido ou expirado." }, 400)

  const userId = id(),
    salt = id()

  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO users(id,email,name,password_hash,password_salt,email_verified_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)",
      ).bind(
        userId,
        invite.email.toLowerCase(),
        body.name.trim(),
        await passwordHash(body.password!, salt),
        salt,
      ),

      env.DB.prepare(
        "INSERT INTO organization_members(organization_id,user_id,role) VALUES(?,?,?)",
      ).bind(invite.organizationId, userId, invite.role),

      env.DB.prepare(
        "UPDATE invitations SET accepted_at=CURRENT_TIMESTAMP WHERE id=? AND accepted_at IS NULL",
      ).bind(invite.id),
    ])

    return await createSession(env, userId, invite.organizationId, 201)
  } catch (error) {
    console.error(
      "invite_accept_failed",
      error instanceof Error ? error.message : "unknown",
    )

    return json(
      {
        error:
          "Não foi possível aceitar o convite. Este e-mail já pode ter uma conta.",
      },
      409,
    )
  }
}

function normalizePhone(value: unknown) {
  let digits = String(value ?? "").replace(/\D/g, "")

  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`

  return digits.length >= 12 && digits.length <= 15 ? `+${digits}` : null
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null

async function createSession(
  env: Env,
  userId: string,
  orgId: string,
  status = 200,
) {
  const token = `${id()}${id()}`

  await env.DB.prepare(
    "INSERT INTO sessions(id,token_hash,user_id,organization_id,expires_at) VALUES(?,?,?,?,datetime('now','+7 days'))",
  )

    .bind(id(), await sha256(token), userId, orgId)
    .run()

  return json({ ok: true }, status, {
    "set-cookie": `__Host-av_flow_crm_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
  })
}

export async function verifyMetaSignature(
  request: Request,
  secret: string,
  raw: string,
) {
  const provided = request.headers.get("x-hub-signature-256")

  if (!provided?.startsWith("sha256=")) return false

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )

  const expected = `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))}`

  return constantTimeEqual(provided, expected)
}

async function webhook(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
) {
  if (request.method === "GET") {
    const valid =
      url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === env.META_VERIFY_TOKEN

    return valid
      ? new Response(url.searchParams.get("hub.challenge") ?? "")
      : new Response("Forbidden", { status: 403 })
  }

  if (!env.META_APP_SECRET) {
    console.error("meta_webhook_rejected", { reason: "secret_not_configured" })
    return json({ error: "Webhook não configurado." }, 503)
  }

  const raw = await request.text()

  if (!(await verifyMetaSignature(request, env.META_APP_SECRET, raw))) {
    console.warn("meta_webhook_rejected", { reason: "invalid_signature" })
    return json({ error: "Assinatura inválida." }, 401)
  }

  let payload: Parameters<typeof handleMetaPayload>[1]

  try {
    payload = JSON.parse(raw)
  } catch {
    console.warn("meta_webhook_rejected", { reason: "invalid_json" })
    return json({ error: "Corpo inválido." }, 400)
  }

  await handleMetaPayload(env, payload, await sha256(raw), (task) =>
    ctx.waitUntil(task),
  )

  return json({ received: true })
}

async function api(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
) {
  const gmailCallback = await gmailOAuthCallback(request, env, url)
  if (gmailCallback) return gmailCallback

  const widgetPublic = await webchatPublicRoutes(
    request,
    env,
    url,
    (task) => ctx.waitUntil(task),
  )
  if (widgetPublic) return widgetPublic

  const authResult = await authRoutes(request, env, url.pathname)

  if (authResult) return authResult

  if (url.pathname === "/api/webhooks/meta") return webhook(request, env, url, ctx)

  if (url.pathname === "/api/billing/webhook/infinitepay" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>().catch(() => ({}))

    const input = {
      orderNsu: body.order_nsu,
      transactionNsu: body.transaction_nsu,
      slug: body.invoice_slug ?? body.slug,
    }
    const accountOrder = await confirmOrder(env, input)
    const result =
      accountOrder === "ignored"
        ? await confirmPublicCheckout(env, input)
        : accountOrder

    return result === "error" ? json({ error: "Falha ao confirmar." }, 502) : json({ ok: true })
  }

  if (
    url.pathname === "/api/public/billing/checkout" &&
    request.method === "POST"
  ) {
    const body = await request
      .json<{ planId?: string; cycle?: string }>()
      .catch(() => ({}))
    const planId = body.planId ?? ""

    if (!PLAN_PRICES[planId])
      return json({ error: "Escolha um plano válido." }, 400)
    if (body.cycle && !["monthly", "annual"].includes(body.cycle))
      return json({ error: "Periodicidade inválida." }, 400)
    if (!dynamicBillingEnabled(env))
      return json(
        { error: "O pagamento online está temporariamente indisponível." },
        503,
      )

    const checkout = await createPublicCheckout(
      env,
      planId,
      body.cycle === "annual" ? "annual" : "monthly",
    )
    return checkout
      ? json(checkout, 201)
      : json(
          { error: "Não foi possível abrir o pagamento. Tente novamente." },
          502,
        )
  }

  if (
    url.pathname === "/api/public/billing/confirm" &&
    request.method === "POST"
  ) {
    const body = await request
      .json<Record<string, unknown>>()
      .catch(() => ({}))
    const result = await confirmPublicCheckout(env, {
      orderNsu: body.order_nsu,
      transactionNsu: body.transaction_nsu,
      slug: body.slug,
    })
    if (result === "error")
      return json(
        { error: "Não foi possível confirmar o pagamento agora." },
        502,
      )

    const status = await publicCheckoutStatus(
      env,
      typeof body.order_nsu === "string" ? body.order_nsu : "",
    )
    return status
      ? json(status)
      : json({ error: "Pedido de pagamento não encontrado." }, 404)
  }

  if (
    url.pathname === "/api/public/billing/status" &&
    request.method === "GET"
  ) {
    const orderNsu = url.searchParams.get("order_nsu")?.trim() ?? ""
    if (!/^public_[0-9a-f-]{36}$/.test(orderNsu))
      return json({ error: "Pedido de pagamento inválido." }, 400)

    const status = await publicCheckoutStatus(env, orderNsu)
    return status
      ? json(status)
      : json({ error: "Pedido de pagamento não encontrado." }, 404)
  }

  if (url.pathname === "/api/health") {
    await env.DB.prepare("SELECT 1").first()

    return json({ status: "ok", database: "connected" })
  }

  if (url.pathname === "/api/invitations/lookup" && request.method === "GET") {
    const invite = await findInvite(env, url.searchParams.get("token") ?? "")

    return invite
      ? json({
          email: invite.email,
          organization: invite.organization,
          role: invite.role,
        })
      : json({ error: "Convite inválido ou expirado." }, 404)
  }

  const auth = await session(request, env)

  if (!auth) return json({ error: "Não autenticado." }, 401)

  if (url.pathname === "/api/onboarding" && request.method === "GET") {
    const org = auth.organizationId
    const [
      branding,
      assistant,
      knowledge,
      whatsapp,
      gmail,
      members,
      widget,
      shortcuts,
      contacts,
      workflows,
    ] = await Promise.all([
      env.DB.prepare(
        "SELECT 1 FROM organization_branding WHERE organization_id=? AND (display_name IS NOT NULL OR logo_data IS NOT NULL)",
      ).bind(org).first(),
      env.DB.prepare(
        "SELECT enabled FROM ai_settings WHERE organization_id=?",
      ).bind(org).first<{ enabled: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) count FROM ai_knowledge WHERE organization_id=?",
      ).bind(org).first<{ count: number }>(),
      env.DB.prepare(
        "SELECT status FROM integrations WHERE organization_id=? AND provider='meta_whatsapp' ORDER BY updated_at DESC LIMIT 1",
      ).bind(org).first<{ status: string }>(),
      env.DB.prepare(
        "SELECT status FROM gmail_accounts WHERE organization_id=?",
      ).bind(org).first<{ status: string }>(),
      env.DB.prepare(
        "SELECT COUNT(*) count FROM organization_members WHERE organization_id=? AND status='active'",
      ).bind(org).first<{ count: number }>(),
      env.DB.prepare(
        `SELECT enabled,allowed_domains_json allowedDomains,
           EXISTS(SELECT 1 FROM webchat_sessions WHERE organization_id=?) installConfirmed
         FROM webchat_settings WHERE organization_id=?`,
      ).bind(org, org).first<{
        enabled: number
        allowedDomains: string
        installConfirmed: number
      }>(),
      env.DB.prepare(
        "SELECT COUNT(*) count FROM quick_replies WHERE organization_id=?",
      ).bind(org).first<{ count: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) count FROM contacts WHERE organization_id=?",
      ).bind(org).first<{ count: number }>(),
      env.DB.prepare(
        "SELECT COUNT(*) count FROM workflows WHERE organization_id=? AND status='active'",
      ).bind(org).first<{ count: number }>(),
    ])
    let hasWidgetDomain = false
    try {
      const domains: unknown = JSON.parse(widget?.allowedDomains ?? "[]")
      hasWidgetDomain = Array.isArray(domains) && domains.length > 0
    } catch (error) {
      console.error("onboarding_widget_domains_invalid", {
        organizationId: org,
        error: error instanceof Error ? error.message : "unknown",
      })
    }
    const items = [
      { id: "profile", label: "Personalize o perfil da empresa", done: !!branding, view: "settings" },
      { id: "assistant", label: "Configure o agente de IA", done: assistant?.enabled === 1 && !!env.OPENAI_API_KEY, view: "agent" },
      { id: "knowledge", label: "Adicione conteúdo à base de conhecimento", done: (knowledge?.count ?? 0) > 0, view: "agent" },
      { id: "whatsapp", label: "Conecte o WhatsApp", done: whatsapp?.status === "connected", view: "settings" },
      { id: "gmail", label: "Conecte o Gmail", done: gmail?.status === "connected", view: "email" },
      { id: "team", label: "Convide sua equipe", done: (members?.count ?? 0) > 1, view: "team" },
      { id: "widget", label: "Configure o chat no seu site", done: !!widget?.enabled && hasWidgetDomain && !!widget?.installConfirmed, view: "webchat" },
      { id: "shortcuts", label: "Crie uma resposta rápida", done: (shortcuts?.count ?? 0) > 0, view: "quick-replies" },
      { id: "contacts", label: "Adicione ou importe contatos", done: (contacts?.count ?? 0) > 0, view: "leads" },
      { id: "workflow", label: "Publique seu primeiro fluxo", done: (workflows?.count ?? 0) > 0, view: "workflows" },
    ]
    return json({
      items,
      completed: items.filter((item) => item.done).length,
      total: items.length,
    })
  }

  if (url.pathname === "/api/support")
    return (await supportRoutes(request, env, auth)) ?? json({ error: "Rota não encontrada." }, 404)

  if (
    url.pathname === "/api/billing/claim-public" &&
    request.method === "POST"
  ) {
    if (auth.role !== "admin")
      return json(
        { error: "Apenas administradores podem vincular um pagamento à empresa." },
        403,
      )
    const body = await request
      .json<{ order_nsu?: string }>()
      .catch(() => ({}))
    const orderNsu = body.order_nsu?.trim() ?? ""
    if (!/^public_[0-9a-f-]{36}$/.test(orderNsu))
      return json({ error: "Pedido de pagamento inválido." }, 400)

    const claimed = await claimPublicCheckout(
      env,
      orderNsu,
      auth.organizationId,
    )
    if (!claimed)
      return json(
        { error: "O pagamento não foi confirmado ou já foi vinculado a outra conta." },
        409,
      )

    await audit(env, auth, "billing.public_order_claimed", "billing_order", orderNsu)
    return json({ ok: true })
  }

  if (url.pathname === "/api/billing/plans" && request.method === "GET") {
    const links = billingPlanUrls(env)
    return json({
      available: dynamicBillingEnabled(env)
        ? Object.keys(PLAN_PRICES)
        : Object.entries(links)
            .filter(([, value]) => isValidInfinitePayCheckoutUrl(value))
            .map(([planId]) => planId),
    })
  }

  if (url.pathname === "/api/billing/confirm" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>().catch(() => ({}))

    await confirmOrder(env, {
      orderNsu: body.order_nsu,
      transactionNsu: body.transaction_nsu,
      slug: body.slug,
      organizationId: auth.organizationId,
    })

    return json({ ok: true })
  }

  if (url.pathname === "/api/billing/checkout" && request.method === "POST") {
    if (auth.role !== "admin")
      return json({ error: "Apenas administradores podem contratar ou alterar o plano." }, 403)

    const body = await request.json<{ planId?: string; cycle?: string }>()

    if (dynamicBillingEnabled(env)) {
      const me = await env.DB.prepare("SELECT email FROM users WHERE id=?")
        .bind(auth.userId)
        .first<{ email: string }>()

      const checkoutUrl = await createCheckout(
        env,
        auth.organizationId,
        body.planId ?? "",
        me?.email,
        body.cycle === "annual" ? "annual" : "monthly",
      )

      return checkoutUrl
        ? json({ checkoutUrl })
        : json({ error: "Não foi possível abrir o pagamento agora. Tente novamente." }, 502)
    }

    const links = billingPlanUrls(env)
    const checkoutUrl = body.planId === "essencial"
      ? links.essencial
      : body.planId === "pro"
        ? links.pro
        : body.planId === "scale"
          ? links.scale
          : undefined

    if (!isValidInfinitePayCheckoutUrl(checkoutUrl))
      return json({ error: "O link recorrente deste plano ainda não foi configurado no sistema." }, 503)

    return json({ checkoutUrl })
  }

  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = cookie(request, "__Host-av_flow_crm_session")

    if (token)
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?")
        .bind(await sha256(token))
        .run()

    return json({ ok: true }, 200, {
      "set-cookie":
        "__Host-av_flow_crm_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    })
  }

  if (url.pathname === "/api/me") {
    const data =
      await env.DB.prepare(`SELECT u.name,u.email,o.name organization,m.role FROM users u
      JOIN organization_members m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
      WHERE u.id=? AND o.id=?`)
        .bind(auth.userId, auth.organizationId)
        .first()

    return json({ ...data, subscription: await subscriptionFor(env, auth.organizationId) })
  }

  if (url.pathname === "/api/me/email" && request.method === "PUT") {
    const body = await request.json<{ email?: string; password?: string }>().catch(() => ({}) as { email?: string; password?: string })
    const email = body.email?.toLowerCase().trim() ?? ""

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160)
      return json({ error: "Informe um e-mail válido." }, 400)

    const user = await env.DB.prepare(
      "SELECT password_hash,password_salt FROM users WHERE id=?",
    )
      .bind(auth.userId)
      .first<{ password_hash: string; password_salt: string }>()

    if (
      !user ||
      !constantTimeEqual(
        await passwordHash(body.password ?? "", user.password_salt),
        user.password_hash,
      )
    )
      return json({ error: "Senha atual incorreta." }, 403)

    const taken = await env.DB.prepare(
      "SELECT 1 x FROM users WHERE email=? COLLATE NOCASE AND id<>?",
    )
      .bind(email, auth.userId)
      .first()

    if (taken) return json({ error: "Este e-mail já está em uso." }, 409)

    await env.DB.prepare("UPDATE users SET email=? WHERE id=?")
      .bind(email, auth.userId)
      .run()

    return json({ ok: true, email })
  }

  if (!(await hasAccess(env, auth.organizationId)))
    return json(
      {
        error: "Seu período de teste terminou. Assine um plano para continuar.",
        code: "subscription_required",
      },
      402,
    )

  if (url.pathname === "/api/dashboard") {
    const metrics = await env.DB.prepare(`SELECT COUNT(*) leads,
      COALESCE(SUM(status='qualified'),0) qualified,
      COALESCE(SUM(status='hot'),0) hot,
      COALESCE(SUM(status='sold'),0) sold,
      COALESCE(SUM(status NOT IN ('sold','lost','cold')),0) active FROM leads WHERE organization_id=?`)
      .bind(auth.organizationId)
      .first()

    const seats = await seatsUsed(env, auth.organizationId)

    return json({ ...metrics, seats, seatLimit: PLAN_USER_LIMIT })
  }

  if (url.pathname === "/api/reports") {
    const byStatus = await env.DB.prepare(
      `SELECT ${effectiveLeadStatus("l")} status, COUNT(*) count FROM leads l WHERE l.organization_id=? GROUP BY ${effectiveLeadStatus("l")}`,
    )
      .bind(auth.organizationId)
      .all()

    const sales = await env.DB.prepare(
      "SELECT COUNT(*) count, COALESCE(SUM(amount_cents),0) totalCents FROM sales WHERE organization_id=?",
    )
      .bind(auth.organizationId)
      .first()

    return json({ byStatus: byStatus.results, sales })
  }

  if (url.pathname === "/api/leads" && request.method === "GET") {
    return json(
      await env.DB.prepare(`SELECT l.id,${effectiveLeadStatus("l")} status,l.product_interest productInterest,l.notes,l.next_action nextAction,l.follow_up_at followUpAt,
      l.loss_reason lossReason,l.ai_score aiScore,l.ai_summary aiSummary,l.updated_at updatedAt,c.name,c.phone_e164 phone,c.email,
      (SELECT amount_cents FROM sales s WHERE s.lead_id=l.id AND s.organization_id=l.organization_id ORDER BY s.created_at DESC LIMIT 1) saleCents
      FROM leads l JOIN contacts c ON c.id=l.contact_id AND c.organization_id=l.organization_id
      WHERE l.organization_id=? ORDER BY l.updated_at DESC LIMIT 500`)
        .bind(auth.organizationId)
        .all(),
    )
  }

  if (url.pathname === "/api/leads/import" && request.method === "POST") {
    if (auth.role !== "admin" && auth.role !== "manager")
      return json({ error: "Apenas administradores e gerentes podem importar contatos." }, 403)
    const body = await request.json<{ contacts?: unknown }>()
    if (!Array.isArray(body.contacts) || body.contacts.length === 0)
      return json({ error: "Envie uma lista de contatos para importar." }, 400)
    if (body.contacts.length > 500)
      return json({ error: "Importe no máximo 500 contatos por arquivo." }, 413)

    let invalid = 0
    let duplicates = 0
    const unique = new Map<
      string,
      { phone: string; name: string | null; email: string | null; productInterest: string | null }
    >()
    for (const item of body.contacts) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        invalid++
        continue
      }
      const row = item as Record<string, unknown>
      const phone = normalizePhone(row.phone)
      if (!phone) {
        invalid++
        continue
      }
      if (unique.has(phone)) {
        duplicates++
        continue
      }
      const email = text(row.email, 160)
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        invalid++
        continue
      }
      unique.set(phone, {
        phone,
        name: text(row.name, 120),
        email,
        productInterest: text(row.productInterest, 160),
      })
    }

    const rows = [...unique.values()]
    const existingContacts = new Map<string, { id: string; phone: string }>()
    for (let offset = 0; offset < rows.length; offset += 80) {
      const batch = rows.slice(offset, offset + 80)
      const result = await env.DB.prepare(
        `SELECT id,phone_e164 phone FROM contacts
         WHERE organization_id=? AND phone_e164 IN (${batch.map(() => "?").join(",")})`,
      )
        .bind(auth.organizationId, ...batch.map((row) => row.phone))
        .all<{ id: string; phone: string }>()
      for (const contact of result.results)
        existingContacts.set(contact.phone, contact)
    }

    const existingLeadContacts = new Set<string>()
    const contactIds = [...existingContacts.values()].map((contact) => contact.id)
    for (let offset = 0; offset < contactIds.length; offset += 80) {
      const batch = contactIds.slice(offset, offset + 80)
      if (!batch.length) continue
      const result = await env.DB.prepare(
        `SELECT contact_id contactId FROM leads
         WHERE organization_id=? AND contact_id IN (${batch.map(() => "?").join(",")})`,
      )
        .bind(auth.organizationId, ...batch)
        .all<{ contactId: string }>()
      for (const lead of result.results) existingLeadContacts.add(lead.contactId)
    }

    const statementBatches: D1PreparedStatement[][] = []
    let pendingStatements: D1PreparedStatement[] = []
    let created = 0
    for (const row of rows) {
      const existing = existingContacts.get(row.phone)
      if (existing && existingLeadContacts.has(existing.id)) {
        duplicates++
        continue
      }
      const contactId = existing?.id ?? id()
      const leadId = id()
      const rowStatements: D1PreparedStatement[] = []
      if (!existing)
        rowStatements.push(
          env.DB.prepare(
            "INSERT INTO contacts(id,organization_id,name,phone_e164,email) VALUES(?,?,?,?,?)",
          ).bind(
            contactId,
            auth.organizationId,
            row.name,
            row.phone,
            row.email,
          ),
        )
      rowStatements.push(
        env.DB.prepare(
          "INSERT INTO leads(id,organization_id,contact_id,status,product_interest,owner_id) VALUES(?,?,?,'new',?,?)",
        ).bind(
          leadId,
          auth.organizationId,
          contactId,
          row.productInterest,
          auth.userId,
        ),
        env.DB.prepare(
          "INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,NULL,'new',?)",
        ).bind(id(), auth.organizationId, leadId, auth.userId),
      )
      if (pendingStatements.length + rowStatements.length > 90) {
        statementBatches.push(pendingStatements)
        pendingStatements = []
      }
      pendingStatements.push(...rowStatements)
      created++
    }
    if (pendingStatements.length) statementBatches.push(pendingStatements)
    for (const batch of statementBatches) await env.DB.batch(batch)
    await audit(env, auth, "contacts.imported", "contact")
    return json({ ok: true, created, duplicates, invalid })
  }

  if (url.pathname === "/api/leads" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>()

    const phone = normalizePhone(body.phone),
      name = text(body.name, 120)

    if (!phone)
      return json(
        {
          error:
            "Telefone inválido. Informe DDD e número (ex.: 11 91234-5678).",
        },
        400,
      )

    if (!name) return json({ error: "Informe o nome do contato." }, 400)

    const exists = await env.DB.prepare(
      "SELECT 1 x FROM contacts WHERE organization_id=? AND phone_e164=?",
    )
      .bind(auth.organizationId, phone)
      .first()

    if (exists)
      return json({ error: "Já existe um contato com esse telefone." }, 409)

    const contactId = id(),
      leadId = id()

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO contacts(id,organization_id,name,phone_e164,email) VALUES(?,?,?,?,?)",
      ).bind(
        contactId,
        auth.organizationId,
        name,
        phone,
        text(body.email, 160),
      ),

      env.DB.prepare(
        "INSERT INTO leads(id,organization_id,contact_id,status,product_interest,notes,owner_id) VALUES(?,?,?,'new',?,?,?)",
      )

        .bind(
          leadId,
          auth.organizationId,
          contactId,
          text(body.productInterest, 160),
          text(body.notes, 2000),
          auth.userId,
        ),

      env.DB.prepare(
        "INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,NULL,'new',?)",
      ).bind(id(), auth.organizationId, leadId, auth.userId),
    ])

    await audit(env, auth, "lead.created", "lead", leadId)

    return json({ ok: true, id: leadId }, 201)
  }

  const saleMatch = url.pathname.match(/^\/api\/leads\/([\w-]+)\/sale$/)

  if (saleMatch && request.method === "POST") {
    const leadId = saleMatch[1]!,
      body = await request.json<{ amount?: number; soldAt?: string }>()

    const amount = Number(body.amount),
      soldAt = body.soldAt ? new Date(body.soldAt) : new Date()

    if (!Number.isFinite(amount) || amount < 0 || amount > 1e9)
      return json({ error: "Valor da venda inválido." }, 400)

    if (Number.isNaN(soldAt.getTime()) || soldAt.getTime() > Date.now() + 864e5)
      return json({ error: "Data da venda inválida." }, 400)

    const lead = await env.DB.prepare(
      `SELECT ${effectiveLeadStatus("leads")} status FROM leads WHERE id=? AND organization_id=?`,
    )
      .bind(leadId, auth.organizationId)
      .first<{ status: string }>()

    if (!lead) return json({ error: "Lead não encontrado." }, 404)

    if (lead.status === "sold")
      return json({ error: "Este lead já tem uma venda registrada." }, 409)

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO sales(id,organization_id,lead_id,amount_cents,sold_at,confirmed_by) VALUES(?,?,?,?,?,?)",
      )

        .bind(
          id(),
          auth.organizationId,
          leadId,
          Math.round(amount * 100),
          soldAt.toISOString(),
          auth.userId,
        ),

      env.DB.prepare(
        "UPDATE leads SET status='sold',financial_pending=0,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      ).bind(leadId, auth.organizationId),

      env.DB.prepare(
        "INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,?,'sold',?)",
      ).bind(id(), auth.organizationId, leadId, lead.status, auth.userId),
    ])

    await audit(env, auth, "sale.confirmed", "lead", leadId)

    return json({ ok: true }, 201)
  }

  if (url.pathname.startsWith("/api/leads/") && request.method === "PATCH") {
    const leadId = url.pathname.split("/").pop()!,
      body = await request.json<Record<string, unknown>>()

    const lead = await env.DB.prepare(
      `SELECT ${effectiveLeadStatus("leads")} status FROM leads WHERE id=? AND organization_id=?`,
    )
      .bind(leadId, auth.organizationId)
      .first<{ status: string }>()

    if (!lead) return json({ error: "Lead não encontrado." }, 404)

    const sets: string[] = [],
      values: unknown[] = []

    const fields: Array<[string, string, number]> = [
      ["productInterest", "product_interest", 160],
      ["notes", "notes", 2000],
      ["nextAction", "next_action", 300],
      ["lossReason", "loss_reason", 300],
    ]

    for (const [key, column, max] of fields)
      if (key in body) {
        sets.push(`${column}=?`)
        values.push(text(body[key], max))
      }

    if ("followUpAt" in body) {
      const date = body.followUpAt ? new Date(String(body.followUpAt)) : null

      if (date && Number.isNaN(date.getTime()))
        return json({ error: "Data de follow-up inválida." }, 400)

      sets.push("follow_up_at=?")
      values.push(date ? date.toISOString() : null)
    }

    const statements: D1PreparedStatement[] = []

    if ("status" in body && body.status !== lead.status) {
      if (
        typeof body.status !== "string" ||
        !LEAD_STATUSES.includes(body.status)
      )
        return json({ error: "Status inválido." }, 400)

      if (body.status === "sold")
        return json(
          { error: 'Use "Registrar venda" para informar valor e data.' },
          422,
        )

      if (lead.status === "sold")
        return json({ error: "Leads vendidos não podem mudar de status." }, 422)

      sets.push("status=?", "financial_pending=?", "ai_score=CASE WHEN ?=1 THEN MIN(COALESCE(ai_score,69),69) ELSE ai_score END")
      values.push(body.status === "financial_pending" ? "follow_up" : body.status, body.status === "financial_pending" ? 1 : 0, body.status === "financial_pending" ? 1 : 0)

      statements.push(
        env.DB.prepare(
          "INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,?,?,?)",
        )

          .bind(
            id(),
            auth.organizationId,
            leadId,
            lead.status,
            body.status,
            auth.userId,
          ),
      )
    }

    if (!sets.length) return json({ error: "Nada para atualizar." }, 400)

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE leads SET ${sets.join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
      ).bind(...values, leadId, auth.organizationId),

      ...statements,
    ])

    await audit(env, auth, "lead.updated", "lead", leadId)

    return json({ ok: true })
  }

  if (url.pathname === "/api/team" && request.method === "GET") {
    const members =
      await env.DB.prepare(`SELECT u.id,u.name,u.email,m.role,m.status FROM organization_members m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=? ORDER BY m.created_at`)
        .bind(auth.organizationId)
        .all()

    const invites =
      auth.role === "admin"
        ? await env.DB.prepare(`SELECT id,email,role,expires_at expiresAt FROM invitations
      WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC`)
            .bind(auth.organizationId)
            .all()
        : { results: [] }

    return json({
      members: members.results,
      invites: invites.results,
      seats: await seatsUsed(env, auth.organizationId),
      seatLimit: PLAN_USER_LIMIT,
    })
  }

  if (url.pathname.startsWith("/api/team/")) {
    if (auth.role !== "admin")
      return json(
        { error: "Apenas administradores podem gerenciar a equipe." },
        403,
      )

    if (url.pathname === "/api/team/invites" && request.method === "POST") {
      const body = await request.json<{ email?: string; role?: string }>()

      const email = body.email?.trim().toLowerCase()

      if (
        !email ||
        !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
        !body.role ||
        !ROLES.includes(body.role)
      )
        return json({ error: "Informe um e-mail válido e um papel." }, 400)

      if (
        await env.DB.prepare("SELECT 1 x FROM users WHERE email=?")
          .bind(email)
          .first()
      )
        return json({ error: "Já existe uma conta com esse e-mail." }, 409)

      if ((await seatsUsed(env, auth.organizationId)) >= PLAN_USER_LIMIT)
        return json(
          { error: `O plano inicial permite até ${PLAN_USER_LIMIT} usuários.` },
          403,
        )

      const token = `${id()}${id()}`,
        inviteId = id()

      await env.DB.prepare(
        "INSERT INTO invitations(id,organization_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,?,datetime('now','+7 days'))",
      )

        .bind(
          inviteId,
          auth.organizationId,
          email,
          body.role,
          await sha256(token),
          auth.userId,
        )
        .run()

      await audit(env, auth, "team.invited", "invitation", inviteId)

      return json(
        {
          ok: true,
          link: `${new URL(env.APP_ORIGIN).origin}/?invite=${token}`,
        },
        201,
      )
    }

    const inviteMatch = url.pathname.match(/^\/api\/team\/invites\/([\w-]+)$/)

    if (inviteMatch && request.method === "DELETE") {
      await env.DB.prepare(
        "UPDATE invitations SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND accepted_at IS NULL",
      )
        .bind(inviteMatch[1], auth.organizationId)
        .run()

      await audit(
        env,
        auth,
        "team.invite_revoked",
        "invitation",
        inviteMatch[1],
      )

      return json({ ok: true })
    }

    const memberMatch = url.pathname.match(/^\/api\/team\/members\/([\w-]+)$/)

    if (memberMatch && request.method === "PATCH") {
      const body = await request.json<{ role?: string; status?: string }>()

      if (memberMatch[1] === auth.userId)
        return json({ error: "Você não pode alterar o próprio acesso." }, 422)

      const sets: string[] = [],
        values: unknown[] = []

      if (body.role) {
        if (!ROLES.includes(body.role))
          return json({ error: "Papel inválido." }, 400)
        sets.push("role=?")
        values.push(body.role)
      }

      if (body.status) {
        if (!["active", "disabled"].includes(body.status))
          return json({ error: "Status inválido." }, 400)
        sets.push("status=?")
        values.push(body.status)
      }

      if (!sets.length) return json({ error: "Nada para atualizar." }, 400)

      if (
        body.status === "active" &&
        (await seatsUsed(env, auth.organizationId)) >= PLAN_USER_LIMIT
      )
        return json(
          { error: `O plano inicial permite até ${PLAN_USER_LIMIT} usuários.` },
          403,
        )

      const result = await env.DB.prepare(
        `UPDATE organization_members SET ${sets.join(",")} WHERE organization_id=? AND user_id=?`,
      )
        .bind(...values, auth.organizationId, memberMatch[1])
        .run()

      if (!result.meta.changes)
        return json({ error: "Membro não encontrado." }, 404)

      await audit(env, auth, "team.member_updated", "user", memberMatch[1])

      return json({ ok: true })
    }
  }

  const quickReplies = await quickReplyRoutes(request, env, url, auth)
  if (quickReplies) return quickReplies

  const ai = await aiRoutes(request, env, url, auth)

  if (ai) return ai

  const workflows = await workflowRoutes(request, env, url, auth)

  if (workflows) return workflows

  const catalog = await catalogRoutes(request, env, url, auth)

  if (catalog) return catalog

  const branding = await brandingRoutes(request, env, url, auth)

  if (branding) return branding

  const whatsapp = await whatsappRoutes(
    request,
    env,
    url,
    auth,
    (task) => ctx.waitUntil(task),
  )

  if (whatsapp) return whatsapp

  const webchat = await webchatRoutes(request, env, url, auth)
  if (webchat) return webchat

  const gmail = await gmailRoutes(request, env, url, auth)
  if (gmail) return gmail

  return json({ error: "Rota não encontrada." }, 404)
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)

    const widgetAsset = await webchatAssetRoutes(request, env, url)
    if (widgetAsset) return widgetAsset

    if (url.pathname.startsWith("/api/")) {
      try {
        const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method)

        const isWebhook = url.pathname === "/api/webhooks/meta"
        const isPublicWidget = url.pathname.startsWith("/api/widget/public/")

        const origin = request.headers.get("origin")

        if (
          isMutation &&
          !isWebhook &&
          !isPublicWidget &&
          origin &&
          origin !== env.APP_ORIGIN
        )
          return json({ error: "Origem não permitida." }, 403)

        const response = await api(request, env, url, ctx)

        const headers = new Headers(response.headers)

        headers.set("x-content-type-options", "nosniff")

        headers.set("x-frame-options", "DENY")

        headers.set("referrer-policy", "strict-origin-when-cross-origin")

        headers.set(
          "content-security-policy",
          "default-src 'self'; frame-ancestors 'none'; base-uri 'self'",
        )

        return new Response(response.body, { status: response.status, headers })
      } catch (error) {
        console.error(
          "request_failed",
          error instanceof Error ? error.message : "unknown",
        )
        return json({ error: "Erro interno." }, 500)
      }
    }

    return env.ASSETS.fetch(request)
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (event.cron === "0 6 * * *") {
      ctx.waitUntil(cleanupInactiveAccounts(env))
      ctx.waitUntil(sendBillingReminders(env))
      ctx.waitUntil(cleanupPendingWhatsappSignups(env))
    }
    ctx.waitUntil(
      (async () => {
        await recoverUnqueuedInboundMessages(env)
        await processPendingWhatsAppJobs(env)
        await recoverUnqueuedCatalogDeliveries(env)
        await processPendingCatalogDeliveries(env)
      })(),
    )
    ctx.waitUntil(processPendingWebchatJobs(env))
    if (new Date(event.scheduledTime).getUTCMinutes() % 5 === 0)
      ctx.waitUntil(syncAllGmailAccounts(env))
  },
} satisfies ExportedHandler<Env>
