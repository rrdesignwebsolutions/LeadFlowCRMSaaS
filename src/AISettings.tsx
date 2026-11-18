import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Bot, FileText, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "./api";

type Doc = { id: string; name: string; size: number; sourceType: string; sourceUrl: string | null; question: string | null; answer: string | null; createdAt: string };
type Settings = { enabled: boolean; assistantName: string; instructions: string; mediaProcessingEnabled: boolean; responseStyle: string; businessDescription: string; language: string };

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
          mediaProcessingEnabled: form.get("mediaProcessingEnabled") === "on",
          responseStyle: form.get("responseStyle"),
          businessDescription: form.get("businessDescription"),
          language: form.get("language"),
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

  async function addFaq(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setError(""); setMessage("");
    try {
      await api("/api/ai/knowledge/faq", {
        method: "POST",
        body: { question: values.get("question"), answer: values.get("answer") },
      });
      form.reset();
      setMessage("Pergunta e resposta adicionadas à base de conhecimento.");
      await load();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  async function importWebsite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true); setError(""); setMessage("Importando o conteúdo público do site...");
    try {
      await api("/api/ai/knowledge/website", {
        method: "POST",
        body: { url: values.get("url") },
      });
      form.reset();
      setMessage("Página adicionada à base de conhecimento.");
      await load();
    } catch (e) { setError(errorMessage(e)); setMessage(""); } finally { setBusy(false); }
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
        <label>Estilo de resposta
          <select name="responseStyle" defaultValue={settings.responseStyle} disabled={!canEdit}>
            <option value="conservative">Conservador</option>
            <option value="balanced">Equilibrado</option>
            <option value="creative">Criativo, sem inventar informações</option>
          </select>
        </label>
        <label>Idioma preferido
          <select name="language" defaultValue={settings.language} disabled={!canEdit}>
            <option value="pt-BR">Português (Brasil)</option>
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        </label>
        <label>Sobre a empresa
          <textarea name="businessDescription" rows={4} maxLength={4000} defaultValue={settings.businessDescription} disabled={!canEdit} placeholder="Descreva a empresa e o que ela oferece." />
        </label>
        <label>Instruções da empresa (tom, horários, políticas, o que nunca prometer)
          <textarea name="instructions" rows={12} defaultValue={settings.instructions} disabled={!canEdit} />
        </label>
        <label>
          <span>
            <input type="checkbox" name="mediaProcessingEnabled" defaultChecked={settings.mediaProcessingEnabled} disabled={!canEdit || !ready} />
            Permitir que a IA analise áudios e imagens recebidos
          </span>
          <small className="muted">Quando ativado, mídias recebidas são enviadas à OpenAI para transcrição ou análise visual e podem gerar custos de API. Desativado por padrão.</small>
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
      {canEdit && (
        <div className="grid gap-4 md:grid-cols-2">
          <form className="form panel" onSubmit={addFaq}>
            <h3>Pergunta e resposta</h3>
            <label>Pergunta<input name="question" maxLength={1000} required disabled={busy} /></label>
            <label>Resposta<textarea name="answer" rows={4} maxLength={5000} required disabled={busy} /></label>
            <button className="button" disabled={busy}>Adicionar resposta</button>
          </form>
          <form className="form panel" onSubmit={importWebsite}>
            <h3>Importar uma página pública</h3>
            <label>URL segura (HTTPS)<input name="url" type="url" placeholder="https://suaempresa.com.br/ajuda" required disabled={busy} /></label>
            <p className="muted">O AV Flow importa somente texto público; páginas de até 1 MB e conteúdo de até 30 mil caracteres.</p>
            <button className="button secondary" disabled={busy}>Importar página</button>
          </form>
        </div>
      )}
      {docs.length === 0 ? <p className="muted">Nenhum documento enviado.</p> : (
        <ul className="modal-list">
          {docs.map((d) => (
            <li key={d.id}><FileText size={16} /> {d.name} <small>({d.sourceType === "faq" ? "Pergunta e resposta" : d.sourceType === "website" ? "Site" : "PDF"} · {Math.ceil(d.size / 1000)} mil caracteres)</small>
              {d.sourceUrl && <a href={d.sourceUrl} target="_blank" rel="noreferrer">Abrir fonte</a>}
              {canEdit && <button className="icon-button" aria-label={`Remover ${d.name}`} onClick={() => void remove(d.id)}><Trash2 size={16} /></button>}
            </li>
          ))}
        </ul>
      )}
      {message && <p className="muted" role="status">{message}</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}
      <p className="muted">A IA oferece falar com um vendedor quando identifica um lead quente que precisa de ajuda para fechar a compra. Pedidos diretos de atendimento são registrados e encaminhados; a conversa só fica pausada quando uma pessoa assume ou envia uma mensagem manual.</p>
      <p className="muted">Na caixa de entrada, atribua uma conversa a um membro para manter a IA pausada até devolvê-la ao assistente. Ao retomar, a IA tenta responder à última mensagem de texto pendente, respeitando a janela de 24 horas do WhatsApp.</p>
      <p className="muted">Leads interessados sem uma forma de pagamento viável ficam em Pendência financeira, não como Quente. A IA reavalia quando surgir uma alternativa de pagamento.</p>
    </section>
  );
}
