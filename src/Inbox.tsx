import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import {
  ArrowLeft,
  Check,
  CheckCheck,
  Circle,
  Info,
  MessageCircle,
  MoreVertical,
  Search,
  Send,
} from "lucide-react"

import { api, errorMessage } from "./api"

type Conversation = {
  id: string

  unread: number

  lastMessageAt: string | null

  name: string | null

  phone: string

  preview: string | null
}

type Message = {
  id: string

  direction: "inbound" | "outbound"

  body: string | null

  status: string

  errorCode: string | null

  at: string
}

type Thread = {
  messages: Message[]

  windowOpen: boolean

  windowEndsAt: string | null
}

const statusText: Record<string, string> = {
  queued: "Enviando",

  accepted: "Enviada",

  sent: "Enviada",

  delivered: "Entregue",

  read: "Lida",

  failed: "Falhou",
}

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("pt-BR", {
        hour: "2-digit",

        minute: "2-digit",
      })
    : ""

const initials = (name: string) =>
  name

    .trim()

    .split(/\s+/)

    .slice(0, 2)

    .map((part) => part[0]?.toLocaleUpperCase() ?? "")

    .join("") || "?"

export default function Inbox({
  connected,

  onRead,
}: {
  connected: boolean

  onRead: () => void
}) {
  const [list, setList] = useState<Conversation[]>([])

  const [activeId, setActiveId] = useState<string | null>(null)

  const [thread, setThread] = useState<Thread | null>(null)

  const [query, setQuery] = useState("")

  const [error, setError] = useState("")

  const [sending, setSending] = useState(false)

  const bottom = useRef<HTMLDivElement>(null)

  const composer = useRef<HTMLInputElement>(null)

  const loadList = useCallback(async () => {
    try {
      setList(
        (await api<{ results: Conversation[] }>("/api/conversations")).results,
      )
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  const loadThread = useCallback(async (id: string) => {
    try {
      setThread(await api<Thread>(`/api/conversations/${id}/messages`))
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  useEffect(() => {
    void loadList()

    const timer = setInterval(() => {
      if (!document.hidden) {
        void loadList()

        if (activeId) void loadThread(activeId)
      }
    }, 8000)

    return () => clearInterval(timer)
  }, [loadList, loadThread, activeId])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }, [thread?.messages.length])

  async function open(id: string) {
    setActiveId(id)

    setThread(null)

    setError("")

    await loadThread(id)

    await api(`/api/conversations/${id}/read`, { method: "POST" }).catch(
      () => undefined,
    )

    void loadList()

    onRead()
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const body = composer.current?.value.trim() ?? ""

    if (!body || !activeId) return

    setSending(true)

    setError("")

    try {
      await api(`/api/conversations/${activeId}/messages`, {
        method: "POST",

        body: { body },
      })

      if (composer.current) composer.current.value = ""
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      await loadThread(activeId)

      void loadList()

      setSending(false)

      composer.current?.focus()
    }
  }

  const active = list.find((conversation) => conversation.id === activeId)

  const filtered = list.filter((conversation) =>
    `${conversation.name ?? ""} ${conversation.phone} ${conversation.preview ?? ""}`

      .toLocaleLowerCase()

      .includes(query.trim().toLocaleLowerCase()),
  )

  return (
    <section
      className={`inbox-shell${activeId ? " has-active" : ""}`}
      aria-label="Caixa de entrada do WhatsApp"
    >
      <aside className="inbox-sidebar">
        <div className="inbox-sidebar-head">
          <div>
            <h2>Conversas</h2>
            <span>
              {list.length} {list.length === 1 ? "conversa" : "conversas"}
            </span>
          </div>
          <span className="inbox-live" title="Sincronização automática">
            <Circle size={8} fill="currentColor" /> Ao vivo
          </span>
        </div>
        <label className="inbox-search">
          <Search size={17} aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar conversa"
            aria-label="Buscar conversa"
          />
        </label>
        {error && !active && (
          <p className="inbox-error" role="alert">
            {error}
          </p>
        )}
        {filtered.length ? (
          <div className="inbox-conversations" role="list">
            {filtered.map((conversation) => {
              const label = conversation.name ?? conversation.phone

              return (
                <button
                  type="button"
                  role="listitem"
                  key={conversation.id}
                  className={`inbox-conversation${
                    conversation.id === activeId ? " selected" : ""
                  }`}
                  onClick={() => void open(conversation.id)}
                >
                  <span className="inbox-avatar">{initials(label)}</span>
                  <span className="inbox-conversation-copy">
                    <span className="inbox-conversation-top">
                      <b>{label}</b>
                      <time>{time(conversation.lastMessageAt)}</time>
                    </span>
                    <span className="inbox-conversation-bottom">
                      <span>{conversation.preview || conversation.phone}</span>
                      {conversation.unread > 0 && (
                        <em>{conversation.unread}</em>
                      )}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="inbox-list-empty">
            <span className="inbox-empty-icon">
              <MessageCircle size={22} />
            </span>
            <b>
              {list.length
                ? "Nenhum resultado"
                : connected
                  ? "Tudo tranquilo por aqui"
                  : "Conecte seu WhatsApp"}
            </b>
            <p>
              {list.length
                ? "Tente buscar por outro nome ou telefone."
                : connected
                  ? "Quando um cliente enviar uma mensagem, a conversa aparecerá aqui."
                  : "Conecte um número nas configurações para receber e responder mensagens."}
            </p>
          </div>
        )}
      </aside>

      <div className="inbox-chat">
        {active ? (
          <>
            <header className="inbox-chat-head">
              <button
                type="button"
                className="inbox-back"
                aria-label="Voltar para conversas"
                onClick={() => {
                  setActiveId(null)

                  setThread(null)

                  setError("")
                }}
              >
                <ArrowLeft size={19} />
              </button>
              <span className="inbox-avatar">
                {initials(active.name ?? active.phone)}
              </span>
              <span className="inbox-contact">
                <b>{active.name ?? active.phone}</b>
                <small>{active.phone}</small>
              </span>
              <button
                type="button"
                className="inbox-head-action"
                aria-label="Informações da conversa"
                title="Conversa do WhatsApp"
              >
                <Info size={19} />
              </button>
              <button
                type="button"
                className="inbox-head-action"
                aria-label="Mais opções"
                title="Mais opções"
              >
                <MoreVertical size={19} />
              </button>
            </header>

            <div className="inbox-message-area">
              <div className="inbox-day-label">Mensagens</div>
              {thread?.messages.map((message) => (
                <div
                  key={message.id}
                  className={`inbox-message-row ${message.direction}`}
                >
                  <div className={`inbox-bubble ${message.direction}`}>
                    <p>{message.body}</p>
                    <span className="inbox-message-meta">
                      <time>{time(message.at)}</time>
                      {message.direction === "outbound" &&
                        (message.status === "read" ||
                        message.status === "delivered" ? (
                          <CheckCheck
                            size={15}
                            className="inbox-read-check"
                            aria-label={statusText[message.status]}
                          />
                        ) : (
                          <Check
                            size={14}
                            aria-label={
                              statusText[message.status] ?? message.status
                            }
                          />
                        ))}
                      {message.status === "failed" && (
                        <span className="inbox-failed">
                          Falhou
                          {message.errorCode ? ` (${message.errorCode})` : ""}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              ))}
              {thread?.messages.length === 0 && (
                <div className="inbox-thread-empty">
                  <MessageCircle size={20} />
                  <span>Esta conversa ainda não tem mensagens.</span>
                </div>
              )}
              <div ref={bottom} />
            </div>

            {error && (
              <p className="inbox-error chat-error" role="alert">
                {error}
              </p>
            )}
            {thread && !thread.windowOpen ? (
              <div className="inbox-window-note">
                <Info size={16} />
                <span>
                  A janela de atendimento de 24 horas terminou. O cliente
                  precisa enviar uma nova mensagem para você responder.
                </span>
              </div>
            ) : (
              <form className="inbox-composer" onSubmit={send}>
                <input
                  ref={composer}
                  name="body"
                  placeholder="Digite uma mensagem"
                  maxLength={4096}
                  autoComplete="off"
                  aria-label="Mensagem"
                />
                <button
                  className="inbox-send"
                  disabled={sending}
                  aria-label="Enviar mensagem"
                  title="Enviar mensagem"
                >
                  <Send size={18} />
                </button>
              </form>
            )}
          </>
        ) : (
          <div className="inbox-welcome">
            <span className="inbox-welcome-icon">
              <MessageCircle size={34} />
            </span>
            <h3>Sua caixa de entrada</h3>
            <p>
              Selecione uma conversa para ver as mensagens e continuar o
              atendimento.
            </p>
            <span className="inbox-encryption">
              <Info size={13} /> Atendimento pelo WhatsApp Business
            </span>
          </div>
        )}
      </div>
    </section>
  )
}
