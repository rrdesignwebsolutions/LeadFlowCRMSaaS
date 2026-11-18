import { useCallback, useEffect, useState, type FormEvent } from "react"

import {
  Check,
  ChevronRight,
  Copy,
  Globe,
  Mail,
  MessageSquareText,
  RefreshCw,
  Send,
  Settings2,
  UserRound,
  X,
} from "lucide-react"

import { api, errorMessage } from "./api"

type WebchatSettingsData = {
  enabled: boolean

  publicKey: string

  displayName: string

  color: string

  welcomeMessage: string

  allowedDomains: string[]

  embedCode: string

  installConfirmed: boolean
}

type WebchatThread = {
  id: string

  visitorName: string | null

  visitorEmail: string | null

  status: "open" | "resolved"

  aiState: "IA_ATIVA" | "HUMANO"

  unread: number

  lastMessageAt: string | null

  originDomain: string

  preview: string | null
}

type WebchatMessage = {
  id: string

  direction: "customer" | "ai" | "agent"

  body: string

  status: string

  createdAt: string

  senderName: string | null
}

function Feedback({ error, success }: { error: string; success?: string }) {
  if (error)
    return (
      <p className="auth-error" role="alert">
        {error}
      </p>
    )

  if (success)
    return (
      <p className="callout" role="status">
        {success}
      </p>
    )

  return null
}

export function WebchatWorkspace({ canEdit }: { canEdit: boolean }) {
  const [tab, setTab] = useState<"inbox" | "settings">("inbox")

  return (
    <section>
      <div className="page-heading">
        <div>
          <h1>Chat do site</h1>
          <p>Atenda visitantes e instale o widget nos domínios permitidos.</p>
        </div>
        <div className="catalog-actions">
          <button
            className={tab === "inbox" ? "button" : "button secondary"}
            onClick={() => setTab("inbox")}
          >
            <MessageSquareText size={16} /> Conversas
          </button>
          <button
            className={tab === "settings" ? "button" : "button secondary"}
            onClick={() => setTab("settings")}
          >
            <Settings2 size={16} /> Configurar widget
          </button>
        </div>
      </div>
      {tab === "settings" ? (
        <WebchatSettings canEdit={canEdit} />
      ) : (
        <WebchatInbox />
      )}
    </section>
  )
}

function WebchatSettings({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<WebchatSettingsData | null>(null)

  const [domains, setDomains] = useState("")

  const [busy, setBusy] = useState(false)

  const [error, setError] = useState("")

  const [success, setSuccess] = useState("")

  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await api<WebchatSettingsData>("/api/widget/settings")

      setSettings(result)

      setDomains(result.allowedDomains.join("\n"))

      setError("")
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!settings) return

    setBusy(true)

    setError("")

    setSuccess("")

    const form = new FormData(event.currentTarget)

    try {
      await api("/api/widget/settings", {
        method: "PUT",

        body: {
          enabled: form.get("enabled") === "on",

          displayName: form.get("displayName"),

          welcomeMessage: form.get("welcomeMessage"),

          color: form.get("color"),

          allowedDomains: domains.split(/[\s,;]+/).filter(Boolean),
        },
      })

      setSuccess("Configurações do widget salvas.")

      await load()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  async function copyEmbed() {
    if (!settings) return

    try {
      await navigator.clipboard.writeText(settings.embedCode)

      setCopied(true)

      window.setTimeout(() => setCopied(false), 1800)
    } catch (failure) {
      setError(
        "Não foi possível copiar. Selecione e copie o código manualmente.",
      )
    }
  }

  async function rotateKey() {
    if (
      !settings ||
      !window.confirm(
        "Gerar uma nova chave invalidará o código de instalação atual. Continuar?",
      )
    )
      return

    setBusy(true)

    setError("")

    try {
      await api("/api/widget/settings/rotate-key", { method: "POST" })

      await load()

      setSuccess("Chave renovada. Atualize o código instalado no site.")
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid">
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Aparência e domínios</h2>
            <p>O widget só responde nos domínios autorizados.</p>
          </div>
        </div>
        {!settings ? (
          <p className="empty-text">Carregando configurações...</p>
        ) : (
          <form className="form" onSubmit={save}>
            <label className="flex items-center gap-3">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={settings.enabled}
                disabled={!canEdit}
              />
              Ativar chat do site
            </label>
            <label>
              Nome exibido
              <input
                name="displayName"
                defaultValue={settings.displayName}
                maxLength={100}
                required
                disabled={!canEdit}
              />
            </label>
            <label>
              Mensagem de boas-vindas
              <textarea
                name="welcomeMessage"
                defaultValue={settings.welcomeMessage}
                maxLength={500}
                rows={3}
                disabled={!canEdit}
              />
            </label>
            <label className="flex items-center gap-3">
              Cor do widget
              <input
                name="color"
                type="color"
                defaultValue={settings.color}
                className="h-10 w-16"
                disabled={!canEdit}
              />
            </label>
            <label>
              Domínios permitidos
              <textarea
                value={domains}
                onChange={(event) => setDomains(event.target.value)}
                placeholder={"exemplo.com.br\nloja.exemplo.com.br"}
                rows={4}
                disabled={!canEdit}
              />
            </label>
            <small>
              Informe um domínio por linha, sem curingas. São aceitos até 20
              domínios.
            </small>
            {canEdit && (
              <button className="button" disabled={busy}>
                Salvar configurações
              </button>
            )}
          </form>
        )}
        {!canEdit && (
          <p className="empty-text">
            Somente administradores e gerentes podem alterar estas
            configurações.
          </p>
        )}
        <Feedback error={error} success={success} />
      </section>
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Instalação no site</h2>
            <p>Adicione este código antes de fechar a tag &lt;body&gt;.</p>
          </div>
        </div>
        {settings && (
          <div className="form">
            <textarea
              readOnly
              value={settings.embedCode}
              rows={3}
              aria-label="Código de instalação do widget"
            />
            <div className="catalog-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => void copyEmbed()}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? "Copiado" : "Copiar código"}
              </button>
              {canEdit && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void rotateKey()}
                >
                  <RefreshCw size={16} /> Renovar chave
                </button>
              )}
            </div>
            <p className="empty-text">
              {settings.installConfirmed
                ? "Já existe uma conversa recebida pelo widget."
                : "A instalação será confirmada quando um visitante iniciar uma conversa."}
            </p>
            {!settings.enabled && (
              <p className="callout">
                Ative o widget para receber novas conversas.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function WebchatInbox() {
  const [threads, setThreads] = useState<WebchatThread[]>([])

  const [selectedId, setSelectedId] = useState("")

  const [messages, setMessages] = useState<WebchatMessage[]>([])

  const [draft, setDraft] = useState("")

  const [error, setError] = useState("")

  const [busy, setBusy] = useState(false)

  const loadThreads = useCallback(async () => {
    try {
      const result = await api<{ results: WebchatThread[] }>(
        "/api/widget/conversations",
      )

      setThreads(result.results)

      setSelectedId((current) => current || result.results[0]?.id || "")

      setError("")
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [])

  const loadMessages = useCallback(async (id: string) => {
    if (!id) return

    try {
      const result = await api<{ results: WebchatMessage[] }>(
        `/api/widget/conversations/${id}/messages`,
      )

      setMessages(result.results)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [])

  useEffect(() => {
    void loadThreads()

    const timer = window.setInterval(() => {
      void loadThreads()
    }, 10000)

    return () => window.clearInterval(timer)
  }, [loadThreads])

  useEffect(() => {
    setMessages([])

    void loadMessages(selectedId)

    if (!selectedId) return

    const timer = window.setInterval(() => {
      void loadMessages(selectedId)
    }, 8000)

    return () => window.clearInterval(timer)
  }, [selectedId, loadMessages])

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!draft.trim() || !selectedId) return

    setBusy(true)

    setError("")

    try {
      await api(`/api/widget/conversations/${selectedId}`, {
        method: "POST",
        body: { body: draft.trim() },
      })

      setDraft("")

      await Promise.all([loadMessages(selectedId), loadThreads()])
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  async function action(name: "resolve" | "resume-ai" | "reopen") {
    if (!selectedId) return

    setBusy(true)

    setError("")

    try {
      await api(`/api/widget/conversations/${selectedId}/${name}`, {
        method: "POST",
      })

      await Promise.all([loadMessages(selectedId), loadThreads()])
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const selected = threads.find((thread) => thread.id === selectedId)

  return (
    <div className="grid min-h-[520px] grid-cols-1 gap-4 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.6fr)]">
      <section className="panel !p-0">
        <div className="panel-title">
          <div>
            <h2>Conversas do site</h2>
            <p>{threads.length} conversas</p>
          </div>
          <button
            className="icon-button"
            aria-label="Atualizar"
            onClick={() => void loadThreads()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <div className="max-h-[620px] overflow-y-auto">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`w-full border-t border-line p-4 text-left hover:bg-slate-50 ${
                selectedId === thread.id ? "bg-blue-50" : ""
              }`}
              onClick={() => setSelectedId(thread.id)}
            >
              <span className="flex items-center justify-between gap-2">
                <b className="truncate">
                  {thread.visitorName || thread.visitorEmail || "Visitante"}
                </b>
                {thread.unread > 0 && (
                  <span className="tag ok">{thread.unread}</span>
                )}
              </span>
              <small className="block truncate text-muted">
                {thread.preview || "Conversa iniciada"}
              </small>
              <small className="mt-1 block text-muted">
                {thread.originDomain} ·{" "}
                {thread.aiState === "HUMANO"
                  ? "Atendimento humano"
                  : "IA ativa"}
              </small>
            </button>
          ))}
          {!threads.length && (
            <p className="empty-text p-4">
              Ainda não há conversas. Instale o widget e inicie um chat de
              teste.
            </p>
          )}
        </div>
      </section>
      <section className="panel flex min-h-[520px] flex-col !p-0">
        {selected ? (
          <>
            <div className="panel-title border-b border-line">
              <div>
                <h2>
                  {selected.visitorName || selected.visitorEmail || "Visitante"}
                </h2>
                <p>
                  {selected.originDomain}
                  {selected.visitorEmail ? ` · ${selected.visitorEmail}` : ""} ·{" "}
                  {selected.aiState === "HUMANO" ? "Humano" : "IA"}
                </p>
              </div>
              <div className="catalog-actions">
                {selected.aiState === "HUMANO" && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action("resume-ai")}
                  >
                    Retomar IA
                  </button>
                )}
                {selected.status === "resolved" && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void action("reopen")}
                  >
                    Reabrir
                  </button>
                )}
                {selected.status === "open" && (
                  <button
                    className="icon-button"
                    title="Encerrar conversa"
                    disabled={busy}
                    onClick={() => void action("resolve")}
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-[85%] rounded-xl px-3 py-2 ${
                    message.direction === "customer"
                      ? "mr-auto bg-slate-100"
                      : "ml-auto bg-blue-50"
                  }`}
                >
                  <small className="mb-1 block text-muted">
                    {message.direction === "customer"
                      ? selected.visitorName || "Visitante"
                      : message.direction === "ai"
                        ? "IA"
                        : message.senderName || "Equipe"}
                  </small>
                  <p className="whitespace-pre-wrap break-words">
                    {message.body}
                  </p>
                  <small className="mt-1 block text-right text-muted">
                    {new Date(message.createdAt).toLocaleString("pt-BR")}
                  </small>
                </div>
              ))}
              {!messages.length && (
                <p className="empty-text">
                  Selecione uma conversa para visualizar as mensagens.
                </p>
              )}
            </div>
            {selected.status === "open" && (
              <form
                className="flex gap-2 border-t border-line p-3"
                onSubmit={send}
              >
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Escreva uma resposta; enviar assume o atendimento"
                  maxLength={4000}
                  aria-label="Mensagem"
                />
                <button
                  className="button"
                  disabled={busy || !draft.trim()}
                  aria-label="Enviar mensagem"
                >
                  <Send size={17} />
                </button>
              </form>
            )}
          </>
        ) : (
          <div className="empty-text m-auto p-5">
            Selecione uma conversa para começar.
          </div>
        )}
        <Feedback error={error} />
      </section>
    </div>
  )
}

type GmailStatus = {
  configured: boolean

  connected: boolean

  email: string | null

  status: string

  error: string | null

  lastSyncedAt: string | null
}

type GmailThread = {
  id: string

  subject: string

  fromName: string | null

  fromAddress: string

  snippet: string

  lastMessageAt: string

  unread: number

  status: "open" | "resolved"
}

type GmailMessage = {
  id: string

  direction: "inbound" | "outbound"

  fromAddress: string

  toAddress: string

  subject: string

  body: string

  status: string

  sentBy: string | null

  createdAt: string
}

export function GmailWorkspace({ canEdit }: { canEdit: boolean }) {
  const [status, setStatus] = useState<GmailStatus | null>(null)

  const [threads, setThreads] = useState<GmailThread[]>([])

  const [selectedId, setSelectedId] = useState("")

  const [messages, setMessages] = useState<GmailMessage[]>([])

  const [draft, setDraft] = useState("")

  const [error, setError] = useState("")

  const [notice, setNotice] = useState("")

  const [busy, setBusy] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api<GmailStatus>("/api/gmail/status"))
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [])

  const loadThreads = useCallback(async () => {
    try {
      const result = await api<{ results: GmailThread[] }>("/api/gmail/threads")

      setThreads(result.results)

      setSelectedId(
        (current) =>
          current ||
          result.results.find((item) => item.status === "open")?.id ||
          result.results[0]?.id ||
          "",
      )
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [])

  const loadMessages = useCallback(async (id: string) => {
    if (!id) return

    try {
      const result = await api<{ results: GmailMessage[] }>(
        `/api/gmail/threads/${id}/messages`,
      )

      setMessages(result.results)
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [])

  useEffect(() => {
    const url = new URL(window.location.href)

    const result = url.searchParams.get("gmail")

    if (result) {
      setNotice(
        result === "connected"
          ? "Gmail conectado. A sincronização inicial será iniciada em instantes."
          : "Não foi possível conectar o Gmail. Verifique a configuração OAuth e tente novamente.",
      )

      url.searchParams.delete("gmail")

      window.history.replaceState(
        {},
        "",
        `${url.pathname}${url.search}${url.hash}`,
      )
    }
  }, [])

  useEffect(() => {
    void loadStatus()

    const timer = window.setInterval(() => {
      void loadStatus()
    }, 20000)

    return () => window.clearInterval(timer)
  }, [loadStatus])

  useEffect(() => {
    if (!status?.connected) return

    void loadThreads()

    const timer = window.setInterval(() => {
      void loadThreads()
    }, 12000)

    return () => window.clearInterval(timer)
  }, [status?.connected, loadThreads])

  useEffect(() => {
    setMessages([])

    void loadMessages(selectedId)

    if (!selectedId) return

    const timer = window.setInterval(() => {
      void loadMessages(selectedId)
    }, 10000)

    return () => window.clearInterval(timer)
  }, [selectedId, loadMessages])

  async function sync() {
    setBusy(true)

    setError("")

    setNotice("")

    try {
      await api("/api/gmail/sync", { method: "POST" })

      setNotice(
        "Uma página da caixa de entrada foi sincronizada. A sincronização completa continua automaticamente.",
      )

      await Promise.all([loadThreads(), loadStatus()])
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        "Desconectar o Gmail desta empresa? As conversas já sincronizadas serão preservadas.",
      )
    )
      return

    setBusy(true)

    setError("")

    try {
      await api("/api/gmail/disconnect", { method: "POST" })

      setSelectedId("")

      setMessages([])

      await loadStatus()
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!selectedId || !draft.trim()) return

    setBusy(true)

    setError("")

    try {
      await api(`/api/gmail/threads/${selectedId}/messages`, {
        method: "POST",
        body: { body: draft.trim() },
      })

      setDraft("")

      await Promise.all([loadMessages(selectedId), loadThreads()])
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  async function threadAction(action: "resolve" | "reopen") {
    if (!selectedId) return

    setBusy(true)

    setError("")

    try {
      await api(`/api/gmail/threads/${selectedId}/${action}`, {
        method: "POST",
      })

      await Promise.all([loadThreads(), loadMessages(selectedId)])
    } catch (failure) {
      setError(errorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const selected = threads.find((thread) => thread.id === selectedId)

  return (
    <section>
      <div className="page-heading">
        <div>
          <h1>E-mail</h1>
          <p>Gerencie as conversas da conta Gmail conectada.</p>
        </div>
        {status?.connected && (
          <div className="catalog-actions">
            <button
              className="button secondary"
              onClick={() => void sync()}
              disabled={busy}
            >
              <RefreshCw size={16} /> Sincronizar agora
            </button>
            {canEdit && (
              <button
                className="button secondary"
                onClick={() => void disconnect()}
                disabled={busy}
              >
                Desconectar
              </button>
            )}
          </div>
        )}
      </div>
      <Feedback error={error} success={notice} />
      {status?.error && (
        <p className="auth-error" role="alert">
          {status.error}
        </p>
      )}
      {!status?.connected ? (
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>Conecte uma conta Google</h2>
              <p>
                As mensagens serão sincronizadas para a caixa de entrada da
                empresa.
              </p>
            </div>
            <Mail size={24} />
          </div>
          {!status?.configured && (
            <p className="callout">
              O administrador precisa configurar GOOGLE_CLIENT_ID,
              GOOGLE_CLIENT_SECRET e a URI de callback do Google Cloud no
              Worker.
            </p>
          )}
          {canEdit && (
            <button
              className="button"
              disabled={!status?.configured || busy}
              onClick={() => window.location.assign("/api/gmail/connect")}
            >
              Conectar com Google
            </button>
          )}
          {status?.status === "error" && canEdit && (
            <p className="empty-text">
              A autorização expirou ou foi revogada. Conecte novamente para
              retomar.
            </p>
          )}
        </section>
      ) : (
        <>
          <div className="integration mb-4">
            <span className="integration-icon">
              <Mail size={20} />
            </span>
            <span>
              <b>{status.email}</b>
              <small>
                {status.lastSyncedAt
                  ? `Última sincronização: ${new Date(status.lastSyncedAt).toLocaleString("pt-BR")}`
                  : "Sincronização inicial pendente"}
              </small>
            </span>
            <span className="tag ok">Conectado</span>
          </div>
          <div className="grid min-h-[540px] grid-cols-1 gap-4 lg:grid-cols-[minmax(240px,0.8fr)_minmax(0,1.6fr)]">
            <section className="panel !p-0">
              <div className="panel-title">
                <div>
                  <h2>Caixa de entrada</h2>
                  <p>
                    {
                      threads.filter((thread) => thread.status === "open")
                        .length
                    }{" "}
                    abertas
                  </p>
                </div>
                <button
                  className="icon-button"
                  aria-label="Atualizar"
                  onClick={() => void loadThreads()}
                >
                  <RefreshCw size={17} />
                </button>
              </div>
              <div className="max-h-[640px] overflow-y-auto">
                {threads.map((thread) => (
                  <button
                    key={thread.id}
                    className={`w-full border-t border-line p-4 text-left hover:bg-slate-50 ${
                      selectedId === thread.id ? "bg-blue-50" : ""
                    }`}
                    onClick={() => setSelectedId(thread.id)}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <b className="truncate">
                        {thread.fromName || thread.fromAddress}
                      </b>
                      {thread.unread > 0 && (
                        <span className="tag ok">{thread.unread}</span>
                      )}
                    </span>
                    <small className="block truncate font-medium">
                      {thread.subject || "(sem assunto)"}
                    </small>
                    <small className="block truncate text-muted">
                      {thread.snippet}
                    </small>
                    <small className="mt-1 block text-muted">
                      {new Date(thread.lastMessageAt).toLocaleString("pt-BR")}
                      {thread.status === "resolved" ? " · Resolvida" : ""}
                    </small>
                  </button>
                ))}
                {!threads.length && (
                  <p className="empty-text p-4">
                    Nenhuma mensagem sincronizada. A primeira sincronização pode
                    levar alguns minutos.
                  </p>
                )}
              </div>
            </section>
            <section className="panel flex min-h-[540px] flex-col !p-0">
              {selected ? (
                <>
                  <div className="panel-title border-b border-line">
                    <div>
                      <h2>{selected.subject || "(sem assunto)"}</h2>
                      <p>
                        <UserRound size={14} className="mr-1 inline" />
                        {selected.fromName || selected.fromAddress}
                      </p>
                    </div>
                    {selected.status === "open" ? (
                      <button
                        className="button secondary"
                        onClick={() => void threadAction("resolve")}
                        disabled={busy}
                      >
                        Resolver
                      </button>
                    ) : (
                      <button
                        className="button secondary"
                        onClick={() => void threadAction("reopen")}
                        disabled={busy}
                      >
                        Reabrir
                      </button>
                    )}
                  </div>
                  <div className="flex-1 space-y-4 overflow-y-auto p-4">
                    {messages.map((message) => (
                      <article
                        key={message.id}
                        className={`rounded-xl border border-line p-4 ${
                          message.direction === "outbound"
                            ? "ml-8 bg-blue-50"
                            : "mr-8 bg-white"
                        }`}
                      >
                        <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
                          <span>
                            {message.direction === "inbound"
                              ? message.fromAddress
                              : `Para: ${message.toAddress}`}
                          </span>
                          <time>
                            {new Date(message.createdAt).toLocaleString(
                              "pt-BR",
                            )}
                          </time>
                        </div>
                        <p className="whitespace-pre-wrap break-words">
                          {message.body}
                        </p>
                      </article>
                    ))}
                    {!messages.length && (
                      <p className="empty-text">Carregando mensagens...</p>
                    )}
                  </div>
                  {selected.status === "open" && (
                    <form className="border-t border-line p-3" onSubmit={send}>
                      <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        rows={4}
                        maxLength={10000}
                        placeholder="Escreva uma resposta..."
                        aria-label="Resposta de e-mail"
                      />
                      <div className="mt-2 flex justify-end">
                        <button
                          className="button"
                          disabled={busy || !draft.trim()}
                        >
                          <Send size={16} /> Enviar resposta
                        </button>
                      </div>
                    </form>
                  )}
                </>
              ) : (
                <div className="empty-text m-auto p-5">
                  Selecione uma conversa para visualizar o e-mail.
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  )
}

type OnboardingView = "settings" | "agent" | "email" | "team" | "webchat" | "quick-replies" | "leads" | "workflows"

type OnboardingItem = {
  id: string
  label: string
  done: boolean
  view: OnboardingView
}

export function Onboarding({
  onNavigate,
}: {
  onNavigate: (view: OnboardingView) => void
}) {
  const [items, setItems] = useState<OnboardingItem[]>([])

  const [error, setError] = useState("")

  const load = useCallback(async () => {
    try {
      const result = await api<{ items: OnboardingItem[] }>("/api/onboarding")

      setItems(result.items)

      setError("")
    } catch (failure) {
      setError(errorMessage(failure))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const completed = items.filter((item) => item.done).length

  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">BOAS-VINDAS</p>
          <h1>Configure seu espaço</h1>
          <p>Conclua as etapas para preparar sua operação no AV Flow.</p>
        </div>
        <Globe size={28} />
      </div>
      <Feedback error={error} />
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>
              {completed} de {items.length} etapas concluídas
            </h2>
            <p>
              O progresso é atualizado com base nas configurações e dados reais
              da empresa.
            </p>
          </div>
        </div>
        <div className="progress mx-6 mb-4">
          <i
            style={{
              width: `${items.length ? (completed / items.length) * 100 : 0}%`,
            }}
          />
        </div>
        <div className="divide-y divide-line">
          {items.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-6 py-4">
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  item.done
                    ? "bg-emerald-100 text-emerald-700"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {item.done ? <Check size={17} /> : <ChevronRight size={17} />}
              </span>
              <span className="flex-1">
                <b>{item.label}</b>
                <small className="block text-muted">
                  {item.done ? "Concluído" : "Pendente"}
                </small>
              </span>
              {!item.done && (
                <button
                  className="button secondary"
                  onClick={() => onNavigate(item.view)}
                >
                  Configurar
                </button>
              )}
            </div>
          ))}
        </div>
      </section>
    </section>
  )
}
