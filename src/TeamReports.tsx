import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy } from "lucide-react";
import { api, errorMessage, money, roleLabels, statusLabels, type Reports, type Team } from "./api";

export function TeamView({ meRole, onChanged }: { meRole: string; onChanged: () => void }) {
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState("");
  const [link, setLink] = useState("");
  const isAdmin = meRole === "admin";

  const load = useCallback(async () => {
    try { setTeam(await api<Team>("/api/team")); } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(action: () => Promise<unknown>) {
    setError("");
    try { await action(); await load(); onChanged(); } catch (e) { setError(errorMessage(e)); }
  }

  function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    void act(async () => {
      const result = await api<{ link: string }>("/api/team/invites", { method: "POST", body });
      setLink(result.link);
      form.reset();
    });
  }

  return (
    <>
      <div className="page-heading"><div><h1>Equipe</h1><p>{team ? `${team.seats} de ${team.seatLimit} usuários do plano` : "Carregando..."}</p></div></div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <section className="panel">
        <div className="panel-title"><div><h2>Membros</h2></div></div>
        <div className="table-wrap"><table className="leads-table">
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Status</th>{isAdmin && <th />}</tr></thead>
          <tbody>{team?.members.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td><td>{m.email}</td>
              <td>{isAdmin ? <select value={m.role} aria-label={`Papel de ${m.name}`} onChange={(e) => void act(() => api(`/api/team/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }))}>
                {Object.entries(roleLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select> : roleLabels[m.role]}</td>
              <td>{m.status === "active" ? "Ativo" : "Desativado"}</td>
              {isAdmin && <td><button className="text-button" onClick={() => void act(() => api(`/api/team/members/${m.id}`, { method: "PATCH", body: { status: m.status === "active" ? "disabled" : "active" } }))}>
                {m.status === "active" ? "Desativar" : "Reativar"}</button></td>}
            </tr>
          ))}</tbody>
        </table></div>
      </section>
      {isAdmin && (
        <section className="panel spaced">
          <div className="panel-title"><div><h2>Convidar</h2><p>Gere um link e envie à pessoa. Ele vale por 7 dias.</p></div></div>
          <form className="form inline" onSubmit={invite}>
            <label>E-mail<input name="email" type="email" required /></label>
            <label>Papel<select name="role" defaultValue="agent">{Object.entries(roleLabels).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
            <button className="button">Gerar convite</button>
          </form>
          {link && (
            <div className="callout-text">
              <span className="break">{link}</span>
              <button className="text-button" onClick={() => void navigator.clipboard.writeText(link)}><Copy size={14} /> Copiar</button>
            </div>
          )}
          {!!team?.invites.length && (
            <table className="leads-table"><thead><tr><th>Convites pendentes</th><th>Papel</th><th /></tr></thead>
              <tbody>{team.invites.map((i) => (
                <tr key={i.id}><td>{i.email}</td><td>{roleLabels[i.role]}</td>
                  <td><button className="text-button" onClick={() => void act(() => api(`/api/team/invites/${i.id}`, { method: "DELETE" }))}>Revogar</button></td></tr>
              ))}</tbody></table>
          )}
        </section>
      )}
    </>
  );
}

export function ReportsView() {
  const [data, setData] = useState<Reports | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { api<Reports>("/api/reports").then(setData).catch((e) => setError(errorMessage(e))); }, []);
  const total = data?.byStatus.reduce((n, s) => n + s.count, 0) ?? 0;
  const order = Object.keys(statusLabels);
  const rows = [...(data?.byStatus ?? [])].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const sold = data?.byStatus.find((s) => s.status === "sold")?.count ?? 0;

  return (
    <>
      <div className="page-heading"><div><h1>Relatórios</h1><p>Baseados apenas nos dados registrados no CRM.</p></div></div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="metrics">
        <article className="metric"><span>Leads</span><strong>{total}</strong><small>Total cadastrado</small></article>
        <article className="metric"><span>Vendas</span><strong>{data?.sales.count ?? 0}</strong><small>Confirmadas</small></article>
        <article className="metric"><span>Receita</span><strong>{money(data?.sales.totalCents ?? 0)}</strong><small>Vendas confirmadas</small></article>
        <article className="metric"><span>Conversão</span><strong>{total ? `${Math.round((sold / total) * 100)}%` : "—"}</strong><small>{total ? "Vendidos ÷ leads" : "Dados insuficientes"}</small></article>
      </div>
      <section className="panel">
        <div className="panel-title"><div><h2>Funil por status</h2></div></div>
        {rows.length ? rows.map((r) => (
          <div className="bar-row" key={r.status}>
            <span>{statusLabels[r.status] ?? r.status}</span>
            <div className="bar"><i style={{ width: `${(r.count / total) * 100}%` }} /></div>
            <b>{r.count}</b>
          </div>
        )) : <p className="empty-text">Nenhum lead cadastrado ainda.</p>}
      </section>
    </>
  );
}
