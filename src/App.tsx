import { useCallback, useEffect, useState } from "react";
import {
  ChartNoAxesCombined, ChevronRight, ContactRound, Inbox, LayoutDashboard, LogOut, Megaphone, Menu,
  MessageCircleMore, Settings, ShieldCheck, UsersRound, X,
} from "lucide-react";
import AuthScreen from "./AuthScreen";
import Leads from "./Leads";
import { ReportsView, TeamView } from "./TeamReports";
import { api, ApiError, errorMessage, money, roleLabels, statusLabels, type Lead, type Me, type Metrics } from "./api";

type View = "overview" | "inbox" | "leads" | "campaigns" | "reports" | "team" | "settings";

const work: Array<{ id: View; label: string; icon: typeof Inbox }> = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },
  { id: "inbox", label: "Caixa de entrada", icon: Inbox },
  { id: "leads", label: "Leads", icon: ContactRound },
  { id: "campaigns", label: "Campanhas", icon: Megaphone },
  { id: "reports", label: "Relatórios", icon: ChartNoAxesCombined },
];

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

function Empty({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="panel empty-panel">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  );
}

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      setMe(await api<Me>("/api/me"));
      const [m, l] = await Promise.all([api<Metrics>("/api/dashboard"), api<{ results: Lead[] }>("/api/leads")]);
      setMetrics(m);
      setLeads(l.results);
      setLoadError("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else { setMe((current) => current ?? null); setLoadError(errorMessage(e)); }
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (me === undefined) return <div className="auth-page">Carregando...</div>;
  if (me === null) return <AuthScreen onDone={() => { setMe(undefined); void load(); }} />;
  return <Shell me={me} metrics={metrics} leads={leads} loadError={loadError} reload={load}
    onLogout={async () => { await api("/api/auth/logout", { method: "POST" }).catch(() => undefined); setMe(null); setMetrics(null); setLeads([]); }} />;
}

function Shell({ me, metrics, leads, loadError, reload, onLogout }: {
  me: Me; metrics: Metrics | null; leads: Lead[]; loadError: string; reload: () => void; onLogout: () => void;
}) {
  const [view, setView] = useState<View>("overview");
  const [sidebar, setSidebar] = useState(false);
  const [wa, setWa] = useState<{ connected: boolean; label: string }>({ connected: false, label: "Não conectado" });
  const [unread, setUnread] = useState(0);
  const go = (next: View) => { setView(next); setSidebar(false); };

  const refreshWa = useCallback(async () => {
    try {
      const r = await api<{ integration: { status: string; displayPhoneNumber: string | null } | null }>("/api/integrations/whatsapp");
      const ok = r.integration?.status === "connected";
      setWa({ connected: ok, label: !r.integration ? "Não conectado" : ok ? `Conectado${r.integration.displayPhoneNumber ? ` · ${r.integration.displayPhoneNumber}` : ""}` : "Com erro" });
      if (ok) setUnread((await api<{ results: Array<{ unread: number }> }>("/api/conversations")).results.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0));
      else setUnread(0);
    } catch { /* o indicador é apenas informativo */ }
  }, []);
  useEffect(() => {
    void refreshWa();
    const timer = setInterval(() => { if (!document.hidden) void refreshWa(); }, 20000);
    return () => clearInterval(timer);
  }, [refreshWa]);
  const seatPct = metrics ? Math.min(100, (metrics.seats / metrics.seatLimit) * 100) : 0;
  const today = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }).toUpperCase();
  const conversion = metrics && metrics.leads > 0 ? `${Math.round((metrics.sold / metrics.leads) * 100)}%` : "—";
  const revenue = leads.reduce((sum, l) => sum + (l.saleCents ?? 0), 0);
  const followUps = leads.filter((l) => l.followUpAt && l.status !== "sold" && l.status !== "lost").sort((a, b) => a.followUpAt!.localeCompare(b.followUpAt!)).slice(0, 5);

  return (
    <div className="app-shell">
      <aside className={sidebar ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="brand-mark"><MessageCircleMore size={21} /></span>
          <span>AV Flow <b>CRM</b><small>Acelera Vendas</small></span>
          <button className="icon-button mobile-only" aria-label="Fechar menu" onClick={() => setSidebar(false)}><X size={20} /></button>
        </div>
        <div className="workspace">
          <span className="avatar company">{initials(me.organization)}</span>
          <span><b>{me.organization}</b><small>Plano inicial</small></span>
        </div>
        <nav aria-label="Navegação principal">
          <span className="nav-label">TRABALHO</span>
          {work.map((item) => (
            <button key={item.id} className={view === item.id ? "nav-item active" : "nav-item"} onClick={() => go(item.id)}>
              <item.icon size={19} /><span>{item.label}</span>{item.id === "leads" && <em>{leads.length}</em>}{item.id === "inbox" && unread > 0 && <em>{unread}</em>}
            </button>
          ))}
          <span className="nav-label">GESTÃO</span>
          <button className={view === "team" ? "nav-item active" : "nav-item"} onClick={() => go("team")}><UsersRound size={19} /><span>Equipe</span></button>
          <button className={view === "settings" ? "nav-item active" : "nav-item"} onClick={() => go("settings")}><Settings size={19} /><span>Configurações</span></button>
        </nav>
        <div className="sidebar-foot">
          <div className="plan-line"><span>Plano inicial</span><b>{metrics ? `${metrics.seats} de ${metrics.seatLimit} usuários` : ""}</b></div>
          <div className="progress"><i style={{ width: `${seatPct}%` }} /></div>
          <div className="user-row"><span className="avatar">{initials(me.name)}</span><span><b>{me.name}</b><small>{roleLabels[me.role] ?? me.role}</small></span></div>
          <button className="nav-item" onClick={onLogout}><LogOut size={19} /><span>Sair</span></button>
        </div>
      </aside>

      <main>
        <header>
          <button className="icon-button mobile-only" aria-label="Abrir menu" onClick={() => setSidebar(true)}><Menu size={21} /></button>
          <span className="header-title">{me.organization}</span>
        </header>

        <div className="content">
          {view === "overview" && <>
            <div className="page-heading">
              <div><p className="eyebrow">{today}</p><h1>Olá, {me.name.split(" ")[0]}!</h1><p>Resumo do seu funil comercial.</p></div>
              <button className="button" onClick={() => go("leads")}>Ver leads</button>
            </div>
            {loadError && <p className="auth-error" role="alert">{loadError}</p>}
            <div className="metrics">
              {[
                ["Leads", String(metrics?.leads ?? 0), `${metrics?.active ?? 0} em andamento`],
                ["Qualificados", String(metrics?.qualified ?? 0), `${metrics?.hot ?? 0} quentes`],
                ["Vendas", String(metrics?.sold ?? 0), revenue ? money(revenue) : "Nenhuma venda informada"],
                ["Conversão", conversion, metrics?.leads ? "Vendidos ÷ leads" : "Dados insuficientes"],
              ].map(([label, value, help]) => <article className="metric" key={label}><span>{label}</span><strong>{value}</strong><small>{help}</small></article>)}
            </div>
            <div className="grid">
              <section className="panel">
                <div className="panel-title"><div><h2>Próximos follow-ups</h2><p>Leads com retorno agendado</p></div><button className="text-button" onClick={() => go("leads")}>Ver todos <ChevronRight size={16} /></button></div>
                {followUps.length ? followUps.map((l) => (
                  <div className="row-item" key={l.id}>
                    <span><b>{l.name ?? l.phone}</b><small>{statusLabels[l.status]}{l.nextAction ? ` · ${l.nextAction}` : ""}</small></span>
                    <time>{new Date(l.followUpAt!).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time>
                  </div>
                )) : <p className="empty-text">Nenhum follow-up agendado. Defina um ao abrir um lead.</p>}
              </section>
              <section className="panel">
                <div className="panel-title"><div><h2>Integrações</h2><p>Estado dos seus canais</p></div></div>
                <div className="integration">
                  <span className="integration-icon"><MessageCircleMore size={22} /></span>
                  <span><b>WhatsApp Business Platform</b><small>{wa.label}</small></span>
                  <span className={wa.connected ? "tag ok" : "tag warning"}>{wa.connected ? "Ativo" : "Pendente"}</span>
                </div>
                <div className="callout"><ShieldCheck size={18} /><p>Usamos apenas a API oficial. {wa.connected ? "Mensagens recebidas criam leads automaticamente." : "Enquanto não conecta, cadastre leads manualmente."}</p></div>
                <button className="button secondary" onClick={() => go(wa.connected ? "inbox" : "settings")}>{wa.connected ? "Abrir caixa de entrada" : "Conectar WhatsApp"}</button>
              </section>
            </div>
          </>}

          {view === "leads" && <Leads leads={leads} loadError={loadError} onChanged={reload} />}
          {view === "team" && <TeamView meRole={me.role} onChanged={reload} />}
          {view === "reports" && <ReportsView key={leads.length + ":" + metrics?.sold} />}

          {view === "inbox" && <>
            <div className="page-heading"><div><h1>Caixa de entrada</h1></div></div>
            <Empty icon={<MessageCircleMore size={25} />} title="WhatsApp ainda não conectado">
              As conversas aparecerão aqui depois que a integração oficial com a Meta for concluída. Até lá, use a aba Leads para registrar seus contatos.
            </Empty>
          </>}

          {view === "campaigns" && <>
            <div className="page-heading"><div><h1>Campanhas</h1></div></div>
            <Empty icon={<Megaphone size={25} />} title="Sem dados de campanhas">
              A atribuição de leads a campanhas depende de origem comprovada (anúncios Click-to-WhatsApp, Lead Ads ou UTM). Ela será habilitada junto com a integração da Meta; nada é estimado.
            </Empty>
          </>}

          {view === "settings" && <>
            <div className="page-heading"><div><h1>Configurações</h1></div></div>
            <section className="panel">
              <div className="panel-title"><div><h2>Conta</h2></div></div>
              <dl className="info">
                <dt>Empresa</dt><dd>{me.organization}</dd>
                <dt>Nome</dt><dd>{me.name}</dd>
                <dt>E-mail</dt><dd>{me.email}</dd>
                <dt>Papel</dt><dd>{roleLabels[me.role] ?? me.role}</dd>
              </dl>
            </section>
            <section className="panel spaced">
              <div className="panel-title"><div><h2>WhatsApp Business Platform</h2><p>Integração oficial da Meta</p></div><span className="tag warning">Pendente</span></div>
              <div className="modal-list">
                <span><b>1</b> Criar o app e o Embedded Signup no Meta for Developers</span>
                <span><b>2</b> Cadastrar os segredos META_APP_SECRET e META_VERIFY_TOKEN no Worker</span>
                <span><b>3</b> Registrar o webhook /api/webhooks/meta</span>
                <span><b>4</b> Concluir App Review e verificação empresarial</span>
              </div>
              <p className="muted">Nenhum QR Code ou automação do WhatsApp Web é usado.</p>
            </section>
          </>}
        </div>
      </main>
    </div>
  );
}
