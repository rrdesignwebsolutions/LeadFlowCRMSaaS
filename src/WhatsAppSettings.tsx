import { useCallback, useEffect, useRef, useState } from "react"

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
          : `Número ${result.displayPhoneNumber} conectado. A ativação do canal ainda está sendo concluída; atualize em instantes.`,
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
  const canConnect = !!(
    data?.embeddedSignup.appId &&
    data.embeddedSignup.configId &&
    ready?.appSecret &&
    ready.verifyToken &&
    ready.encryptionKey
  )

  const label = !i
    ? "Não conectado"
    : i.status === "connected"
      ? "Conectado"
      : "Com erro"

  return (
    <section className="panel spaced whatsapp-settings">
      <div className="panel-title">
        <div>
          <p className="eyebrow green">CANAIS DE ATENDIMENTO</p>
          <h2>WhatsApp Business</h2>
          <p>Conecte seu número oficial e prepare seu canal de atendimento para trabalhar com o AV Flow CRM.</p>
        </div>
        <span className={`tag ${i?.status === "connected" ? "ok" : "warning"}`}>
          {data ? label : "Verificando"}
        </span>
      </div>
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
      {note && <p className="callout-text">{note}</p>}
      {i && (
        <div className="whatsapp-connected">
          <span className="whatsapp-connected-mark">✓</span>
          <span><b>Número conectado</b><small>{i.displayPhoneNumber ?? i.phoneNumberId}</small></span>
          {i.errorSummary && <span className="whatsapp-connection-issue">Verifique a conexão no WhatsApp Business.</span>}
        </div>
      )}
      {i && isAdmin && (
        <button className="button secondary" onClick={() => void disconnect()}>
          Desconectar
        </button>
      )}

      {!i && (
        <div className="whatsapp-connect-panel">
          <div className="whatsapp-benefits">
            <span><b>Plataforma oficial</b><small>Conexão da sua conta empresarial pela Meta</small></span>
            <span><b>Autorização segura</b><small>Você aprova o acesso diretamente com a Meta</small></span>
            <span><b>Sem QR Code</b><small>Integração oficial, sem automação não autorizada</small></span>
          </div>
          {isAdmin ? (
            <div className="whatsapp-connect-action">
              <button
                className="button"
                type="button"
                onClick={startEmbeddedSignup}
                disabled={busy || !sdkReady || !canConnect}
              >
                {busy
                  ? "Concluindo conexão…"
                  : !canConnect
                    ? "Conexão indisponível no momento"
                    : sdkReady
                      ? "Conectar com a Meta"
                      : "Preparando conexão…"}
              </button>
              <p>Você será direcionado à Meta para autorizar sua conta WhatsApp Business.</p>
            </div>
          ) : (
            <p className="muted">Peça ao administrador da empresa para conectar o número.</p>
          )}
        </div>
      )}
      <p className="whatsapp-footnote">A conexão usa a plataforma oficial do WhatsApp Business. Não utiliza QR Code nem automação do WhatsApp Web.</p>
    </section>
  )
}
