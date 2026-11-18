import { useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Plus, Search, Upload, X } from "lucide-react";
import { api, editableStatuses, errorMessage, money, statusLabels, toLocalInput, type Lead } from "./api";

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal wide" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <button className="icon-button modal-close" aria-label="Fechar" onClick={onClose}><X size={20} /></button>
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}

function NewLead({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/leads", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) });
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }
  return (
    <Modal title="Novo lead" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>Nome<input name="name" required maxLength={120} autoFocus /></label>
        <label>Telefone / WhatsApp<input name="phone" required placeholder="(11) 91234-5678" inputMode="tel" /></label>
        <label>E-mail<input name="email" type="email" maxLength={160} /></label>
        <label>Interesse / produto<input name="productInterest" maxLength={160} /></label>
        <label>Observações<textarea name="notes" rows={3} maxLength={2000} /></label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <div className="modal-actions"><button className="button" disabled={busy}>{busy ? "Salvando..." : "Criar lead"}</button></div>
      </form>
    </Modal>
  );
}

function LeadDetail({ lead, onClose, onSaved }: { lead: Lead; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selling, setSelling] = useState(false);
  const sold = lead.status === "sold";

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    void run(() => api(`/api/leads/${lead.id}`, {
      method: "PATCH",
      body: { ...f, followUpAt: f.followUpAt ? new Date(f.followUpAt).toISOString() : null },
    }));
  }

  function sell(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const f = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    void run(() => api(`/api/leads/${lead.id}/sale`, {
      method: "POST",
      body: { amount: Number(f.amount.replace(/\./g, "").replace(",", ".")), soldAt: f.soldAt ? new Date(f.soldAt).toISOString() : undefined },
    }));
  }

  return (
    <Modal title={lead.name ?? lead.phone} onClose={onClose}>
      <p className="muted">{lead.phone}{lead.email ? ` · ${lead.email}` : ""}</p>
      {selling ? (
        <form className="form" onSubmit={sell}>
          <label>Valor da venda (R$)<input name="amount" required inputMode="decimal" placeholder="1500,00" autoFocus /></label>
          <label>Data da venda<input name="soldAt" type="date" max={new Date().toISOString().slice(0, 10)} defaultValue={new Date().toISOString().slice(0, 10)} /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setSelling(false)}>Voltar</button>
            <button className="button" disabled={busy}>Confirmar venda</button>
          </div>
        </form>
      ) : (
        <form className="form" onSubmit={save}>
          {sold
            ? <p className="callout-text">Vendido{lead.saleCents != null ? ` · ${money(lead.saleCents)}` : ""}</p>
            : <label>Status<select name="status" defaultValue={lead.status}>{editableStatuses.map((s) => <option key={s} value={s}>{statusLabels[s]}</option>)}</select></label>}
          <label>Interesse / produto<input name="productInterest" defaultValue={lead.productInterest ?? ""} maxLength={160} /></label>
          <label>Próxima ação<input name="nextAction" defaultValue={lead.nextAction ?? ""} maxLength={300} /></label>
          <label>Follow-up em<input name="followUpAt" type="datetime-local" defaultValue={toLocalInput(lead.followUpAt)} /></label>
          <label>Motivo da perda (se perdido)<input name="lossReason" defaultValue={lead.lossReason ?? ""} maxLength={300} /></label>
          <label>Observações<textarea name="notes" rows={4} defaultValue={lead.notes ?? ""} maxLength={2000} /></label>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <div className="modal-actions">
            {!sold && <button type="button" className="button secondary" onClick={() => setSelling(true)}>Registrar venda</button>}
            <button className="button" disabled={busy}>Salvar</button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function ScoreBadge({ score }: { score: number | null }) {
  if (score === null) return <>—</>;
  const [label, tone] = score >= 70 ? ["Quente", "hot"] : score >= 40 ? ["Morno", "warm"] : ["Frio", "cold"];
  return <span className={`score-badge ${tone}`} title="Probabilidade de compra estimada pela IA (0 a 100)">{score} · {label}</span>;
}

export default function Leads({ leads, loadError, onChanged, canImport }: { leads: Lead[]; loadError: string; onChanged: () => void; canImport: boolean }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const priority: Record<string, number> = { hot: 0, negotiating: 1, qualified: 2, follow_up: 3, financial_pending: 4, in_service: 5, new: 6, not_contacted: 7, cold: 8, sold: 9, lost: 10 };
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const [importError, setImportError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const open = leads.find((l) => l.id === openId) ?? null;

  async function importCsv(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setImportMessage("");
    setImportError("");
    if (file.size > 2_000_000) {
      setImportError("O arquivo CSV deve ter no máximo 2 MB.");
      return;
    }
    setImporting(true);
    try {
      const csv = await file.text();
      const firstLine = csv.split(/\r?\n/, 1)[0] ?? "";
      const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
      const rows: string[][] = [];
      let row: string[] = [];
      let field = "";
      let quoted = false;
      for (let index = 0; index < csv.length; index++) {
        const character = csv[index]!;
        if (quoted) {
          if (character === '"' && csv[index + 1] === '"') {
            field += '"';
            index++;
          } else if (character === '"') quoted = false;
          else field += character;
        } else if (character === '"' && field.length === 0) quoted = true;
        else if (character === delimiter) {
          row.push(field.trim());
          field = "";
        } else if (character === "\n" || character === "\r") {
          if (character === "\r" && csv[index + 1] === "\n") index++;
          row.push(field.trim());
          if (row.some(Boolean)) rows.push(row);
          row = [];
          field = "";
        } else field += character;
      }
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      const normalizeHeader = (value: string) => value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
      const headers = (rows.shift() ?? []).map(normalizeHeader);
      const column = (...names: string[]) => headers.findIndex((value) => names.includes(value));
      const phoneColumn = column("telefone", "phone", "whatsapp", "celular");
      if (phoneColumn < 0) throw new Error("O CSV precisa ter uma coluna Telefone, Phone, WhatsApp ou Celular.");
      const nameColumn = column("nome", "name", "contato", "contact");
      const emailColumn = column("email", "mail", "emailaddress");
      const interestColumn = column("interesse", "produto", "product", "productinterest", "interesseproduto");
      const contacts = rows.map((values) => ({
        phone: values[phoneColumn] ?? "",
        name: nameColumn >= 0 ? values[nameColumn] ?? "" : "",
        email: emailColumn >= 0 ? values[emailColumn] ?? "" : "",
        productInterest: interestColumn >= 0 ? values[interestColumn] ?? "" : "",
      })).filter((contact) => contact.phone);
      if (contacts.length === 0) throw new Error("O arquivo não contém contatos com telefone.");
      if (contacts.length > 500) throw new Error("Importe no máximo 500 contatos por arquivo.");
      const result = await api<{ created: number; duplicates: number; invalid: number }>("/api/leads/import", {
        method: "POST",
        body: { contacts },
      });
      setImportMessage(`${result.created} importados · ${result.duplicates} duplicados · ${result.invalid} inválidos.`);
      onChanged();
    } catch (e) {
      setImportError(errorMessage(e));
    } finally {
      setImporting(false);
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leads.filter((l) => (filter === "all" || l.status === filter)
      && (!q || `${l.name ?? ""} ${l.phone} ${l.email ?? ""} ${l.productInterest ?? ""}`.toLowerCase().includes(q)))
      .sort((a, b) => (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || (b.aiScore ?? -1) - (a.aiScore ?? -1));
  }, [leads, query, filter]);

  return (
    <>
      <div className="page-heading">
        <div><h1>Leads</h1><p>{leads.length} no total</p></div>
        <div className="flex flex-wrap gap-2">
          <button className="button" onClick={() => setCreating(true)}><Plus size={18} /> Novo lead</button>
          {canImport && <>
            <button className="button secondary" onClick={() => importInput.current?.click()} disabled={importing}><Upload size={16} /> {importing ? "Importando..." : "Importar CSV"}</button>
            <input ref={importInput} type="file" accept=".csv,text/csv" hidden onChange={(event) => void importCsv(event)} />
          </>}
        </div>
      </div>
      {importMessage && <p className="muted" role="status">{importMessage}</p>}
      {importError && <p className="auth-error" role="alert">{importError}</p>}
      <section className="panel">
        <div className="toolbar">
          <div className="search small"><Search size={16} /><input placeholder="Buscar por nome, telefone ou interesse" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar leads" /></div>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar por status">
            <option value="all">Todos os status</option>
            {Object.entries(statusLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        {loadError && <p className="auth-error" role="alert">{loadError}</p>}
        {visible.length ? (
          <div className="table-wrap"><table className="leads-table">
            <thead><tr><th>Contato</th><th>Telefone</th><th>Interesse</th><th>Nota IA</th><th>Status</th><th>Follow-up</th></tr></thead>
            <tbody>{visible.map((l) => (
              <tr key={l.id} className="clickable" tabIndex={0} onClick={() => setOpenId(l.id)} onKeyDown={(e) => e.key === "Enter" && setOpenId(l.id)}>
                <td>{l.name ?? "Sem nome"}</td><td>{l.phone}</td><td>{l.productInterest ?? "—"}</td>
                <td><ScoreBadge score={l.aiScore} /></td>
                <td><span className={`badge ${l.status}`}>{statusLabels[l.status] ?? l.status}</span></td>
                <td>{l.followUpAt ? new Date(l.followUpAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : (
          <p className="empty-text">{leads.length ? "Nenhum lead encontrado com esses filtros." : "Você ainda não tem leads. Clique em “Novo lead” para cadastrar o primeiro."}</p>
        )}
      </section>
      {creating && <NewLead onClose={() => setCreating(false)} onSaved={onChanged} />}
      {open && <LeadDetail lead={open} onClose={() => setOpenId(null)} onSaved={onChanged} />}
    </>
  );
}
