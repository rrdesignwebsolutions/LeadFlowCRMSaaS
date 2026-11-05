import type { Env } from "./index"

const INFINITEPAY_API = "https://api.checkout.infinitepay.io"
const RESEND_URL = "https://api.resend.com/emails"
const PERIOD_DAYS = 30

export const TRIAL_DAYS = 7

// Plano anual: paga 10 mensalidades por 12 meses (2 meses grátis).
export const ANNUAL_MONTHS_CHARGED = 10
const ANNUAL_DAYS = 365

export type Cycle = "monthly" | "annual"

export const PLAN_PRICES: Record<string, { name: string; cents: number }> = {
  essencial: { name: "Essencial", cents: 11900 },
  pro: { name: "Pro", cents: 14900 },
  scale: { name: "Scale", cents: 24900 },
}

export type Subscription = {
  status: "trialing" | "active" | "expired"
  plan: string
  endsAt: string | null
  daysLeft: number
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )

export const dynamicBillingEnabled = (env: Env) => Boolean(env.INFINITEPAY_API_KEY)

// Superadmins da plataforma nunca são bloqueados.
export async function subscriptionFor(
  env: Env,
  organizationId: string,
): Promise<Subscription> {
  const row = await env.DB.prepare(
    `SELECT s.status, s.plan, s.period_ends_at endsAt,
        COALESCE(s.period_ends_at > CURRENT_TIMESTAMP, 0) valid,
        COALESCE(CAST(julianday(s.period_ends_at) - julianday('now') AS REAL), 0) days,
        EXISTS(SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
               WHERE m.organization_id = s.organization_id AND u.platform_role = 'superadmin') exempt
     FROM subscriptions s WHERE s.organization_id = ?`,
  )
    .bind(organizationId)
    .first<{
      status: string
      plan: string
      endsAt: string | null
      valid: number
      days: number
      exempt: number
    }>()

  if (!row) return { status: "expired", plan: "starter", endsAt: null, daysLeft: 0 }

  if (row.exempt)
    return { status: "active", plan: row.plan, endsAt: row.endsAt, daysLeft: 9999 }

  if (!row.valid)
    return { status: "expired", plan: row.plan, endsAt: row.endsAt, daysLeft: 0 }

  return {
    status: row.status === "active" ? "active" : "trialing",
    plan: row.plan,
    endsAt: row.endsAt,
    daysLeft: Math.max(1, Math.ceil(row.days)),
  }
}

export const hasAccess = async (env: Env, organizationId: string) =>
  (await subscriptionFor(env, organizationId)).status !== "expired"

export async function createCheckout(
  env: Env,
  organizationId: string,
  planId: string,
  customerEmail?: string,
  cycle: Cycle = "monthly",
) {
  const plan = PLAN_PRICES[planId]

  if (!plan || !env.INFINITEPAY_API_KEY) return null

  const annual = cycle === "annual"
  const cents = annual ? plan.cents * ANNUAL_MONTHS_CHARGED : plan.cents
  const days = annual ? ANNUAL_DAYS : PERIOD_DAYS

  const orderNsu = `${organizationId}_${crypto.randomUUID().slice(0, 8)}`

  const response = await fetch(`${INFINITEPAY_API}/links`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.INFINITEPAY_API_KEY,
    },
    body: JSON.stringify({
      handle: env.INFINITEPAY_HANDLE,
      order_nsu: orderNsu,
      redirect_url: `${env.APP_ORIGIN}/`,
      items: [
        {
          quantity: 1,
          price: cents,
          description: `AV Flow CRM ${plan.name} - ${annual ? "anual" : "mensal"}`,
        },
      ],
      ...(customerEmail ? { customer: { email: customerEmail } } : {}),
      webhook: {
        url: `${env.APP_ORIGIN}/api/billing/webhook/infinitepay`,
        events: ["paid"],
      },
      options: { single_payment: true },
    }),
  })

  if (!response.ok) {
    console.error("infinitepay_link_failed", response.status)

    return null
  }

  const data = await response.json<Record<string, unknown>>().catch(() => ({}))

  const url = [data.url, data.checkout_url, data.link, data.link_url].find(
    (v): v is string => typeof v === "string" && v.startsWith("https://"),
  )

  if (!url) {
    console.error("infinitepay_link_missing_url")

    return null
  }

  await env.DB.prepare(
    "INSERT INTO billing_orders(order_nsu,organization_id,plan,amount_cents,period_days) VALUES(?,?,?,?,?)",
  )
    .bind(orderNsu, organizationId, planId, cents, days)
    .run()

  return url
}

// Confirma o pagamento direto na InfinitePay (nunca confia no payload recebido)
// e estende o acesso. Idempotente: cada pedido só é creditado uma vez.
export async function confirmOrder(
  env: Env,
  input: {
    orderNsu?: unknown
    transactionNsu?: unknown
    slug?: unknown
    organizationId?: string
  },
): Promise<"activated" | "ignored" | "error"> {
  const { orderNsu, transactionNsu, slug } = input

  if (typeof orderNsu !== "string" || !env.INFINITEPAY_API_KEY) return "ignored"

  const order = await env.DB.prepare(
    "SELECT organization_id organizationId,     plan, amount_cents amount, period_days days FROM billing_orders WHERE order_nsu=? AND status='pending'",
  )
    .bind(orderNsu)
        .first<{ organizationId: string; plan: string; amount: number; days: number }>()

  if (!order) return "ignored"

  if (input.organizationId && order.organizationId !== input.organizationId)
    return "ignored"

  let check: Record<string, unknown>

  try {
    const response = await fetch(`${INFINITEPAY_API}/payment_check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.INFINITEPAY_API_KEY,
      },
      body: JSON.stringify({
        handle: env.INFINITEPAY_HANDLE,
        order_nsu: orderNsu,
        transaction_nsu: transactionNsu,
        slug,
      }),
    })

    if (!response.ok) return "error"

    check = await response.json<Record<string, unknown>>()
  } catch {
    return "error"
  }

  const paidAmount = Number(check.paid_amount ?? check.amount ?? 0)

  if (check.paid !== true || paidAmount < order.amount) return "ignored"

  const claimed = await env.DB.prepare(
    "UPDATE billing_orders SET status='paid', paid_at=CURRENT_TIMESTAMP, transaction_nsu=? WHERE order_nsu=? AND status='pending'",
  )
    .bind(typeof transactionNsu === "string" ? transactionNsu : null, orderNsu)
    .run()

  if (!claimed.meta.changes) return "ignored"

  await env.DB.prepare(
    `UPDATE subscriptions SET status='active', plan=?1, reminder_stage=0, updated_at=CURRENT_TIMESTAMP,
       period_ends_at=datetime(MAX(COALESCE(period_ends_at, CURRENT_TIMESTAMP), CURRENT_TIMESTAMP), ?2)
     WHERE organization_id=?3`,
  )
    .bind(order.plan, `+${order.days} days`, order.organizationId)
    .run()

  return "activated"
}

async function sendEmail(env: Env, to: string, subject: string, html: string, text: string) {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject, html, text }),
  })

  if (!response.ok) console.error("billing_email_failed", response.status)

  return response.ok
}

type Candidate = {
  organizationId: string
  status: string
  stage: number
  expired: number
  expiredDays: number
  soon: number
}

const messages = (trial: boolean, stage: 1 | 2 | 3) => {
  const what = trial ? "teste grátis" : "assinatura"

  if (stage === 1)
    return {
      subject: `Seu ${what} do AV Flow CRM termina em breve`,
      lead: `Seu ${what} termina em menos de 2 dias. Assine um plano para continuar usando o AV Flow CRM sem interrupção.`,
    }

  if (stage === 2)
    return {
      subject: `Seu acesso ao AV Flow CRM foi suspenso`,
      lead: `Seu ${what} terminou e o acesso foi suspenso. Seus dados estão guardados: assine um plano para voltar de onde parou.`,
    }

  return {
    subject: "Seus dados do AV Flow CRM ainda estão esperando por você",
    lead: "Faz alguns dias que seu acesso foi suspenso. Assine um plano para recuperar o acesso imediatamente, com todos os seus leads e conversas.",
  }
}

export async function sendBillingReminders(env: Env) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: 0 }

  const rows = await env.DB.prepare(
    `SELECT s.organization_id organizationId, s.status, s.reminder_stage stage,
        (s.period_ends_at <= CURRENT_TIMESTAMP) expired,
        (s.period_ends_at <= datetime('now', '-3 days')) expiredDays,
        (s.period_ends_at <= datetime('now', '+2 days')) soon
     FROM subscriptions s
     WHERE s.reminder_stage < 3 AND s.period_ends_at IS NOT NULL
       AND s.period_ends_at <= datetime('now', '+2 days')
       AND NOT EXISTS(SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
                      WHERE m.organization_id = s.organization_id AND u.platform_role = 'superadmin')`,
  ).all<Candidate>()

  let sent = 0

  for (const row of rows.results) {
    const next: 1 | 2 | 3 | 0 =
      row.expiredDays && row.stage < 3
        ? 3
        : row.expired && row.stage < 2
          ? 2
          : row.soon && !row.expired && row.stage < 1
            ? 1
            : 0

    if (!next) continue

    const admins = await env.DB.prepare(
      `SELECT u.email, u.name FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ? AND m.role = 'admin' AND m.status = 'active' AND u.email_verified_at IS NOT NULL`,
    )
      .bind(row.organizationId)
      .all<{ email: string; name: string }>()

    const { subject, lead } = messages(row.status === "trialing", next)

    let delivered = false

    for (const admin of admins.results) {
      const ok = await sendEmail(
        env,
        admin.email,
        subject,
        `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2933">
          <h2>Olá, ${escapeHtml(admin.name)}!</h2>
          <p>${lead}</p>
          <p><a href="${env.APP_ORIGIN}/" style="display:inline-block;background:#0d8a57;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Escolher meu plano</a></p>
        </div>`,
        `Olá, ${admin.name}! ${lead} Escolha seu plano: ${env.APP_ORIGIN}/`,
      )

      delivered ||= ok
    }

    if (delivered) {
      sent++

      await env.DB.prepare("UPDATE subscriptions SET reminder_stage=? WHERE organization_id=?")
        .bind(next, row.organizationId)
        .run()
    }
  }

  return { sent }
}
