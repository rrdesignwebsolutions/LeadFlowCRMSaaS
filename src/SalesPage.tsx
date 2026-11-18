import { useCallback, useEffect, useRef, useState } from "react"

import {
  ArrowDown,
  ArrowRight,
  BadgeCheck,
  BarChart3,
  Bot,
  Check,
  ChevronDown,
  CircleDollarSign,
  MessageCircleMore,
  ShieldCheck,
  Sparkles,
  Target,
  UsersRound,
  Zap,
} from "lucide-react"

import AuthScreen from "./AuthScreen"

import { api, errorMessage, money } from "./api"

import { plans, type PlanId } from "./Plans"

import "./sales-page.css"

type PublicOrder = {
  status: "pending" | "paid" | "claimed"

  plan: PlanId
}

const benefits = [
  {
    icon: MessageCircleMore,

    title: "Conversas em um só lugar",

    description:
      "Acompanhe o atendimento oficial do WhatsApp junto ao histórico de cada oportunidade.",
  },

  {
    icon: Target,

    title: "Leads com próximo passo",

    description:
      "Organize o funil, registre interesses e saiba quem precisa de acompanhamento.",
  },

  {
    icon: Bot,

    title: "Theo, assistente de IA",

    description:
      "Ajude sua equipe a responder e qualificar conversas com continuidade.",
  },

  {
    icon: BarChart3,

    title: "Visão da operação",

    description:
      "Consulte indicadores e relatórios para acompanhar o trabalho comercial.",
  },

  {
    icon: Zap,

    title: "Rotina mais consistente",

    description:
      "Use lembretes, mensagens rápidas e catálogo para dar sequência ao atendimento.",
  },

  {
    icon: UsersRound,

    title: "Feito para a equipe",

    description:
      "Compartilhe o processo comercial com até três usuários incluídos nos planos.",
  },
]

export default function SalesPage() {
  const params = new URLSearchParams(window.location.search)

  const orderNsu = params.get("order_nsu")

  const transactionNsu = params.get("transaction_nsu")

  const slug = params.get("slug")

  const [annual, setAnnual] = useState(false)

  const [loadingPlan, setLoadingPlan] = useState<PlanId | null>(null)

  const [checkoutError, setCheckoutError] = useState("")

  const [order, setOrder] = useState<PublicOrder | null>(null)

  const [paymentError, setPaymentError] = useState("")

  const [checkingPayment, setCheckingPayment] = useState(false)

  const orderRef = useRef<PublicOrder | null>(null)

  const checkRunning = useRef(false)

  const refreshOrder = useCallback(
    async (confirmPayment = false, showBusy = false) => {
      if (!orderNsu || checkRunning.current) return

      checkRunning.current = true

      if (showBusy) setCheckingPayment(true)

      let confirmationFailed = false

      try {
        if (confirmPayment) {
          try {
            await api("/api/public/billing/confirm", {
              method: "POST",

              body: {
                order_nsu: orderNsu,

                transaction_nsu: transactionNsu,

                slug,
              },
            })
          } catch {
            confirmationFailed = true
          }
        }

        const current = await api<PublicOrder>(
          `/api/public/billing/status?order_nsu=${encodeURIComponent(orderNsu)}`,
        )

        orderRef.current = current

        setOrder(current)

        setPaymentError(
          confirmationFailed && current.status === "pending"
            ? "A confirmação ainda está sendo processada. Vamos verificar novamente em instantes."
            : "",
        )
      } catch (reason) {
        setPaymentError(errorMessage(reason))
      } finally {
        checkRunning.current = false

        if (showBusy) setCheckingPayment(false)
      }
    },

    [orderNsu, slug, transactionNsu],
  )

  useEffect(() => {
    if (!orderNsu) return

    void refreshOrder(Boolean(transactionNsu || slug))

    const timer = window.setInterval(() => {
      if (
        !checkRunning.current &&
        (!orderRef.current || orderRef.current.status === "pending")
      )
        void refreshOrder()
    }, 5000)

    return () => window.clearInterval(timer)
  }, [orderNsu, refreshOrder, slug, transactionNsu])

  async function checkout(planId: PlanId) {
    setCheckoutError("")

    setLoadingPlan(planId)

    try {
      const result = await api<{ checkoutUrl: string }>(
        "/api/public/billing/checkout",

        {
          method: "POST",

          body: { planId, cycle: annual ? "annual" : "monthly" },
        },
      )

      window.location.assign(result.checkoutUrl)
    } catch (reason) {
      setCheckoutError(errorMessage(reason))

      setLoadingPlan(null)
    }
  }

  if (orderNsu && order?.status === "paid")
    return (
      <div className="sales-registration">
        <div className="sales-registration-heading">
          <a className="sales-brand" href="/vendas">
            <img src="/app-icon.png" alt="" />
            <span>
              AV Flow <b>CRM</b>
            </span>
          </a>
          <span className="sales-paid-badge">
            <BadgeCheck size={16} /> Pagamento confirmado
          </span>
        </div>
        <AuthScreen
          paidOrderNsu={orderNsu}
          onDone={() => window.location.assign("/")}
        />
      </div>
    )

  if (orderNsu)
    return (
      <main className="sales-checkout-state">
        <a className="sales-brand" href="/vendas">
          <img src="/app-icon.png" alt="" />
          <span>
            AV Flow <b>CRM</b>
          </span>
        </a>
        {order?.status === "claimed" ? (
          <section className="sales-state-card">
            <span className="sales-state-icon success">
              <BadgeCheck size={25} />
            </span>
            <p className="sales-eyebrow">PAGAMENTO JÁ VINCULADO</p>
            <h1>Seu plano já está associado a uma conta.</h1>
            <p>Entre no AV Flow CRM para continuar.</p>
            <a className="sales-button primary" href="/">
              Acessar minha conta <ArrowRight size={17} />
            </a>
          </section>
        ) : (
          <section className="sales-state-card">
            <span className="sales-state-icon">
              <CircleDollarSign size={25} />
            </span>
            <p className="sales-eyebrow">CONFIRMAÇÃO DE PAGAMENTO</p>
            <h1>
              {order?.status === "paid"
                ? "Pagamento confirmado"
                : "Estamos confirmando seu pagamento"}
            </h1>
            <p>
              {order?.status === "paid"
                ? "Seu acesso está pronto. Atualize esta página para continuar com o cadastro."
                : "A confirmação segura é feita pela InfinitePay. Assim que recebermos a confirmação, liberaremos o cadastro da sua conta."}
            </p>
            {paymentError && (
              <p className="sales-alert" role="status">
                {paymentError}
              </p>
            )}
            <button
              className="sales-button primary"
              type="button"
              disabled={checkingPayment}
              onClick={() => void refreshOrder(true, true)}
            >
              {checkingPayment
                ? "Verificando..."
                : "Já paguei — verificar novamente"}
              <ArrowRight size={17} />
            </button>
            <small>Pedido: {orderNsu}</small>
          </section>
        )}
      </main>
    )

  return (
    <div className="sales-page">
      <header className="sales-nav">
        <a className="sales-brand" href="#inicio">
          <img src="/app-icon.png" alt="" />
          <span>
            AV Flow <b>CRM</b>
          </span>
        </a>
        <nav aria-label="Navegação da página de vendas">
          <a href="#recursos">Recursos</a>
          <a href="#como-funciona">Como funciona</a>
          <a href="#planos">Planos</a>
        </nav>
        <a className="sales-nav-login" href="/">
          Entrar
        </a>
      </header>

      <main>
        <section className="sales-hero" id="inicio">
          <div className="sales-hero-glow" aria-hidden="true" />
          <div className="sales-hero-inner">
            <div className="sales-hero-copy">
              <p className="sales-eyebrow">
                <Sparkles size={14} /> CRM DE VENDAS PARA QUEM ATENDE POR
                CONVERSA
              </p>
              <h1>
                Mais organização em cada conversa. Mais clareza para vender.
              </h1>
              <p className="sales-hero-description">
                O AV Flow reúne leads, atendimento, acompanhamento e
                inteligência artificial em um fluxo simples — para lojas de
                scooters elétricas e equipes comerciais de qualquer segmento.
              </p>
              <div className="sales-hero-actions">
                <a className="sales-button primary" href="#planos">
                  Escolher meu plano <ArrowRight size={17} />
                </a>
                <a className="sales-button secondary" href="#recursos">
                  Conhecer recursos <ArrowDown size={16} />
                </a>
              </div>
              <div className="sales-trust-row">
                <span>
                  <ShieldCheck size={16} /> Pagamento processado pela
                  InfinitePay
                </span>
                <span>
                  <UsersRound size={16} /> Até 3 usuários por plano
                </span>
              </div>
            </div>

            <div
              className="sales-product"
              aria-label="Exemplo da caixa de entrada do AV Flow CRM"
            >
              <div className="sales-product-top">
                <span className="sales-product-mark">
                  <MessageCircleMore size={16} />
                </span>
                <div>
                  <b>Caixa de entrada</b>
                  <small>Exemplo de atendimento</small>
                </div>
                <span className="sales-live">
                  <i /> Em atendimento
                </span>
              </div>
              <div className="sales-product-body">
                <div className="sales-product-side">
                  <span className="sales-product-side-title">CONVERSAS</span>
                  <div className="sales-contact active">
                    <i>ML</i>
                    <span>
                      <b>Marina Lopes</b>
                      <small>Tenho uma dúvida sobre...</small>
                    </span>
                  </div>
                  <div className="sales-contact">
                    <i>RC</i>
                    <span>
                      <b>Rafael Costa</b>
                      <small>Queria conhecer os modelos</small>
                    </span>
                  </div>
                  <div className="sales-contact">
                    <i>AS</i>
                    <span>
                      <b>Ana Souza</b>
                      <small>Podemos falar amanhã?</small>
                    </span>
                  </div>
                </div>
                <div className="sales-product-chat">
                  <div className="sales-chat-header">
                    <i>ML</i>
                    <span>
                      <b>Marina Lopes</b>
                      <small>Lead · Em atendimento</small>
                    </span>
                    <span className="sales-tag">Quente</span>
                  </div>
                  <div className="sales-chat-messages">
                    <p className="sales-chat-in">
                      Oi! Quero saber mais sobre uma scooter elétrica.
                    </p>
                    <p className="sales-chat-out">
                      Oi, Marina! Claro 😊 Qual modelo chamou sua atenção?
                    </p>
                    <p className="sales-chat-in">
                      Quero entender as opções de pagamento.
                    </p>
                  </div>
                  <div className="sales-chat-input">
                    <span>Escreva uma mensagem...</span>
                    <span>
                      <ArrowRight size={14} />
                    </span>
                  </div>
                </div>
              </div>
              <div className="sales-product-footer">
                <span>
                  <Bot size={15} /> Theo pode apoiar o primeiro atendimento
                </span>
                <span>Pipeline atualizado</span>
              </div>
            </div>
          </div>
          <div className="sales-hero-bottom">
            <span>PARA SCOOTERS ELÉTRICAS</span>
            <i />
            <span>VEÍCULOS</span>
            <i />
            <span>VAREJO</span>
            <i />
            <span>EQUIPES DE VENDAS</span>
          </div>
        </section>

        <section className="sales-section sales-benefits" id="recursos">
          <div className="sales-section-heading">
            <p className="sales-eyebrow">
              UM FLUXO, DO PRIMEIRO OI AO PRÓXIMO PASSO
            </p>
            <h2>Venda melhor começa com um atendimento bem organizado.</h2>
            <p>
              Tenha contexto para responder, acompanhar e avançar cada
              oportunidade sem depender de planilhas soltas.
            </p>
          </div>
          <div className="sales-benefit-grid">
            {benefits.map(({ icon: Icon, title, description }, index) => (
              <article className="sales-benefit-card" key={title}>
                <span className="sales-benefit-number">0{index + 1}</span>
                <span className="sales-benefit-icon">
                  <Icon size={20} />
                </span>
                <h3>{title}</h3>
                <p>{description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="sales-process" id="como-funciona">
          <div className="sales-process-inner">
            <div className="sales-process-copy">
              <p className="sales-eyebrow">SIMPLES PARA COMEÇAR</p>
              <h2>Seu processo comercial, com começo, meio e próximo passo.</h2>
              <p>
                O AV Flow ajuda a equipe a transformar o movimento do dia a dia
                em um processo que todos conseguem acompanhar.
              </p>
              <a className="sales-text-link" href="#planos">
                Ver planos disponíveis <ArrowRight size={16} />
              </a>
            </div>
            <div className="sales-steps">
              <article>
                <span>01</span>
                <div>
                  <h3>Receba e organize</h3>
                  <p>
                    Centralize leads e conversas em uma rotina clara para sua
                    equipe.
                  </p>
                </div>
                <Check size={18} />
              </article>
              <article>
                <span>02</span>
                <div>
                  <h3>Entenda o interesse</h3>
                  <p>
                    Registre produto, necessidade e estágio para responder com
                    contexto.
                  </p>
                </div>
                <Check size={18} />
              </article>
              <article>
                <span>03</span>
                <div>
                  <h3>Acompanhe até avançar</h3>
                  <p>
                    Defina próximos passos e acompanhe oportunidades no funil.
                  </p>
                </div>
                <Check size={18} />
              </article>
            </div>
          </div>
        </section>

        <section className="sales-section sales-pricing" id="planos">
          <div className="sales-section-heading">
            <p className="sales-eyebrow">PLANOS AV FLOW CRM</p>
            <h2>Escolha o plano para a fase da sua operação.</h2>
            <p>
              Selecione o plano, conclua o pagamento seguro e crie sua conta na
              sequência.
            </p>
          </div>
          <div
            className="sales-billing-toggle"
            role="group"
            aria-label="Periodicidade do plano"
          >
            <button
              className={!annual ? "active" : ""}
              type="button"
              onClick={() => setAnnual(false)}
            >
              Mensal
            </button>
            <button
              className={annual ? "active" : ""}
              type="button"
              onClick={() => setAnnual(true)}
            >
              Anual <span>2 meses grátis</span>
            </button>
          </div>
          {checkoutError && (
            <p className="sales-alert" role="alert">
              {checkoutError}
            </p>
          )}
          <div className="sales-plan-grid">
            {plans.map((plan) => (
              <article
                className={plan.featured ? "sales-plan featured" : "sales-plan"}
                key={plan.id}
              >
                {plan.featured && (
                  <span className="sales-plan-badge">
                    <Sparkles size={13} /> MAIS COMPLETO
                  </span>
                )}
                <p className="sales-plan-name">{plan.name}</p>
                <p className="sales-plan-description">{plan.description}</p>
                <p className="sales-plan-price">
                  {money(annual ? plan.price * 10 : plan.price)}
                  <span>{annual ? "/ano" : "/mês"}</span>
                </p>
                {annual && (
                  <p className="sales-plan-equivalent">
                    Equivale a {money(Math.round((plan.price * 10) / 12))}/mês
                  </p>
                )}
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>
                      <Check size={15} />
                      {feature}
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  className={
                    plan.featured
                      ? "sales-button primary"
                      : "sales-button plan-secondary"
                  }
                  disabled={loadingPlan !== null}
                  onClick={() => void checkout(plan.id)}
                >
                  {loadingPlan === plan.id
                    ? "Preparando pagamento..."
                    : "Escolher plano"}
                  {loadingPlan !== plan.id && <ArrowRight size={16} />}
                </button>
                <small className="sales-plan-note">
                  <ShieldCheck size={14} /> Checkout seguro pela InfinitePay
                </small>
              </article>
            ))}
          </div>
          <p className="sales-pricing-footnote">
            Após a confirmação do pagamento, a página libera o cadastro. O
            acesso é ativado no plano contratado.
          </p>
        </section>

        <section className="sales-faq">
          <div className="sales-section-heading">
            <p className="sales-eyebrow">DÚVIDAS FREQUENTES</p>
            <h2>Antes de escolher seu plano.</h2>
          </div>
          <div className="sales-faq-list">
            <details>
              <summary>
                Preciso criar uma conta antes de pagar?
                <ChevronDown size={17} />
              </summary>
              <p>
                Não. Primeiro você escolhe o plano e conclui o pagamento. Depois
                que a InfinitePay confirmar a transação, o cadastro é liberado
                nesta página.
              </p>
            </details>
            <details>
              <summary>
                Como minha conta é ativada?
                <ChevronDown size={17} />
              </summary>
              <p>
                A confirmação é validada pelo servidor junto à InfinitePay. Em
                seguida, você cria sua conta com o plano já associado à empresa.
              </p>
            </details>
            <details>
              <summary>
                O AV Flow serve só para lojas de scooters elétricas?
                <ChevronDown size={17} />
              </summary>
              <p>
                Não. A plataforma atende lojas de scooters elétricas e outras
                empresas que precisam organizar leads, conversas e
                acompanhamento comercial.
              </p>
            </details>
            <details>
              <summary>
                Quantos usuários estão incluídos?
                <ChevronDown size={17} />
              </summary>
              <p>
                Os planos apresentados incluem até três usuários, conforme os
                recursos descritos em cada plano.
              </p>
            </details>
          </div>
        </section>

        <section className="sales-final-cta">
          <div>
            <p className="sales-eyebrow">PRONTO PARA ORGANIZAR SUAS VENDAS?</p>
            <h2>Escolha seu plano e comece pelo próximo atendimento.</h2>
          </div>
          <a className="sales-button primary" href="#planos">
            Ver planos <ArrowRight size={17} />
          </a>
        </section>
      </main>

      <footer className="sales-footer">
        <a className="sales-brand" href="#inicio">
          <img src="/app-icon.png" alt="" />
          <span>
            AV Flow <b>CRM</b>
          </span>
        </a>
        <span>CRM de vendas para equipes que atendem por conversa.</span>
        <a href="/privacy.html" target="_blank" rel="noreferrer">
          Privacidade
        </a>
      </footer>
    </div>
  )
}
