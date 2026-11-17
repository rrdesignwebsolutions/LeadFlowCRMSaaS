import { useCallback, useEffect, useRef, useState } from "react"

import { api, errorMessage } from "./api"

type Status = {
  integration: {
    status: string
    phoneNumberId: string
    displayPhoneNumber: string | null
    connectionMode: "cloud_api" | "coexistence"
    errorSummary: string | null
    connectedAt: string | null
    historySyncStatus: "not_started" | "requesting" | "requested" | "completed" | "declined" | "failed"
    historySyncProgress: number
    historySyncError: string | null
    historySyncAvailable: number
  } | null

  webhookUrl: string

  embeddedSignup: {
    appId: string | null
    configId: string | null
    coexistenceConfigId: string | null
  }

  serverReady: {
    appSecret: boolean
    verifyToken: boolean
    encryptionKey: boolean
  }
}

type SignupAssets = {
  phone_number_id?: string;
  waba_id?: string;
}

type SignupState = {
  code?: string
  phoneNumberId?: string
  wabaId?: string
  connectionMode?: "cloud_api" | "coexistence"
  processing?: boolean
}

type FacebookLoginResponse = { authResponse?: { code?: string } }

type SignupResult =
  | { selectionRequired: true; pendingId: string; phoneNumbers: Array<{ id: string; displayPhoneNumber: string; verifiedName: string | null }> }
  | { selectionRequired?: false; displayPhoneNumber: string; subscribed: boolean; subscribeError?: string }

declare global {
  interface Window {
    FB?: {
      init: (options: {
        appId: string;
        xfbml: boolean;
        version: string;
      }) => void

      login: (
        callback: (response: FacebookLoginResponse) => void,

        options: {
          config_id: string
          response_type: string
          override_default_response_type: boolean
          extras: {
            setup?: Record<string, never>
            version?: "v4"
            featureType?: "whatsapp_business_app_onboarding"
            sessionInfoVersion?: "3"
          }
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
  const [pendingSelection, setPendingSelection] = useState<Extract<SignupResult, { selectionRequired: true }> | null>(null)
  const [selectedNumber, setSelectedNumber] = useState("")

  const signupState = useRef<SignupState>({})
  const signupTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSignupTimeout = useCallback(() => {
    if (signupTimeout.current) clearTimeout(signupTimeout.current)
    signupTimeout.current = null
  }, [])

  useEffect(() => () => clearSignupTimeout(), [clearSignupTimeout])

  const waitForSignupResult = useCallback(() => {
    if (signupTimeout.current) return
    signupTimeout.current = setTimeout(() => {
      signupTimeout.current = null
      if (signupState.current.processing) return
      signupState.current = {}
      setBusy(false)
      setError("A Meta não retornou todos os dados de autorização. A conexão não foi concluída no AV Flow; confira o status na Meta antes de tentar novamente.")
    }, 30000)
  }, [])

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
    const status = data?.integration?.historySyncStatus
    if (status !== "requesting" && status !== "requested") return

    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [data?.integration?.historySyncStatus, load])

  const showConnectionResult = useCallback(async (result: Exclude<SignupResult, { selectionRequired: true }>, mode: "cloud_api" | "coexistence") => {
    const modeLabel = mode === "coexistence" ? "modo de coexistência" : "modo Cloud API"
    setNote(result.subscribed
      ? `Número ${result.displayPhoneNumber} conectado em ${modeLabel}.${mode === "coexistence" ? " Confirme no painel da Meta os campos de webhook necessários. O histórico pode ser solicitado na seção abaixo, dentro de 24 horas, se o cliente autorizou o compartilhamento." : ""}`
      : `Número ${result.displayPhoneNumber} autorizado, mas a conexão está com erro porque a Meta não confirmou a assinatura dos eventos. ${result.subscribeError ?? "Verifique a configuração do webhook."}`)
    await load()
    onChanged()
  }, [load, onChanged])

  async function startHistorySync() {
    if (
      !window.confirm(
        "Confirme que o cliente autorizou compartilhar o histórico no WhatsApp Business App. A solicitação da Meta só pode ser feita uma vez.",
      )
    )
      return

    setBusy(true)
    setError("")
    setNote("")
    try {
      await api<{ requestId: string }>("/api/integrations/whatsapp/history-sync", {
        method: "POST",
      })
      setNote("Solicitação enviada à Meta. O histórico aparecerá na caixa de entrada assim que os webhooks forem processados.")
      await load()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

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
      !signup.wabaId ||
      (!signup.phoneNumberId && signup.connectionMode !== "coexistence") ||
      signup.processing
    )
      return

    signup.processing = true
    clearSignupTimeout()

    setBusy(true)
    setError("")
    setNote("")

    try {
      const result = await api<SignupResult>(
        "/api/integrations/whatsapp/embedded-signup",

        {
          method: "POST",
          body: {
            code: signup.code,
            phoneNumberId: signup.phoneNumberId,
            wabaId: signup.wabaId,
            connectionMode: signup.connectionMode ?? "cloud_api",
          },
        },
      )

      if (result.selectionRequired) {
        setPendingSelection(result)
        setSelectedNumber("")
      } else {
        await showConnectionResult(result, signup.connectionMode ?? "cloud_api")
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      signupState.current = {}

      setBusy(false)
    }
  }, [clearSignupTimeout, showConnectionResult])

  async function completeNumberSelection() {
    if (!pendingSelection || !selectedNumber) return
    setBusy(true)
    setError("")
    try {
      const result = await api<Exclude<SignupResult, { selectionRequired: true }>>(
        "/api/integrations/whatsapp/embedded-signup/select-number",
        { method: "POST", body: { pendingId: pendingSelection.pendingId, phoneNumberId: selectedNumber } },
      )
      setPendingSelection(null)
      await showConnectionResult(result, "coexistence")
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

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
          clearSignupTimeout()
          signupState.current = {}

          setBusy(false)

          setNote("Cadastro cancelado. Você pode tentar novamente.")

          return
        }

        if (message.event === "ERROR") {
          clearSignupTimeout()
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

        if (!signupState.current.connectionMode) return
        if (
          signupState.current.connectionMode === "coexistence" &&
          message.event !== "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"
        ) {
          clearSignupTimeout()
          signupState.current = {}
          setBusy(false)
          setError("A Meta concluiu um fluxo diferente da coexistência. A conexão não foi salva.")
          return
        }

        const assets = message.data as SignupAssets | undefined

        signupState.current.phoneNumberId = assets?.phone_number_id

        signupState.current.wabaId = assets?.waba_id
        if (message.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING")
          signupState.current.connectionMode = "coexistence"

        waitForSignupResult()
        void finishEmbeddedSignup()
      } catch {
        setError("Não foi possível ler a resposta do cadastro da Meta.")
      }
    }

    window.addEventListener("message", receiveSignupMessage)

    return () => window.removeEventListener("message", receiveSignupMessage)
  }, [clearSignupTimeout, finishEmbeddedSignup, waitForSignupResult])

  function startEmbeddedSignup(connectionMode: "cloud_api" | "coexistence") {
    const { appId } = data?.embeddedSignup ?? {}
    const configId =
      connectionMode === "coexistence"
        ? (data?.embeddedSignup.coexistenceConfigId ??
          data?.embeddedSignup.configId)
        : data?.embeddedSignup.configId

    if (!window.FB || !appId || !configId) {
      setError(
        connectionMode === "coexistence"
          ? "A configuração de coexistência da Meta ainda não está definida no servidor."
          : "O cadastro incorporado ainda não está configurado.",
      )

      return
    }

    signupState.current = { connectionMode }

    setError("")
    setNote("")
    setBusy(true)

    window.FB.login(
      (response) => {
        const code = response.authResponse?.code

        if (!code) {
          clearSignupTimeout()
          signupState.current = {}

          setBusy(false)

          setError(
            "A Meta não retornou o código de autorização. Confirme se concluiu o cadastro e tente novamente.",
          )

          return
        }

        signupState.current.code = code

        waitForSignupResult()
        void finishEmbeddedSignup()
      },
      {
        config_id: configId,

        response_type: "code",

        override_default_response_type: true,

        extras:
          connectionMode === "coexistence"
            ? {
                setup: {},
                version: "v4",
                featureType: "whatsapp_business_app_onboarding",
                sessionInfoVersion: "3",
              }
            : { setup: {} },
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
  const canConnectWithCoexistence = !!(
    canConnect && data?.embeddedSignup.coexistenceConfigId
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
          <p>
            Conecte seu número oficial e prepare seu canal de atendimento para
            trabalhar com o AV Flow CRM.
          </p>
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
          <span>
            <b>{i.status === "connected" ? "Número conectado" : "Conexão com erro"}</b>
            <small>
              {i.displayPhoneNumber ?? i.phoneNumberId} ·{" "}
              {i.connectionMode === "coexistence"
                ? "WhatsApp Business + AV Flow"
                : "Cloud API"}
            </small>
          </span>
          {i.errorSummary && (
            <span className="whatsapp-connection-issue">
              {i.errorSummary}
            </span>
          )}
        </div>
      )}
      {i?.connectionMode === "coexistence" && i.status === "connected" && (
        <div className="whatsapp-connect-panel">
          <div className="whatsapp-connect-action">
            <b>Histórico do WhatsApp Business</b>
            {i.historySyncStatus === "not_started" ? (
              <>
                <p>
                  A importação não começa automaticamente. A Meta aceita uma
                  única solicitação nas primeiras 24 horas após a conexão.
                  Continue somente se o cliente autorizou compartilhar o
                  histórico no WhatsApp Business App.
                </p>
                <button
                  className="button"
                  type="button"
                  onClick={() => void startHistorySync()}
                  disabled={
                    busy ||
                    !isAdmin ||
                    !i.historySyncAvailable
                  }
                >
                  {busy ? "Solicitando histórico…" : "Importar histórico"}
                </button>
                {!i.historySyncAvailable && (
                    <p className="muted">
                      O prazo de 24 horas terminou. É necessário refazer a
                      conexão pela coexistência na Meta para solicitar o
                      histórico.
                    </p>
                  )}
              </>
            ) : i.historySyncStatus === "requesting" || i.historySyncStatus === "requested" ? (
              <p>
                Sincronização em andamento pela Meta
                {i.historySyncProgress > 0 ? ` (${i.historySyncProgress}%)` : ""}.
                A caixa de entrada será atualizada automaticamente.
              </p>
            ) : i.historySyncStatus === "completed" ? (
              <p>Histórico sincronizado ({i.historySyncProgress}%).</p>
            ) : i.historySyncStatus === "declined" ? (
              <p>
                O compartilhamento do histórico não foi autorizado no WhatsApp
                Business App; a Meta não enviou conversas antigas.
              </p>
            ) : (
              <p role="alert">
                {i.historySyncError ??
                  "A Meta não confirmou a sincronização. Por segurança, a solicitação não pode ser repetida."}
              </p>
            )}
          </div>
        </div>
      )}
      {i && isAdmin && (
        <button className="button secondary" onClick={() => void disconnect()}>
          Desconectar
        </button>
      )}

      {!i && pendingSelection && (
        <div className="whatsapp-connect-panel">
          <div className="whatsapp-connect-action">
            <label htmlFor="whatsapp-number-selection">Selecione o número autorizado na Meta</label>
            <select id="whatsapp-number-selection" value={selectedNumber} onChange={(event) => setSelectedNumber(event.target.value)} disabled={busy}>
              <option value="">Selecione um número</option>
              {pendingSelection.phoneNumbers.map((number) => (
                <option key={number.id} value={number.id}>{number.displayPhoneNumber}{number.verifiedName ? ` — ${number.verifiedName}` : ""}</option>
              ))}
            </select>
            <p>A seleção fica disponível por 15 minutos.</p>
            <button type="button" className="button" disabled={busy || !selectedNumber} onClick={() => void completeNumberSelection()}>
              {busy ? "Concluindo conexão…" : "Concluir conexão"}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => { setPendingSelection(null); setSelectedNumber(""); setError("") }}>
              Cancelar seleção
            </button>
          </div>
        </div>
      )}
      {!i && !pendingSelection && (
        <div className="whatsapp-connect-panel">
          <div className="whatsapp-benefits">
            <span>
              <b>Plataforma oficial</b>
              <small>Conexão da sua conta empresarial pela Meta</small>
            </span>
            <span>
              <b>Autorização segura</b>
              <small>Você aprova o acesso diretamente com a Meta</small>
            </span>
            <span>
              <b>Sem QR Code</b>
              <small>Integração oficial, sem automação não autorizada</small>
            </span>
          </div>
          {isAdmin ? (
            <div className="whatsapp-connect-action">
              <button
                className="button"
                type="button"
                onClick={() => startEmbeddedSignup("cloud_api")}
                disabled={busy || !sdkReady || !canConnect}
              >
                {busy
                  ? "Concluindo conexão…"
                  : !canConnect
                    ? "Conexão indisponível no momento"
                    : sdkReady
                      ? "Conectar WhatsApp Business (Cloud API)"
                      : "Preparando conexão…"}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() => startEmbeddedSignup("coexistence")}
                disabled={busy || !sdkReady || !canConnectWithCoexistence}
              >
                {canConnectWithCoexistence
                  ? "Conectar mantendo o WhatsApp Business App"
                  : "Coexistência ainda não configurada"}
              </button>
              <p>
                Escolha Cloud API para uso no AV Flow, ou coexistência para
                continuar usando o WhatsApp Business App com o mesmo número.
              </p>
              {data?.embeddedSignup.coexistenceConfigId && (
                <p className="muted">
                  A disponibilidade da coexistência depende da elegibilidade da
                  empresa e da configuração aprovada pela Meta. O histórico
                  antigo pode ser importado após a conexão, se autorizado pelo
                  cliente.
                </p>
              )}
            </div>
          ) : (
            <p className="muted">
              Peça ao administrador da empresa para conectar o número.
            </p>
          )}
        </div>
      )}
      <p className="whatsapp-footnote">
        A conexão usa a plataforma oficial do WhatsApp Business. Não utiliza QR
        Code nem automação do WhatsApp Web.
      </p>
    </section>
  )
}
