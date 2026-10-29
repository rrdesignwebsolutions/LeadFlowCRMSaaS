import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Send } from "lucide-react";
import { api, errorMessage } from "./api";

type Conversation = { id: string; unread: number; lastMessageAt: string | null; name: string | null; phone: string; preview: string | null };
type Message = { id: string; direction: "inbound" | "outbound"; body: string | null; status: string; errorCode: string | null; at: string };
type Thread = { messages: Message[]; windowOpen: boolean; windowEndsAt: string | null };

const statusText: Record<string, string> = { queued: "Enviando…", accepted: "Enviada", sent: "Enviada", delivered: "Entregue", read: "Lida", failed: "Falhou" };
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "");

export default function Inbox({ connected, onRead }: { connected: boolean; onRead: () => void }) {
  const [list, setList] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    try { setList((await api<{ results: Conversation[] }>("/api/conversations")).results); } catch (e) { setError(errorMessage(e)); }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    try { setThread(await api<Thread>(`/api/conversations/${id}/messages`)); } catch (e) { setError(errorMessage(e)); }
  }, []);

  useEffect(() => {
    void loadList();
    const timer = setInterval(() => { if (!document.hidden) { void loadList(); if (activeId) void loadThread(activeId); } }, 8000);
    return () => clearInterval(timer);
  }, [loadList, loadThread, activeId]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length]);

  async function open(id: string) {
    setActiveId(id);
    setThread(null);
    setError("");
    await loadThread(id);
    await api(`/api/conversations/${id}/read`, { method: "POST" }).catch(() => undefined);
    void loadList();
    onRead();
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = String(new FormData(form).get("body") ?? "").trim();
    if (!body || !activeId) return;
    setSending(true);
    setError("");
    try {
      await api(`/api/conversations/${activeId}/messages`, { method: "POST", body: { body } });
      form.reset();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      await loadThread(activeId);
      void loadList();
      setSending(false);
    }
  }

  const active = list.find((c) => c.id === activeId);
  if (!list.length) {
    return (
      <section className="panel empty-panel">
        <h3>{connected ? "Nenhuma conversa ainda" : "WhatsApp ainda não conectado"}</h3>
        <p>{connected ? "Quando um cliente enviar mensagem para o seu número, a conversa aparece aqui e o lead é criado automaticamente." : "Conecte seu número em Configurações para receber e responder mensagens por aqui."}</p>
        {error && <p className="auth-error" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <div className={activeId ? "inbox has-active" : "inbox"}>
      <aside className="conv-list" aria-label="Conversas">
        {list.map((c) => (
          <button key={c.id} className={c.id === activeId ? "conv active" : "conv"} onClick={() => void open(c.id)}>
            <span className="conv-top"><b>{c.name ?? c.phone}</b><small>{time(c.lastMessageAt)}</small></span>
            <span className="conv-preview">{c.preview ?? ""}{c.unread > 0 && <em>{c.unread}</em>}</span>
          </button>
        ))}
      </aside>
      <section className="thread">
        {!active ? <p className="empty-text">Selecione uma conversa.</p> : <>
          <div className="thread-head">
            <button className="text-button back" onClick={() => setActiveId(null)}>← Voltar</button>
            <b>{active.name ?? active.phone}</b><small>{active.phone}</small>
          </div>
          <div className="messages">
            {thread?.messages.map((m) => (
              <div key={m.id} className={`bubble ${m.direction}`}>
                <p>{m.body}</p>
                <small>{time(m.at)}{m.direction === "outbound" && ` · ${statusText[m.status] ?? m.status}${m.status === "failed" && m.errorCode ? ` (${m.errorCode})` : ""}`}</small>
              </div>
            ))}
            <div ref={bottom} />
          </div>
          {error && <p className="auth-error" role="alert">{error}</p>}
          {thread && !thread.windowOpen
            ? <p className="callout-text">A janela de atendimento de 24h está encerrada. Só é possível responder quando o cliente enviar uma nova mensagem.</p>
            : <form className="composer" onSubmit={send}>
              <input name="body" placeholder="Digite uma mensagem" maxLength={4096} autoComplete="off" aria-label="Mensagem" />
              <button className="button" disabled={sending} aria-label="Enviar"><Send size={16} /></button>
            </form>}
        </>}
      </section>
    </div>
  );
}
