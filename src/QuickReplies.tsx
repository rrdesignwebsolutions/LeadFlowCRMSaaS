import { useCallback, useEffect, useState } from "react"
import { Pencil, Trash2, Zap } from "lucide-react"
import { api, errorMessage } from "./api"

export type QuickReply = { id: string; title: string; body: string }

export function QuickReplyForm({ initial, busy, onSave, onCancel }: {
  initial?: QuickReply; busy: boolean; onSave: (title: string, body: string) => Promise<void>; onCancel?: () => void
}) {
  const [title, setTitle] = useState(initial?.title ?? "")
  const [body, setBody] = useState(initial?.body ?? "")
  const [error, setError] = useState("")
  async function submit() {
    if (!title.trim() || !body.trim()) { setError("Informe o título e a mensagem."); return }
    setError("")
    await onSave(title.trim(), body.trim())
  }
  return <div className="form" onKeyDown={(event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault()
  }}>
    <label>Título<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Saudação" /></label>
    <label>Mensagem<textarea maxLength={4096} rows={4} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Escreva a mensagem rápida" /></label>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <div className="catalog-actions">
      <button type="button" className="button" disabled={busy} onClick={() => void submit()}>Salvar</button>
      {onCancel && <button className="button secondary" type="button" onClick={onCancel} disabled={busy}>Cancelar</button>}
    </div>
  </div>
}

export default function QuickReplies() {
  const [items, setItems] = useState<QuickReply[]>([])
  const [editing, setEditing] = useState<QuickReply | null>(null)
  const [formKey, setFormKey] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const load = useCallback(async () => {
    const data = await api<{ results: QuickReply[] }>("/api/quick-replies")
    setItems(data.results)
  }, [])
  useEffect(() => { void load().catch((e) => setError(errorMessage(e))) }, [load])

  async function save(title: string, body: string) {
    setBusy(true); setError(""); setNotice("")
    try {
      await api(editing ? `/api/quick-replies/${editing.id}` : "/api/quick-replies", {
        method: editing ? "PUT" : "POST", body: { title, body },
      })
      setEditing(null); setFormKey((key) => key + 1)
      await load()
      setNotice("Mensagem rápida salva.")
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  async function remove(item: QuickReply) {
    if (!window.confirm(`Excluir a mensagem rápida "${item.title}" para toda a equipe?`)) return
    setBusy(true); setError(""); setNotice("")
    try {
      await api(`/api/quick-replies/${item.id}`, { method: "DELETE" })
      if (editing?.id === item.id) { setEditing(null); setFormKey((key) => key + 1) }
      await load()
      setNotice("Mensagem rápida excluída.")
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <>
    <div className="page-heading"><div><h1>Mensagens rápidas</h1><p>Compartilhadas com toda a equipe para usar nas conversas.</p></div></div>
    <section className="panel">
      <div className="panel-title"><div><h2><Zap size={18} /> {editing ? "Editar mensagem" : "Cadastrar mensagem"}</h2></div></div>
      <QuickReplyForm key={formKey} initial={editing ?? undefined} busy={busy} onSave={save}
        onCancel={editing ? () => { setEditing(null); setFormKey((key) => key + 1) } : undefined} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
    </section>
    <section className="panel spaced">
      <div className="panel-title"><div><h2>Mensagens cadastradas</h2></div></div>
      {items.length ? items.map((item) => <div className="quick-reply-row" key={item.id}>
        <div><b>{item.title}</b><p>{item.body}</p></div>
        <button type="button" className="icon-button" disabled={busy} aria-label={`Editar ${item.title}`} onClick={() => { setEditing(item); setFormKey((key) => key + 1) }}><Pencil size={16} /></button>
        <button type="button" className="icon-button" disabled={busy} aria-label={`Excluir ${item.title}`} onClick={() => void remove(item)}><Trash2 size={16} /></button>
      </div>) : <p className="muted">Nenhuma mensagem rápida cadastrada.</p>}
    </section>
  </>
}
