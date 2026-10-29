import { useState } from "react";
import {
  Bell, ChartNoAxesCombined, Check, ChevronRight, CircleHelp, ContactRound, Inbox,
  LayoutDashboard, Megaphone, Menu, MessageCircleMore, Search, Settings, ShieldCheck,
  Sparkles, UsersRound, X,
} from "lucide-react";

const nav = [
  { label: "Visão geral", icon: LayoutDashboard },
  { label: "Caixa de entrada", icon: Inbox, badge: "0" },
  { label: "Leads", icon: ContactRound },
  { label: "Campanhas", icon: Megaphone },
  { label: "Relatórios", icon: ChartNoAxesCombined },
];

const steps = [
  { title: "Crie sua organização", description: "Estrutura multiempresa preparada", done: true },
  { title: "Provisione o banco D1", description: "Crie o banco e aplique as migrações", done: false },
  { title: "Conecte a conta Meta", description: "Exige App Review e credenciais oficiais", done: false },
  { title: "Convide sua equipe", description: "Disponível após ativar a persistência", done: false },
];

function Button({ children, secondary = false, onClick }: { children: React.ReactNode; secondary?: boolean; onClick?: () => void }) {
  return <button onClick={onClick} className={secondary ? "button secondary" : "button"}>{children}</button>;
}

export default function App() {
  const [sidebar, setSidebar] = useState(false);
  const [notice, setNotice] = useState(false);
  return (
    <div className="app-shell">
      <aside className={sidebar ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <span className="brand-mark"><MessageCircleMore size={21} /></span>
          <span>AV Flow <b>CRM</b><small>Acelera Vendas</small></span>
          <button className="icon-button mobile-only" aria-label="Fechar menu" onClick={() => setSidebar(false)}><X size={20} /></button>
        </div>
        <div className="workspace">
          <span className="avatar company">AV</span>
          <span><b>Minha empresa</b><small>Configuração inicial</small></span>
          <ChevronRight size={16} />
        </div>
        <nav aria-label="Navegação principal">
          <span className="nav-label">TRABALHO</span>
          {nav.map((item, index) => <button className={index === 0 ? "nav-item active" : "nav-item"} key={item.label}>
            <item.icon size={19} /><span>{item.label}</span>{item.badge && <em>{item.badge}</em>}
          </button>)}
          <span className="nav-label">GESTÃO</span>
          <button className="nav-item"><UsersRound size={19} /><span>Equipe</span></button>
          <button className="nav-item"><Settings size={19} /><span>Configurações</span></button>
        </nav>
        <div className="sidebar-foot">
          <div className="plan-line"><span>Plano inicial</span><b>0 de 3 usuários</b></div>
          <div className="progress"><i /></div>
          <button className="nav-item"><CircleHelp size={19} /><span>Central de ajuda</span></button>
          <div className="user-row"><span className="avatar">VC</span><span><b>Você</b><small>Administrador</small></span><ChevronRight size={16} /></div>
        </div>
      </aside>

      <main>
        <header>
          <button className="icon-button mobile-only" aria-label="Abrir menu" onClick={() => setSidebar(true)}><Menu size={21} /></button>
          <div className="search"><Search size={18} /><span>Buscar contatos, leads ou conversas</span><kbd>⌘ K</kbd></div>
          <button className="icon-button" aria-label="Notificações"><Bell size={20} /></button>
          <Button onClick={() => setNotice(true)}><MessageCircleMore size={18} /> Conectar WhatsApp</Button>
        </header>

        <div className="content">
          <div className="page-heading">
            <div><p className="eyebrow">TERÇA-FEIRA, 10 DE MARÇO</p><h1>Bom dia. Vamos começar?</h1><p>Conclua a configuração para receber seus primeiros contatos com segurança.</p></div>
            <span className="status-pill"><i /> Ambiente não provisionado</span>
          </div>

          <section className="setup-card">
            <div className="setup-copy">
              <span className="setup-icon"><Sparkles size={22} /></span>
              <div><p className="eyebrow green">PRIMEIROS PASSOS</p><h2>Prepare seu espaço de atendimento</h2><p>O código da aplicação está pronto para conectar à infraestrutura. Nenhum dado de demonstração foi inserido.</p></div>
            </div>
            <div className="setup-progress"><span><b>1 de 4</b> etapas concluídas</span><strong>25%</strong></div>
            <div className="progress large"><i /></div>
            <div className="steps">
              {steps.map((step, i) => <div className="step" key={step.title}>
                <span className={step.done ? "check done" : "check"}>{step.done ? <Check size={16} /> : i + 1}</span>
                <span><b>{step.title}</b><small>{step.description}</small></span>
                {!step.done && <ChevronRight size={18} />}
              </div>)}
            </div>
          </section>

          <div className="metrics">
            {[
              ["Conversas abertas", "0", "Aguardando conexão"],
              ["Leads no período", "0", "Sem dados registrados"],
              ["Vendas confirmadas", "0", "Nenhuma venda informada"],
              ["Taxa de conversão", "—", "Dados insuficientes"],
            ].map(([label, value, help]) => <article className="metric" key={label}><span>{label}</span><strong>{value}</strong><small>{help}</small></article>)}
          </div>

          <div className="grid">
            <section className="panel empty-panel">
              <div className="panel-title"><div><h2>Atividade recente</h2><p>Movimentações reais da sua equipe</p></div><button className="text-button">Ver auditoria <ChevronRight size={16} /></button></div>
              <div className="empty-icon"><ShieldCheck size={25} /></div>
              <h3>Nenhuma atividade registrada</h3>
              <p>Os eventos aparecerão aqui depois que o banco estiver provisionado e sua equipe começar a usar o CRM.</p>
            </section>
            <section className="panel">
              <div className="panel-title"><div><h2>Integrações</h2><p>Estado verificado dos seus canais</p></div></div>
              <div className="integration">
                <span className="integration-icon"><MessageCircleMore size={22} /></span>
                <span><b>WhatsApp Business Platform</b><small>Credenciais Meta não configuradas</small></span>
                <span className="tag warning">Pendente</span>
              </div>
              <div className="callout"><ShieldCheck size={18} /><p>Usamos apenas a API oficial. Nenhum QR Code ou automação do WhatsApp Web será solicitado.</p></div>
              <Button secondary onClick={() => setNotice(true)}>Ver requisitos de conexão</Button>
            </section>
          </div>
        </div>
      </main>

      {notice && <div className="modal-backdrop" role="presentation" onMouseDown={() => setNotice(false)}>
        <section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onMouseDown={(e) => e.stopPropagation()}>
          <button className="icon-button modal-close" aria-label="Fechar" onClick={() => setNotice(false)}><X size={20} /></button>
          <span className="setup-icon"><MessageCircleMore size={23} /></span>
          <p className="eyebrow green">CONEXÃO OFICIAL</p><h2 id="modal-title">WhatsApp ainda não está configurado</h2>
          <p>Para ativar este botão é necessário publicar o Worker, criar o banco D1 e configurar o aplicativo no Meta for Developers. O Embedded Signup também depende de aprovação e elegibilidade da Meta.</p>
          <div className="modal-list"><span><b>1</b> Provisionar Cloudflare D1</span><span><b>2</b> Configurar segredos do Worker</span><span><b>3</b> Concluir configuração e revisão da Meta</span></div>
          <div className="modal-actions"><Button secondary onClick={() => setNotice(false)}>Entendi</Button></div>
        </section>
      </div>}
    </div>
  );
}
