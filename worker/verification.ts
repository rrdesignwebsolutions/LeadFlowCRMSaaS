import type { Env } from "./index"

const RESEND_URL = "https://api.resend.com/emails"
const TOKEN_HOURS = 24
const RESEND_COOLDOWN_SECONDS = 120

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )

  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// A confirmação só é exigida quando o envio de e-mail está configurado.
export const emailVerificationEnabled = (env: Env) =>
  Boolean(env.RESEND_API_KEY && env.EMAIL_FROM)

export async function sendVerificationEmail(
  env: Env,
  userId: string,
  email: string,
  name: string,
) {
  const bytes = crypto.getRandomValues(new Uint8Array(32))

  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")

  await env.DB.prepare(
    "INSERT INTO email_verifications(id,user_id,token_hash,expires_at) VALUES(?,?,?,datetime('now', ?))",
  )
    .bind(crypto.randomUUID(), userId, await hash(token), `+${TOKEN_HOURS} hours`)
    .run()

  const link = `${env.APP_ORIGIN}/?verify=${token}`

  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: "Confirme seu e-mail no AV Flow CRM",
      html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1f2933">
        <h2>Olá, ${escapeHtml(name)}!</h2>
        <p>Falta só um passo para ativar sua conta no AV Flow CRM.</p>
        <p><a href="${link}" style="display:inline-block;background:#0d8a57;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Confirmar meu e-mail</a></p>
        <p style="font-size:13px;color:#6b7280">O link vale por ${TOKEN_HOURS} horas. Se você não criou esta conta, ignore esta mensagem.</p>
      </div>`,
      text: `Olá, ${name}! Confirme seu e-mail para ativar sua conta: ${link} (válido por ${TOKEN_HOURS} horas).`,
    }),
  })

  if (!response.ok) {
    console.error("verification_email_failed", response.status)

    return false
  }

  return true
}

export async function canResend(env: Env, userId: string) {
  const recent = await env.DB.prepare(
    "SELECT 1 FROM email_verifications WHERE user_id=? AND created_at > datetime('now', ?) LIMIT 1",
  )
    .bind(userId, `-${RESEND_COOLDOWN_SECONDS} seconds`)
    .first()

  return !recent
}

// Consome o token e devolve o usuário confirmado, ou null se for inválido.
export async function consumeVerificationToken(env: Env, token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null

  const row = await env.DB.prepare(
    "SELECT user_id userId FROM email_verifications WHERE token_hash=? AND expires_at > CURRENT_TIMESTAMP",
  )
    .bind(await hash(token))
    .first<{ userId: string }>()

  if (!row) return null

  await env.DB.batch([
    env.DB.prepare(
      "UPDATE users SET email_verified_at=COALESCE(email_verified_at,CURRENT_TIMESTAMP) WHERE id=?",
    ).bind(row.userId),
    env.DB.prepare("DELETE FROM email_verifications WHERE user_id=?").bind(
      row.userId,
    ),
  ])

  return row.userId
}
