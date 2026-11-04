import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Bot, FileText, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "./api";

type Doc = { id: string; name: string; size: number; createdAt: string };
type Settings = { enabled: boolean; assistantName: string; instructions: string };

export default function AISettings({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ready, setReady] = useState(true);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, d] = await Promise.all([
        api<{ settings: Settings; serverReady: boolean }>("/api/ai/settings"),
        api<{ results: Doc[] }>("/api/ai/knowledge"),
      ]);
      setSettings(s.settings);
      setReady(s.serverReady);
      setDocs(d.results);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(""); setMessage("");
    try {
      await api("/api/ai/settings", {
        method: "PUT",
        body: {
          enabled: form.get("enabled") === "on",
          assistantName: form.get("assistantName"),
          instructions: form.get("instructions"),
        },
      });
      setMessage("Configurações salvas.");
      await load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true); setError(""); setMessage("Lendo o PDF, pode levar alguns segundos...");
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/ai/knowledge", { method: "POST", body, credentials: "same-origin" });
      const data = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Falha ao enviar o PDF.");
      setMessage("PDF adicionado à base de conhecimento.");
      await load();
    } catch (e) { setError(errorMessage(e)); setMessage(""); } finally { setBusy(false); input.value = ""; }
  }

  async function remove(id: string) {
    if (!confirm("Remover este documento da base de conhecimento?")) return;
    try { await api(`/api/ai/knowledge/${id}`, { method: "DELETE" }); await load(); } catch (e) { setError(errorMessage(e)); }
  }

  if (!settings) return error ? <p className="auth-error" role="alert">{error}</p> : null;

  return (
    <section className="panel spaced">
      <div className="panel-title">
        <div><h2><Bot size={18} /> Assistente de IA</h2><p>Responde clientes no WhatsApp e qualifica os leads automaticamente</p></div>
        <span className={settings.enabled && ready ? "tag" : "tag warning"}>{!ready ? "Chave pendente" : settings.enabled ? "Ativo" : "Desligado"}</span>
      </div>
      {!ready && <p className="muted">Configure o segredo OPENAI_API_KEY no Worker para ativar a IA.</p>}
      <form className="form" onSubmit={save}>
        <label><span><input type="checkbox" name="enabled" defaultChecked={settings.enabled} disabled={!canEdit} /> Responder automaticamente</span></label>
        <label>Nome do assistente<input name="assistantName" defaultValue={settings.assistantName} maxLength={60} disabled={!canEdit} /></label>
        <label>Instruções da empresa (tom, horários, políticas, o que nunca prometer)
          <textarea name="instructions" rows={5} maxLength={4000} defaultValue={settings.instructions} disabled={!canEdit} />
        </label>
        {canEdit && <button className="button" disabled={busy}>Salvar</button>}
      </form>

      <div className="panel-title spaced"><div><h2>Base de conhecimento</h2><p>Envie PDFs com catálogo, preços, especificações e fotos (até 10 MB)</p></div></div>
      {canEdit && (
        <label className="button secondary">
          <Upload size={16} /> Enviar PDF
          <input type="file" accept="application/pdf" hidden onChange={upload} disabled={busy} />
        </label>
      )}
      {docs.length === 0 ? <p className="muted">Nenhum documento enviado.</p> : (
        <ul className="modal-list">
          {docs.map((d) => (
            <li key={d.id}><FileText size={16} /> {d.name} <small>({Math.ceil(d.size / 1000)} mil caracteres)</small>
              {canEdit && <button className="icon-button" aria-label={`Remover ${d.name}`} onClick={() => void remove(d.id)}><Trash2 size={16} /></button>}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="muted" role="status">{message}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <p className="muted">A IA passa a conversa para a equipe quando o cliente pede um atendente, quer negociar ou quando ela não encontra a resposta no material. Ela pausa por 30 minutos sempre que um atendente responde.</p>
    </section>
  );
}
