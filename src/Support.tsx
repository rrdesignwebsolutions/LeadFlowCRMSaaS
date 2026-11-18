import { useState, type FormEvent } from "react"

import { LifeBuoy, Send } from "lucide-react"

import { api, errorMessage } from "./api"

export default function Support({ email }: { email: string }) {
  const [replyEmail, setReplyEmail] = useState(email)

  const [message, setMessage] = useState("")

  const [busy, setBusy] = useState(false)

  const [error, setError] = useState("")

  const [success, setSuccess] = useState("")

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    setBusy(true)

    setError("")

    setSuccess("")

    try {
      await api("/api/support", {
        method: "POST",

        body: { email: replyEmail, message },
      })

      setMessage("")

      setSuccess(
        "Mensagem enviada. Nossa equipe responderá pelo e-mail informado.",
      )
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow green">ESTAMOS AQUI PARA AJUDAR</p>
          <h1>Suporte</h1>
          <p>Conte para nossa equipe como podemos ajudar com o AV Flow CRM.</p>
        </div>
      </div>
      <section className="panel support-panel">
        <div className="panel-title">
          <span className="support-icon">
            <LifeBuoy size={21} />
          </span>
          <div>
            <h2>Fale com o suporte</h2>
            <p>
              Descreva sua dúvida ou problema. Responderemos no e-mail
              informado.
            </p>
          </div>
        </div>
        <form
          className="form support-form"
          onSubmit={(event) => void submit(event)}
        >
          <label>
            Seu e-mail para retorno
            <input
              type="email"
              required
              maxLength={160}
              autoComplete="email"
              value={replyEmail}
              onChange={(event) => setReplyEmail(event.target.value)}
            />
          </label>
          <label>
            Mensagem
            <textarea
              required
              minLength={10}
              maxLength={4000}
              rows={7}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Descreva como podemos ajudar..."
            />
            <small>{message.length}/4000 caracteres</small>
          </label>
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          {success && (
            <p className="support-success" role="status">
              {success}
            </p>
          )}
          <button className="button" disabled={busy}>
            <Send size={16} />
            {busy ? "Enviando..." : "Enviar mensagem"}
          </button>
        </form>
      </section>
    </>
  )
}
