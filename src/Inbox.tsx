import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"

import {
  ArrowLeft,
  ArrowUpLeft,
  Check,
  CheckCheck,
  Circle,
  Download,
  Info,
  MessageCircle,
  MoreVertical,
  Paperclip,
  Search,
  Send,
  X,
} from "lucide-react"

import { Boxes } from "lucide-react"

import { api, errorMessage, type Member, type Team } from "./api"

type CatalogItem = { id: string; name: string; version: string | null; status: string; authorized: boolean; images: Array<{ id: string; isPrimary: boolean }> }

type Conversation = {
  id: string

  unread: number

  lastMessageAt: string | null

  name: string | null

  phone: string

  preview: string | null

  leadStatus: string | null

  humanRequestedAt?: string | null
  assignedTo: string | null
}

type Message = {
  id: string

  direction: "inbound" | "outbound"

  type: string

  body: string | null

  status: string

  errorCode: string | null

  hasMedia: number

  mediaFilename: string | null

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

const mediaLabel = /^\[(Imagem|Figurinha|Áudio|Vídeo)\]\s*/

const temperature: Record<string, string> = {
  hot: "Quente",
  negotiating: "Negociando",
  qualified: "Qualificado",
  follow_up: "Follow-up",
  financial_pending: "Pendência financeira",
  cold: "Frio",
}

const avatarColors = [
  ["#1b6e4d", "#d9f2e6"],
  ["#1f5f99", "#dcebfa"],
  ["#8a4b9c", "#f1e1f6"],
  ["#a8541a", "#fbe6d3"],
  ["#2b7a78", "#d6f1ef"],
  ["#a1335c", "#fbdfe9"],
  ["#5a5fa8", "#e3e4f8"],
  ["#7a6a14", "#f6efc9"],
  ["#b23a3a", "#fbdcdc"],
  ["#3f6b2a", "#e2f1d6"],
]

const avatarStyle = (seed: string) => {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const [color, background] = avatarColors[hash % avatarColors.length]
  return { color, background }
}

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
  onExit,
  isAdmin,
}: {
  connected: boolean
  isAdmin: boolean

  onRead: () => void
  onExit: () => void
}) {
  const [list, setList] = useState<Conversation[]>([])

  const [activeId, setActiveId] = useState<string | null>(null)

  const [thread, setThread] = useState<Thread | null>(null)

  const [query, setQuery] = useState("")

  const [error, setError] = useState("")

  const [sending, setSending] = useState(false)

  const [file, setFile] = useState<File | null>(null)

  const [catalogOpen, setCatalogOpen] = useState(false)

  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([])

  const [selected, setSelected] = useState<string[]>([])
  const [members, setMembers] = useState<Member[]>([])
  const [assigning, setAssigning] = useState(false)
  const [assignmentNotice, setAssignmentNotice] = useState("")
  const [contextMenu, setContextMenu] = useState<{ kind: "conversation" | "message"; id: string; x: number; y: number } | null>(null)

  function showMenu(kind: "conversation" | "message", id: string, x: number, y: number) {
    setContextMenu({ kind, id, x: Math.max(8, Math.min(x, window.innerWidth - 210)), y: Math.max(8, Math.min(y, window.innerHeight - 130)) })
  }

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close() }
    window.addEventListener("click", close)
    window.addEventListener("keydown", escape)
    window.addEventListener("scroll", close, true)
    return () => {
      window.removeEventListener("click", close)
      window.removeEventListener("keydown", escape)
      window.removeEventListener("scroll", close, true)
    }
  }, [contextMenu])

  async function markUnread(id: string) {
    setContextMenu(null)
    setError("")
    try {
      await api(`/api/conversations/${id}/unread`, { method: "POST" })
      if (activeId === id) { setActiveId(null); setThread(null) }
      await loadList()
      onRead()
    } catch (e) { setError(errorMessage(e)) }
  }

  async function removeItem(kind: "conversation" | "message", id: string) {
    setContextMenu(null)
    const label = kind === "conversation" ? "esta conversa e todo o histórico" : "esta mensagem"
    if (!window.confirm(`Excluir ${label} permanentemente do AV Flow? Isso não apaga no WhatsApp do cliente.`)) return
    setError("")
    try {
      await api(kind === "conversation" ? `/api/conversations/${id}` : `/api/messages/${id}`, { method: "DELETE" })
      if (kind === "conversation" && activeId === id) { setActiveId(null); setThread(null) }
      else if (activeId) await loadThread(activeId)
      await loadList()
      onRead()
    } catch (e) { setError(errorMessage(e)) }
  }

  useEffect(() => {
    api<Team>("/api/team")
      .then((team) => setMembers(team.members.filter((member) => member.status === "active")))
      .catch((e) => setError(errorMessage(e)))
  }, [])

  async function assign(id: string, assignedTo: string | null) {
    setAssigning(true)
    setError("")
    setAssignmentNotice("")
    try {
      const result = await api<{ warning?: string }>(`/api/conversations/${id}/assignment`, {
        method: "POST",
        body: { assignedTo },
      })
      await loadList()
      await loadThread(id)
      setAssignmentNotice(result.warning ?? (assignedTo ? "Conversa atribuída. A IA está pausada." : "Conversa devolvida à IA."))
    } catch (e) {
      setError(errorMessage(e))
      await loadList()
    } finally {
      setAssigning(false)
    }
  }

  async function toggleCatalog() {
    const next = !catalogOpen
    setCatalogOpen(next)
    setSelected([])
    if (!next) return
    try {
      const data = await api<{ products: CatalogItem[] }>("/api/catalog/products")
      setCatalogItems(data.products.filter((p) => p.status === "approved" && p.authorized && p.images.length))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function sendCatalog(productIds: string[] | null) {
    if (!activeId) return
    setCatalogOpen(false)
    setSending(true)
    setError("")
    setAssignmentNotice("")
    try {
      await api("/api/catalog/send", {
        method: "POST",
        body: { conversationId: activeId, ...(productIds ? { productIds } : {}) },
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      await loadThread(activeId)
      void loadList()
      setSending(false)
    }
  }

  const fileInput = useRef<HTMLInputElement>(null)

  const bottom = useRef<HTMLDivElement>(null)

  const composer = useRef<HTMLTextAreaElement>(null)

  // Ajusta a altura ao conteúdo (até ~6 linhas).
  const fitComposer = () => {
    const el = composer.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }

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
    setAssignmentNotice("")

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

    if ((!body && !file) || !activeId) return

    setSending(true)

    setError("")

    try {
      if (file) {
        const form = new FormData()
        form.set("file", file)
        form.set("caption", body)

        const response = await fetch(
          `/api/conversations/${activeId}/attachments`,
          { method: "POST", credentials: "same-origin", body: form },
        )

        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            error?: string
          }
          throw new Error(data.error ?? "Não foi possível enviar o arquivo.")
        }

        setFile(null)
      } else {
        await api(`/api/conversations/${activeId}/messages`, {
          method: "POST",

          body: { body },
        })
      }

      if (composer.current) {
        composer.current.value = ""
        fitComposer()
      }
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
    <div className="inbox-fullscreen">
      <div className="inbox-topbar">
        <div className="inbox-brand">
          <span className="inbox-brand-mark">
            <MessageCircle size={18} />
          </span>
          <b>AV Flow <span>CRM</span></b>
          <i />
          <span>WhatsApp</span>
        </div>
        <button type="button" className="inbox-exit" onClick={onExit}>
          <ArrowUpLeft size={17} />
          <span>Voltar ao CRM</span>
        </button>
      </div>
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
                <div className="inbox-conversation-wrap" key={conversation.id}>
                <button
                  type="button"
                  role="listitem"
                  className={`inbox-conversation${
                    conversation.id === activeId ? " selected" : ""
                  }`}
                  onClick={() => void open(conversation.id)}
                  onContextMenu={(event) => { event.preventDefault(); showMenu("conversation", conversation.id, event.clientX, event.clientY) }}
                >
                  <span
                    className="inbox-avatar"
                    style={avatarStyle(conversation.phone)}
                  >
                    {initials(label)}
                  </span>
                  <span className="inbox-conversation-copy">
                    <span className="inbox-conversation-top">
                      <b>{label}</b>
                      {conversation.humanRequestedAt && (
                        <span className="inbox-human">Quer falar com vendedor</span>
                      )}
                      {conversation.leadStatus &&
                        temperature[conversation.leadStatus] && (
                          <span
                            className={`inbox-temp ${conversation.leadStatus}`}
                          >
                            {temperature[conversation.leadStatus]}
                          </span>
                        )}
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
                <button type="button" className="inbox-item-menu" aria-label={`Opções da conversa ${label}`}
                  onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); showMenu("conversation", conversation.id, box.left, box.bottom) }}>
                  <MoreVertical size={16} />
                </button>
                </div>
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
              <span
                className="inbox-avatar"
                style={avatarStyle(active.phone)}
              >
                {initials(active.name ?? active.phone)}
              </span>
              <span className="inbox-contact">
                <b>{active.name ?? active.phone}</b>
                <small>{active.phone}</small>
              </span>
              <label className="inbox-assignment">
                <span>Destinar para</span>
                <select
                  aria-label="Destinar conversa para"
                  value={active.assignedTo ?? ""}
                  disabled={assigning}
                  onChange={(event) => void assign(active.id, event.target.value || null)}
                >
                  <option value="">Assistente de IA</option>
                  {active.assignedTo && !members.some((member) => member.id === active.assignedTo) && (
                    <option value={active.assignedTo}>Membro indisponível</option>
                  )}
                  {members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
                </select>
                {!active.assignedTo && (
                  <button type="button" disabled={assigning} onClick={() => void assign(active.id, null)}>
                    Retomar IA
                  </button>
                )}
              </label>
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

            {assignmentNotice && <p className="inbox-assignment-notice" role="status">{assignmentNotice}</p>}
            <div className="inbox-message-area">
              <div className="inbox-day-label">Mensagens</div>
              {thread?.messages.map((message) => (
                <div
                  key={message.id}
                  className={`inbox-message-row ${message.direction}`}
                  onContextMenu={(event) => { if (isAdmin) { event.preventDefault(); showMenu("message", message.id, event.clientX, event.clientY) } }}
                >
                  <div className={`inbox-bubble ${message.direction}`}>
                    {isAdmin && <button type="button" className="inbox-message-menu" aria-label="Opções da mensagem"
                      onClick={(event) => { event.stopPropagation(); const box = event.currentTarget.getBoundingClientRect(); showMenu("message", message.id, box.left, box.bottom) }}>
                      <MoreVertical size={14} />
                    </button>}
                    {message.hasMedia &&
                    (message.type === "image" ||
                      message.type === "sticker") ? (
                      <img
                        className="inbox-image"
                        src={`/api/messages/${message.id}/media?inline=1`}
                        alt={message.type === "sticker" ? "Figurinha" : "Imagem"}
                        loading="lazy"
                      />
                    ) : null}
                    {message.hasMedia && message.type === "audio" ? (
                      <audio
                        className="inbox-audio"
                        controls
                        preload="none"
                        src={`/api/messages/${message.id}/media?inline=1`}
                      />
                    ) : null}
                    {message.hasMedia && message.type === "video" ? (
                      <video
                        className="inbox-image"
                        controls
                        preload="metadata"
                        src={`/api/messages/${message.id}/media?inline=1`}
                      />
                    ) : null}
                    {message.body &&
                    !(
                      message.hasMedia &&
                      ["image", "sticker", "audio", "video"].includes(
                        message.type,
                      ) &&
                      !message.body.replace(mediaLabel, "")
                    ) ? (
                      <p>
                        {message.hasMedia &&
                        ["image", "sticker", "audio", "video"].includes(
                          message.type,
                        )
                          ? message.body.replace(mediaLabel, "")
                          : message.body}
                      </p>
                    ) : null}
                    {message.hasMedia ? (
                      <a
                        className="inbox-download"
                        href={`/api/messages/${message.id}/media`}
                        download
                      >
                        <Download size={15} />
                        Baixar {message.mediaFilename ?? "arquivo"}
                      </a>
                    ) : null}
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
                  ref={fileInput}
                  type="file"
                  hidden
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null)
                    event.target.value = ""
                  }}
                />
                <button
                  type="button"
                  className="inbox-attach"
                  disabled={sending}
                  onClick={() => fileInput.current?.click()}
                  aria-label="Anexar arquivo"
                  title="Anexar arquivo"
                >
                  <Paperclip size={19} />
                </button>
                <span className="inbox-catalog">
                  <button
                    type="button"
                    className="inbox-attach"
                    disabled={sending}
                    onClick={() => void toggleCatalog()}
                    aria-label="Enviar catálogo"
                    title="Enviar catálogo ou modelo"
                  >
                    <Boxes size={19} />
                  </button>
                  {catalogOpen && (
                    <div className="inbox-catalog-menu" role="menu">
                      {catalogItems.length === 0 ? (
                        <p>Nenhum modelo aprovado com foto.</p>
                      ) : (
                        <>
                          <button type="button" role="menuitem" className="all" onClick={() => void sendCatalog(null)}>
                            Catálogo completo ({catalogItems.length})
                          </button>
                          <div className="inbox-catalog-grid">
                            {catalogItems.map((p) => {
                              const on = selected.includes(p.id)
                              const photo = p.images.find((i) => i.isPrimary) ?? p.images[0]
                              return (
                                <button
                                  type="button"
                                  key={p.id}
                                  className={on ? "inbox-catalog-card on" : "inbox-catalog-card"}
                                  aria-pressed={on}
                                  onClick={() =>
                                    setSelected((s) =>
                                      s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id],
                                    )
                                  }
                                >
                                  <img src={`/api/catalog/images/${photo.id}`} alt="" loading="lazy" />
                                  <span>{p.name}{p.version ? ` ${p.version}` : ""}</span>
                                  {on && <em>✓</em>}
                                </button>
                              )
                            })}
                          </div>
                          <button
                            type="button"
                            className="all send"
                            disabled={!selected.length}
                            onClick={() => void sendCatalog(selected)}
                          >
                            Enviar selecionados ({selected.length})
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </span>
                {file && (
                  <span className="inbox-file-chip" title={file.name}>
                    <span>{file.name}</span>
                    <button
                      type="button"
                      onClick={() => setFile(null)}
                      aria-label="Remover anexo"
                    >
                      <X size={14} />
                    </button>
                  </span>
                )}
                <textarea
                  ref={composer}
                  name="body"
                  rows={1}
                  onInput={fitComposer}
                  placeholder={
                    file ? "Adicione uma legenda (opcional)" : "Digite uma mensagem"
                  }
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
      {contextMenu && (
        <div className="inbox-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          {contextMenu.kind === "conversation" && <button type="button" role="menuitem" onClick={() => void markUnread(contextMenu.id)}>Marcar como não lida</button>}
          {isAdmin && <button type="button" role="menuitem" className="destructive" onClick={() => void removeItem(contextMenu.kind, contextMenu.id)}>
            {contextMenu.kind === "conversation" ? "Excluir conversa" : "Excluir mensagem"}
          </button>}
        </div>
      )}
    </div>
  )
}
