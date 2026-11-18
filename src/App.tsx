import { useCallback, useEffect, useState, type FormEvent } from "react"

import {
  Boxes,
  Bot,
  ChartNoAxesCombined,
  ChevronRight,
  ContactRound,
  CreditCard,
  Inbox,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LogOut,
  Mail,
  Megaphone,
  Menu,
  MessageCircleMore,
  Globe,
  Settings,
  ShieldCheck,
  UsersRound,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from "lucide-react"

import AISettings from "./AISettings"

import AuthScreen from "./AuthScreen"

import Catalog from "./Catalog"
import QuickReplies from "./QuickReplies"

import InboxView from "./Inbox"

import Leads from "./Leads"

import Plans from "./Plans"
import SalesPage from "./SalesPage"
import Support from "./Support"

import WhatsAppSettings from "./WhatsAppSettings"
import Workflows from "./Workflows"
import { GmailWorkspace, Onboarding, WebchatWorkspace } from "./Channels"

import { applyBranding, BrandingSettings, type Branding } from "./Branding"

import { ReportsView, TeamView } from "./TeamReports"

import {
  api,
  ApiError,
  errorMessage,
  money,
  roleLabels,
  statusLabels,
  type Lead,
  type Me,
  type Metrics,
} from "./api"

type View = "overview" | "inbox" | "webchat" | "email" | "onboarding" | "leads" | "catalog" | "quick-replies" | "campaigns" | "reports" | "agent" | "workflows" | "team" | "plans" | "settings" | "support"

const work: Array<{ id: View; label: string; icon: typeof Inbox }> = [
  { id: "overview", label: "Visão geral", icon: LayoutDashboard },

  { id: "inbox", label: "Caixa de entrada", icon: Inbox },

  { id: "webchat", label: "Chat do site", icon: Globe },

  { id: "email", label: "E-mail", icon: Mail },

  { id: "leads", label: "Leads", icon: ContactRound },

  { id: "catalog", label: "Catálogo", icon: Boxes },

  { id: "quick-replies", label: "Mensagens rápidas", icon: Zap },

  { id: "campaigns", label: "Campanhas", icon: Megaphone },

  { id: "agent", label: "Agente de IA", icon: Bot },

  { id: "workflows", label: "Fluxos de IA", icon: WorkflowIcon },

  { id: "reports", label: "Relatórios", icon: ChartNoAxesCombined },
]

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("")

function isMeResponse(value: unknown): value is Me {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  const subscription = record.subscription
  if (!subscription || typeof subscription !== "object") return false
  const status = (subscription as Record<string, unknown>).status
  return (
    typeof record.name === "string" &&
    typeof record.email === "string" &&
    typeof record.organization === "string" &&
    typeof record.organizationId === "string" &&
    typeof record.role === "string" &&
    (status === "trialing" || status === "active" || status === "expired")
  )
}

function EmailChange({ current, onChanged }: { current: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const f = new FormData(event.currentTarget)
    setBusy(true)
    setError("")

    try {
      await api("/api/me/email", {
        method: "PUT",
        body: { email: f.get("email"), password: f.get("password") },
      })
      setOpen(false)
      onChanged()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open)
    return (
      <button type="button" className="button secondary" onClick={() => setOpen(true)}>
        Trocar e-mail
      </button>
    )

  return (
    <form className="form" onSubmit={submit}>
      <label>
        Novo e-mail
        <input name="email" type="email" required maxLength={160} defaultValue={current} />
      </label>
      <label>
        Senha atual (para confirmar)
        <input name="password" type="password" required autoComplete="current-password" />
      </label>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="catalog-actions">
        <button className="button" disabled={busy}>Salvar e-mail</button>
        <button type="button" className="button secondary" onClick={() => setOpen(false)}>Cancelar</button>
      </div>
    </form>
  )
}

function Empty({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="panel empty-panel">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </section>
  )
}

export default function App() {
  if (window.location.pathname === "/vendas") return <SalesPage />
  return <WorkspaceApp />
}

function WorkspaceApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)

  const [bootstrapError, setBootstrapError] = useState("")

  const [metrics, setMetrics] = useState<Metrics | null>(null)

  const [leads, setLeads] = useState<Lead[]>([])

  const [loadError, setLoadError] = useState("")

  const [branding, setBranding] = useState<Branding | null>(null)

  const updateBranding = useCallback((b: Branding | null) => {
    setBranding(b)
    applyBranding(b)
  }, [])

  const load = useCallback(async () => {
    try {
      const response = await api<unknown>("/api/me")
      if (!isMeResponse(response))
        throw new ApiError(502, "O servidor retornou dados incompletos da conta.")
      const current = response

      setBootstrapError("")
      setMe(current)

      if (current.subscription.status === "expired") {
        setMetrics(null)
        setLeads([])
        setLoadError("")
        return
      }

      api<Branding>("/api/branding")
        .then(updateBranding)
        .catch(() => undefined)

      const [m, l] = await Promise.all([
        api<Metrics>("/api/dashboard"),
        api<{ results: Lead[] }>("/api/leads"),
      ])

      setMetrics(m)

      setLeads(l.results)

      setLoadError("")
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setMe(null)
        setBootstrapError("")
      }
      else {
        setMe((current) => current ?? null)
        const message = errorMessage(e)
        setLoadError(message)
        setBootstrapError((current) => current || message)
      }
    }
  }, [updateBranding])

  useEffect(() => {
    // Retorno do checkout: confirma o pagamento antes de carregar o app (o webhook também faz isso).

    const params = new URLSearchParams(window.location.search)

    const order = params.get("order_nsu")

    const run = async () => {
      if (order) {
        window.history.replaceState({}, "", window.location.pathname)

        await api("/api/billing/confirm", {
          method: "POST",
          body: {
            order_nsu: order,
            transaction_nsu: params.get("transaction_nsu"),
            slug: params.get("slug"),
          },
        }).catch(() => undefined)
      }

      await load()
    }

    void run()
  }, [load])

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined)
    setMe(null)
    setMetrics(null)
    setLeads([])
    updateBranding(null)
  }

  if (me === undefined) return <div className="auth-page">Carregando...</div>

  if (me === null && bootstrapError)
    return (
      <div className="auth-page">
      <section className="auth-card" role="alert">
        <div className="brand">
          <img className="brand-mark" src="/app-icon.png" alt="" />
          <span>AV Flow <b>CRM</b><small>Acelera Vendas</small></span>
        </div>
        <h1>Não foi possível conectar</h1>
        <p>{bootstrapError}</p>
        <button className="button" onClick={() => { setMe(undefined); setBootstrapError(""); void load() }}>
          Tentar novamente
        </button>
      </section>
      </div>
    )

  if (me === null)
    return (
      <AuthScreen
        onDone={() => {
          setMe(undefined)
          setBootstrapError("")
          void load()
        }}
      />
    )

  if (me.subscription.status === "expired")
    return <Locked me={me} reload={load} onLogout={logout} />

  return (
    <Shell
      me={me}
      branding={branding}
      onBranding={updateBranding}
      metrics={metrics}
      leads={leads}
      loadError={loadError}
      reload={load}
      onLogout={logout}
    />
  )
}

function Locked({
  me,
  reload,
  onLogout,
}: {
  me: Me
  reload: () => void
  onLogout: () => void
}) {
  // Aguarda a confirmação do pagamento (webhook) liberar o acesso.

  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) reload()
    }, 8000)

    return () => clearInterval(timer)
  }, [reload])

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 16px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <b>{me.organization}</b>
        <button className="button secondary" onClick={onLogout}>
          <LogOut size={16} /> Sair
        </button>
      </div>
      <p className="callout" role="alert">
        Seu período de teste terminou e o acesso está suspenso. Seus dados estão
        preservados: assine um plano para voltar de onde parou.
      </p>
      <Plans meRole={me.role} />
    </div>
  )
}

function Shell({
  me,
  branding,
  onBranding,
  metrics,
  leads,
  loadError,
  reload,
  onLogout,
}: {
  me: Me
  branding: Branding | null
  onBranding: (b: Branding) => void
  metrics: Metrics | null
  leads: Lead[]
  loadError: string
  reload: () => void
  onLogout: () => void
}) {
  const [view, setView] = useState<View>("overview")

  const [sidebar, setSidebar] = useState(false)

  const [wa, setWa] = useState<{ connected: boolean; label: string }>({
    connected: false,
    label: "Não conectado",
  })

  const [unread, setUnread] = useState(0)

  const go = (next: View) => {
    setView(next)
    setSidebar(false)
  }

  const refreshWa = useCallback(async () => {
    const [integrationResult, conversationsResult] = await Promise.allSettled([
      api<{
        integration: {
          status: string
          displayPhoneNumber: string | null
        } | null
      }>("/api/integrations/whatsapp"),
      api<{
        results: Array<{ unread: number; humanRequestedAt?: string | null }>
      }>("/api/conversations"),
    ])

    if (integrationResult.status === "fulfilled") {
      const integration = integrationResult.value.integration
      const connected = integration?.status === "connected"
      setWa({
        connected,
        label: !integration
          ? "Não conectado"
          : connected
            ? `Conectado${
                integration.displayPhoneNumber
                  ? ` · ${integration.displayPhoneNumber}`
                  : ""
              }`
            : "Com erro",
      })
    } else {
      console.warn(
        "whatsapp_status_refresh_failed",
        integrationResult.reason instanceof ApiError
          ? integrationResult.reason.status
          : "request_failed",
      )
    }

    if (conversationsResult.status === "fulfilled") {
      setUnread(
        conversationsResult.value.results.reduce(
          (count, conversation) =>
            count +
            (conversation.unread > 0 || conversation.humanRequestedAt ? 1 : 0),
          0,
        ),
      )
    } else {
      console.warn(
        "inbox_notifications_refresh_failed",
        conversationsResult.reason instanceof ApiError
          ? conversationsResult.reason.status
          : "request_failed",
      )
    }
  }, [])

  useEffect(() => {
    void refreshWa()

    const timer = setInterval(() => {
      if (!document.hidden) void refreshWa()
    }, 20000)

    return () => clearInterval(timer)
  }, [refreshWa])

  const seatPct = metrics
    ? Math.min(100, (metrics.seats / metrics.seatLimit) * 100)
    : 0

  const today = new Date()
    .toLocaleDateString("pt-BR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    })
    .toUpperCase()

  const conversion =
    metrics && metrics.leads > 0
      ? `${Math.round((metrics.sold / metrics.leads) * 100)}%`
      : "—"

  const revenue = leads.reduce((sum, l) => sum + (l.saleCents ?? 0), 0)

  const followUps = leads
    .filter((l) => l.followUpAt && l.status !== "sold" && l.status !== "lost")
    .sort((a, b) => a.followUpAt!.localeCompare(b.followUpAt!))
    .slice(0, 5)

  return (
    <div className={view === "inbox" ? "app-shell inbox-mode" : "app-shell"}>
      <aside className={sidebar ? "sidebar open" : "sidebar"}>
        <div className="brand">
          <img
            className="brand-mark"
            src={branding?.logo ?? "/app-icon.png"}
            alt=""
          />
          {branding?.displayName ? (
            <span>
              {branding.displayName}
              <small>{branding.tagline ?? ""}</small>
            </span>
          ) : (
            <span>
              AV Flow <b>CRM</b>
              <small>{branding?.tagline ?? "Acelera Vendas"}</small>
            </span>
          )}
          <button
            className="icon-button mobile-only"
            aria-label="Fechar menu"
            onClick={() => setSidebar(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace">
          <span className="avatar company">
            {branding?.logo ? (
              <img src={branding.logo} alt="" />
            ) : (
              initials(me.organization)
            )}
          </span>
          <span>
            <b>{me.organization}</b>
            <small>Plano inicial</small>
          </span>
        </div>
        <nav aria-label="Navegação principal">
          <span className="nav-label">TRABALHO</span>
          {work.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "nav-item active" : "nav-item"}
              onClick={() => go(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "leads" && <em>{leads.length}</em>}
              {item.id === "inbox" && unread > 0 && <em>{unread}</em>}
            </button>
          ))}
          <span className="nav-label">GESTÃO</span>
          <button
            className={view === "team" ? "nav-item active" : "nav-item"}
            onClick={() => go("team")}
          >
            <UsersRound size={19} />
            <span>Equipe</span>
          </button>
          <button
            className={view === "onboarding" ? "nav-item active" : "nav-item"}
            onClick={() => go("onboarding")}
          >
            <ListChecks size={19} />
            <span>Configuração inicial</span>
          </button>
          <button
            className={view === "plans" ? "nav-item active" : "nav-item"}
            onClick={() => go("plans")}
          >
            <CreditCard size={19} />
            <span>Planos</span>
          </button>
          <button
            className={view === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => go("settings")}
          >
            <Settings size={19} />
            <span>Configurações</span>
          </button>
          <button
            className={view === "support" ? "nav-item active" : "nav-item"}
            onClick={() => go("support")}
          >
            <LifeBuoy size={19} />
            <span>Suporte</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <div className="plan-line">
            <span>Plano inicial</span>
            <b>
              {metrics
                ? `${metrics.seats} de ${metrics.seatLimit} usuários`
                : ""}
            </b>
          </div>
          <div className="progress">
            <i style={{ width: `${seatPct}%` }} />
          </div>
          <div className="user-row">
            <span className="avatar">
              {branding?.avatar ? (
                <img src={branding.avatar} alt="" />
              ) : (
                initials(me.name)
              )}
            </span>
            <span>
              <b>{me.name}</b>
              <small>{roleLabels[me.role] ?? me.role}</small>
            </span>
          </div>
          <button className="nav-item" onClick={onLogout}>
            <LogOut size={19} />
            <span>Sair</span>
          </button>
        </div>
      </aside>

      <main>
        <header>
          <button
            className="icon-button mobile-only"
            aria-label="Abrir menu"
            onClick={() => setSidebar(true)}
          >
            <Menu size={21} />
          </button>
          <span className="header-title">{me.organization}</span>
        </header>

        <div className={view === "inbox" ? "content inbox-content" : "content"}>
          {view !== "inbox" && me.subscription.status === "trialing" && (
            <p className="callout" role="status">
              Teste grátis: {me.subscription.daysLeft}{" "}
              {me.subscription.daysLeft === 1
                ? "dia restante"
                : "dias restantes"}
              .{" "}
              <button className="underline" onClick={() => go("plans")}>
                Assinar um plano
              </button>
            </p>
          )}
          {view === "overview" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">{today}</p>
                  <h1>Olá, {me.name.split(" ")[0]}!</h1>
                  <p>Resumo do seu funil comercial.</p>
                </div>
                <button className="button" onClick={() => go("leads")}>
                  Ver leads
                </button>
              </div>
              {loadError && (
                <p className="auth-error" role="alert">
                  {loadError}
                </p>
              )}
              <div className="metrics">
                {[
                  [
                    "Leads",
                    String(metrics?.leads ?? 0),
                    `${metrics?.active ?? 0} em andamento`,
                  ],

                  [
                    "Qualificados",
                    String(metrics?.qualified ?? 0),
                    `${metrics?.hot ?? 0} quentes`,
                  ],

                  [
                    "Vendas",
                    String(metrics?.sold ?? 0),
                    revenue ? money(revenue) : "Nenhuma venda informada",
                  ],

                  [
                    "Conversão",
                    conversion,
                    metrics?.leads ? "Vendidos ÷ leads" : "Dados insuficientes",
                  ],
                ].map(([label, value, help]) => (
                  <article className="metric" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                    <small>{help}</small>
                  </article>
                ))}
              </div>
              <div className="grid">
                <section className="panel">
                  <div className="panel-title">
                    <div>
                      <h2>Próximos follow-ups</h2>
                      <p>Leads com retorno agendado</p>
                    </div>
                    <button className="text-button" onClick={() => go("leads")}>
                      Ver todos <ChevronRight size={16} />
                    </button>
                  </div>
                  {followUps.length ? (
                    followUps.map((l) => (
                      <div className="row-item" key={l.id}>
                        <span>
                          <b>{l.name ?? l.phone}</b>
                          <small>
                            {statusLabels[l.status]}
                            {l.nextAction ? ` · ${l.nextAction}` : ""}
                          </small>
                        </span>
                        <time>
                          {new Date(l.followUpAt!).toLocaleString("pt-BR", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </time>
                      </div>
                    ))
                  ) : (
                    <p className="empty-text">
                      Nenhum follow-up agendado. Defina um ao abrir um lead.
                    </p>
                  )}
                </section>
                <section className="panel">
                  <div className="panel-title">
                    <div>
                      <h2>Integrações</h2>
                      <p>Estado dos seus canais</p>
                    </div>
                  </div>
                  <div className="integration">
                    <span className="integration-icon">
                      <MessageCircleMore size={22} />
                    </span>
                    <span>
                      <b>WhatsApp Business Platform</b>
                      <small>{wa.label}</small>
                    </span>
                    <span className={wa.connected ? "tag ok" : "tag warning"}>
                      {wa.connected ? "Ativo" : "Pendente"}
                    </span>
                  </div>
                  <div className="callout">
                    <ShieldCheck size={18} />
                    <p>
                      Usamos apenas a API oficial.{" "}
                      {wa.connected
                        ? "Mensagens recebidas criam leads automaticamente."
                        : "Enquanto não conecta, cadastre leads manualmente."}
                    </p>
                  </div>
                  <button
                    className="button secondary"
                    onClick={() => go(wa.connected ? "inbox" : "settings")}
                  >
                    {wa.connected
                      ? "Abrir caixa de entrada"
                      : "Conectar WhatsApp"}
                  </button>
                </section>
              </div>
            </>
          )}

          {view === "leads" && (
            <Leads
              leads={leads}
              loadError={loadError}
              onChanged={reload}
              canImport={me.role === "admin" || me.role === "manager"}
            />
          )}
          {view === "webchat" && (
            <WebchatWorkspace canEdit={me.role === "admin" || me.role === "manager"} />
          )}
          {view === "email" && (
            <GmailWorkspace canEdit={me.role === "admin" || me.role === "manager"} />
          )}
          {view === "onboarding" && <Onboarding onNavigate={(next) => go(next)} />}
          {view === "catalog" && <Catalog />}
          {view === "quick-replies" && <QuickReplies />}
          {view === "team" && <TeamView meRole={me.role} onChanged={reload} />}
          {view === "plans" && <Plans meRole={me.role} />}
          {view === "reports" && (
            <ReportsView key={leads.length + ":" + metrics?.sold} />
          )}

          {view === "inbox" && (
            <InboxView
              connected={wa.connected}
              isAdmin={me.role === "admin"}
              onRead={() => void refreshWa()}
              onExit={() => setView("overview")}
            />
          )}

          {view === "campaigns" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Campanhas</h1>
                </div>
              </div>
              <Empty
                icon={<Megaphone size={25} />}
                title="Sem dados de campanhas"
              >
                A atribuição de leads a campanhas depende de origem comprovada
                (anúncios Click-to-WhatsApp, Lead Ads ou UTM). Ela será
                habilitada junto com a integração da Meta; nada é estimado.
              </Empty>
            </>
          )}

          {view === "agent" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Agente de IA</h1>
                  <p>Configure o perfil, as instruções e o treinamento do assistente.</p>
                </div>
              </div>
              <AISettings
                canEdit={me.role === "admin" || me.role === "manager"}
              />
            </>
          )}

          {view === "workflows" && (
            <Workflows organizationId={me.organizationId} canEdit={me.role === "admin" || me.role === "manager"} />
          )}

          {view === "settings" && (
            <>
              <div className="page-heading">
                <div>
                  <h1>Configurações</h1>
                </div>
              </div>
              <section className="panel">
                <div className="panel-title">
                  <div>
                    <h2>Conta</h2>
                  </div>
                </div>
                <dl className="info">
                  <dt>Empresa</dt>
                  <dd>{me.organization}</dd>
                  <dt>Nome</dt>
                  <dd>{me.name}</dd>
                  <dt>E-mail</dt>
                  <dd>{me.email}</dd>
                  <dt>Papel</dt>
                  <dd>{roleLabels[me.role] ?? me.role}</dd>
                </dl>
                <div style={{ padding: "0 24px 20px" }}>
                  <EmailChange current={me.email} onChanged={reload} />
                </div>
              </section>
              <BrandingSettings
                branding={branding}
                isAdmin={me.role === "admin"}
                onSaved={onBranding}
                companyName={me.organization}
              />
              <WhatsAppSettings
                isAdmin={me.role === "admin"}
                onChanged={reload}
              />
            </>
          )}
          {view === "support" && <Support email={me.email} />}
          {view !== "inbox" && (
            <footer className="mt-8 border-t border-line pt-5 text-xs text-muted">
              <a
                href="/privacy.html"
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                Política de Privacidade
              </a>
            </footer>
          )}
        </div>
      </main>
    </div>
  )
}
