import type { Env, Session } from "./index"

import { escapeHtml, sendNotificationEmail } from "./verification"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,

    headers: { "content-type": "application/json" },
  })

export async function supportRoutes(
  request: Request,

  env: Env,

  auth: Session,
) {
  if (new URL(request.url).pathname !== "/api/support") return null

  if (request.method !== "POST")
    return json({ error: "Método não permitido." }, 405)

  const body = await request

    .json<{ email?: string message?: string }>()

    .catch(() => ({}))

  const email = body.email?.trim().toLowerCase() ?? ""

  const message = body.message?.trim() ?? ""

  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 160 ||
    message.length < 10 ||
    message.length > 4000
  )
    return json(
      {
        error:
          "Informe um e-mail válido e uma mensagem de 10 a 4000 caracteres.",
      },

      400,
    )

  const recipient = env.SUPPORT_EMAIL?.trim()

  if (!recipient || !env.RESEND_API_KEY || !env.EMAIL_FROM)
    return json(
      { error: "O envio do suporte está temporariamente indisponível." },

      503,
    )

  const sender = await env.DB.prepare(
    `SELECT u.name userName,o.name organization
     FROM users u
     JOIN organization_members m
       ON m.user_id=u.id AND m.organization_id=? AND m.status='active'
     JOIN organizations o ON o.id=m.organization_id
     WHERE u.id=?`,
  )

    .bind(auth.organizationId, auth.userId)

    .first<{ userName: string organization: string }>()

  if (!sender) return json({ error: "Conta não encontrada." }, 404)

  const id = crypto.randomUUID()

  const inserted = await env.DB.prepare(
    `INSERT INTO support_messages(id,organization_id,user_id,reply_email,message)
     SELECT ?,?,?,?,?
     WHERE NOT EXISTS (
       SELECT 1 FROM support_messages
       WHERE organization_id=? AND user_id=?
         AND created_at>datetime('now','-60 seconds')
     )`,
  )

    .bind(
      id,

      auth.organizationId,

      auth.userId,

      email,

      message,

      auth.organizationId,

      auth.userId,
    )

    .run()

  if (!inserted.meta.changes)
    return json(
      { error: "Aguarde um minuto antes de enviar outra mensagem." },

      429,
    )

  const safeEmail = escapeHtml(email)

  const safeName = escapeHtml(sender.userName)

  const safeOrganization = escapeHtml(sender.organization)

  const safeMessage = escapeHtml(message).replace(/\n/g, "<br>")

  let sent = false

  try {
    sent = await sendNotificationEmail(
      env,

      [recipient],

      `Solicitação de suporte — ${sender.organization}`,

      `<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#1f2933">
        <h2>Nova solicitação de suporte</h2>
        <p><b>Empresa:</b> ${safeOrganization}</p>
        <p><b>Nome:</b> ${safeName}</p>
        <p><b>E-mail para retorno:</b> ${safeEmail}</p>
        <hr>
        <p>${safeMessage}</p>
        <p style="color:#6b7280;font-size:12px">Protocolo: ${id}</p>
      </div>`,

      {
        text: `Nova solicitação de suporte\nEmpresa: ${sender.organization}\nNome: ${sender.userName}\nE-mail: ${email}\n\n${message}\n\nProtocolo: ${id}`,

        replyTo: email,
      },
    )
  } catch (error) {
    console.error("support_email_failed", {
      organizationId: auth.organizationId,

      reason: error instanceof Error ? error.name : "unknown",
    })
  }

  if (!sent) {
    await env.DB.prepare(
      "UPDATE support_messages SET status='failed' WHERE id=? AND organization_id=?",
    )

      .bind(id, auth.organizationId)

      .run()

    return json(
      {
        error:
          "Não foi possível enviar sua mensagem. Tente novamente mais tarde.",
      },

      502,
    )
  }

  await env.DB.prepare(
    "UPDATE support_messages SET status='sent',sent_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
  )

    .bind(id, auth.organizationId)

    .run()

  return json({ ok: true, message: "Mensagem enviada ao suporte." }, 201)
}
