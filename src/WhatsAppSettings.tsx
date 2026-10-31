import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import { Copy } from "lucide-react"

import { api, errorMessage } from "./api"

type Status = {
  integration: {
    status: string
    phoneNumberId: string
    displayPhoneNumber: string | null
    errorSummary: string | null
    connectedAt: string | null
  } | null

  webhookUrl: string

  embeddedSignup: { appId: string | null; configId: string | null }

  serverReady: {
    appSecret: boolean
    verifyToken: boolean
    encryptionKey: boolean
  }
}

type SignupAssets = { phone_number_id?: string; waba_id?: string }

type SignupState = {
  code?: string
  phoneNumberId?: string
  wabaId?: string
  processing?: boolean
}

type FacebookLoginResponse = { authResponse?: { code?: string } }

declare global {
  interface Window {
    FB?: {
      init: (options: { appId: string; xfbml: boolean; version: string }) => void

      login: (
        callback: (response: FacebookLoginResponse) => void,

        options: {
          config_id: string
          response_type: string
          override_default_response_type: boolean
          extras: { setup: Record<string, never> }
        },
      ) => void
    }

    fbAsyncInit?: () => void
  }
}

const copy = (value: string) => void navigator.clipboard.writeText(value)

export default function WhatsAppSettings({
  isAdmin,
  onChanged,
}: {
  isAdmin: boolean
  onChanged: () => void
}) {
  const [data, setData] = useState<Status | null>(null)

  const [error, setError] = useState("")

  const [note, setNote] = useState("")

  const [busy, setBusy] = useState(false)

  const [sdkReady, setSdkReady] = useState(false)

  const signupState = useRef<SignupState>({})

  const load = useCallback(async () => {
    try {
      setData(await api<Status>("/api/integrations/whatsapp"))
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const appId = data?.embeddedSignup.appId

    if (!appId) return

    let active = true

    const initialize = () => {
      window.FB?.init({ appId, xfbml: false, version: "v26.0" })

      if (active) setSdkReady(!!window.FB)
    }

    window.fbAsyncInit = initialize

    if (window.FB) {
      initialize()
    } else {
      let script = document.getElementById(
        "facebook-jssdk",
      ) as HTMLScriptElement | null

      if (!script) {
        script = document.createElement("script")

        script.id = "facebook-jssdk"

        script.src = "https://connect.facebook.net/en_US/sdk.js"

        script.async = true

        script.defer = true

        script.crossOrigin = "anonymous"

        document.head.appendChild(script)
      }

      script.addEventListener("load", initialize, { once: true })

      script.addEventListener(
        "error",
        () => {
          if (active) setError("Não foi possível carregar o SDK da Meta.")
        },
        { once: true },
      )
    }

    return () => {
      active = false
    }
  }, [data?.embeddedSignup.appId])

  const finishEmbeddedSignup = useCallback(async () => {
    const signup = signupState.current

    if (
      !signup.code ||
      !signup.phoneNumberId ||
      !signup.wabaId ||
      signup.processing
    )
      return

    signup.processing = true

    setBusy(true)
    setError("")
    setNote("")

    try {
      const result = await api<{
        displayPhoneNumber: string
        subscribed: boolean
        subscribeError?: string
      }>(
        "/api/integrations/whatsapp/embedded-signup",

        {
          method: "POST",
          body: {
            code: signup.code,
            phoneNumberId: signup.phoneNumberId,
            wabaId: signup.wabaId,
          },
        },
      )

      setNote(
        result.subscribed
          ? `Número ${result.displayPhoneNumber} conectado.`
          : `Número ${result.displayPhoneNumber} conectado, mas a assinatura do webhook falhou: ${result.subscribeError ?? "erro desconhecido"}. Verifique a configuração do webhook na Meta.`,
      )

      await load()
      onChanged()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      signupState.current = {}

      setBusy(false)
    }
  }, [load, onChanged])

  useEffect(() => {
    function receiveSignupMessage(event: MessageEvent) {
      try {
        const origin = new URL(event.origin)

        if (
          origin.protocol !== "https:" ||
          !(
            origin.hostname === "facebook.com" ||
            origin.hostname.endsWith(".facebook.com")
          )
        )
          return

        const message =
          typeof event.data === "string" ? JSON.parse(event.data) : event.data

        if (!message || message.type !== "WA_EMBEDDED_SIGNUP") return

        if (message.event === "CANCEL") {
          signupState.current = {}

          setBusy(false)

          setNote("Cadastro cancelado. Você pode tentar novamente.")

          return
        }

        if (message.event === "ERROR") {
          signupState.current = {}

          setBusy(false)

          setError(
            "A Meta informou um erro durante o cadastro incorporado. Revise as configurações do app e tente novamente.",
          )

          return
        }

        if (
          !["FINISH", "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"].includes(
            message.event,
          )
        )
          return

        const assets = message.data as SignupAssets | undefined

        signupState.current.phoneNumberId = assets?.phone_number_id

        signupState.current.wabaId = assets?.waba_id

        void finishEmbeddedSignup()
      } catch {
        setError("Não foi possível ler a resposta do cadastro da Meta.")
      }
    }

    window.addEventListener("message", receiveSignupMessage)

    return () => window.removeEventListener("message", receiveSignupMessage)
  }, [finishEmbeddedSignup])

  function startEmbeddedSignup() {
    const { appId, configId } = data?.embeddedSignup ?? {}

    if (!window.FB || !appId || !configId) {
      setError("O cadastro incorporado ainda não está configurado.")

      return
    }

    signupState.current = {}

    setError("")
    setNote("")
    setBusy(true)

    window.FB.login(
      (response) => {
        const code = response.authResponse?.code

        if (!code) {
          signupState.current = {}

          setBusy(false)

          setError(
            "A Meta não retornou o código de autorização. Confirme se concluiu o cadastro e tente novamente.",
          )

          return
        }

        signupState.current.code = code

        void finishEmbeddedSignup()
      },
      {
        config_id: configId,

        response_type: "code",

        override_default_response_type: true,

        extras: { setup: {} },
      },
    )
  }

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    setBusy(true)
    setError("")
    setNote("")

    try {
      const r = await api<{
        displayPhoneNumber: string
        subscribed: boolean
        subscribeError?: string
      }>("/api/integrations/whatsapp", {
        method: "POST",
        body: Object.fromEntries(new FormData(event.currentTarget)),
      })

      setNote(
        r.subscribed
          ? `Número ${r.displayPhoneNumber} conectado.`
          : `Número ${r.displayPhoneNumber} conectado, mas a assinatura de mensagens falhou: ${r.subscribeError ?? "erro desconhecido"}. Verifique o webhook no painel da Meta.`,
      )

      await load()
      onChanged()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (
      !confirm(
        "Desconectar o WhatsApp? O token salvo será apagado e as mensagens deixarão de chegar.",
      )
    )
      return

    setError("")
    setNote("")

    try {
      await api("/api/integrations/whatsapp", { method: "DELETE" })
      await load()
      onChanged()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const i = data?.integration

  const ready = data?.serverReady

  const label = !i
    ? "Não conectado"
    : i.status === "connected"
      ? "Conectado"
      : "Com erro"

  return (
    <section className="panel spaced">
      <div className="panel-title">
        <div>
          <h2>WhatsApp Business Platform</h2>
          <p>Integração oficial da Meta (Cloud API)</p>
        </div>
        <span className={`tag ${i?.status === "connected" ? "ok" : "warning"}`}>
          {label}
        </span>
      </div>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {note && <p className="callout-text">{note}</p>}
      {i && (
        <p className="muted">
          Número: <b>{i.displayPhoneNumber ?? i.phoneNumberId}</b>
          {i.errorSummary ? ` · ${i.errorSummary}` : ""}
        </p>
      )}
      {i && isAdmin && (
        <button className="button secondary" onClick={() => void disconnect()}>
          Desconectar
        </button>
      )}

      {!i && isAdmin && (
        <>
          <div className="steps-help">
            <p>
              Conecte uma conta comercial usando o fluxo seguro de Cadastro
              incorporado da Meta. O código de autorização é trocado no servidor
              e o token não é exibido no navegador.
            </p>
            {!data?.embeddedSignup.configId && (
              <p className="auth-error" role="alert">
                Configure o ID do cadastro incorporado no Worker antes de
                continuar.
              </p>
            )}
            {ready &&
              !(
                ready.appSecret &&
                ready.verifyToken &&
                ready.encryptionKey
              ) && (
                <p className="auth-error" role="alert">
                  Servidor incompleto — faltam:{" "}
                  {[
                    !ready.appSecret && "META_APP_SECRET",
                    !ready.verifyToken && "META_VERIFY_TOKEN",
                    !ready.encryptionKey && "ENCRYPTION_KEY",
                  ]
                    .filter(Boolean)
                    .join(", ")}
                  .
                </p>
              )}
            <button
              className="button"
              type="button"
              onClick={startEmbeddedSignup}
              disabled={busy || !sdkReady || !data?.embeddedSignup.configId}
            >
              {busy
                ? "Aguardando a Meta…"
                : sdkReady
                  ? "Conectar com a Meta"
                  : "Carregando Meta…"}
            </button>
            <p className="muted">
              Durante testes, somente administradores e desenvolvedores
              cadastrados no app da Meta podem concluir o fluxo. A conexão de
              clientes em produção depende da análise e aprovação da Meta.
            </p>
            <details>
              <summary>Configuração manual (alternativa)</summary>
              <p>
                <b>1.</b> Configure o webhook Meta em{" "}
                <b>WhatsApp → Configuração</b>, usando a URL abaixo e o secret{" "}
                <code>META_VERIFY_TOKEN</code>. Assine <b>messages</b> e{" "}
                <b>account_update</b>.
              </p>
              <div className="callout-text">
                <span className="break">
                  URL de callback: {data?.webhookUrl}
                </span>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => data && copy(data.webhookUrl)}
                >
                  <Copy size={14} /> Copiar
                </button>
              </div>
              <form className="form" onSubmit={connect}>
                <label>
                  Phone Number ID
                  <input name="phoneNumberId" required inputMode="numeric" />
                </label>
                <label>
                  WABA ID (ID da conta do WhatsApp Business)
                  <input name="wabaId" required inputMode="numeric" />
                </label>
                <label>
                  Token de acesso
                  <input
                    name="accessToken"
                    type="password"
                    required
                    autoComplete="off"
                  />
                </label>
                <div className="modal-actions">
                  <button className="button secondary" disabled={busy}>
                    {busy ? "Verificando…" : "Conectar manualmente"}
                  </button>
                </div>
              </form>
            </details>
          </div>
        </>
      )}
      {!i && !isAdmin && (
        <p className="muted">Peça a um administrador para conectar o número.</p>
      )}
      <p className="muted">
        Nenhum QR Code ou automação do WhatsApp Web é usado. O token é guardado
        criptografado e nunca é exibido.
      </p>
    </section>
  )
}
