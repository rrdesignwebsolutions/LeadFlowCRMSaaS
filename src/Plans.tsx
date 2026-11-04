import { useEffect, useState } from "react";
import { ArrowUpRight, Check, CreditCard, Sparkles } from "lucide-react";
import { api, errorMessage, money } from "./api";

type PlanId = "essencial" | "pro" | "scale";
type BillingPlans = { available: PlanId[] };

const plans: Array<{
  id: PlanId;
  name: string;
  price: number;
  description: string;
  features: string[];
  featured?: boolean;
}> = [
  {
    id: "essencial",
    name: "Essencial",
    price: 7900,
    description: "Para organizar o atendimento e não perder oportunidades.",
    features: ["Funil de vendas e gestão de leads", "Relatórios comerciais", "Até 3 usuários"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 14900,
    description: "Para equipes que querem acelerar o acompanhamento.",
    features: ["Tudo do Essencial", "Assistente de IA", "Integração oficial com WhatsApp", "Até 3 usuários"],
    featured: true,
  },
  {
    id: "scale",
    name: "Scale",
    price: 29900,
    description: "Para operações que usam o CRM diariamente para acompanhar vendas.",
    features: ["Tudo do Pro", "Acesso a todos os recursos atuais do CRM", "Até 3 usuários"],
  },
];

export default function Plans({ meRole }: { meRole: string }) {
  const [available, setAvailable] = useState<PlanId[]>([]);
  const [error, setError] = useState("");
  const [loadingPlan, setLoadingPlan] = useState<PlanId | null>(null);
  const isAdmin = meRole === "admin";

  useEffect(() => {
    api<BillingPlans>("/api/billing/plans")
      .then((result) => setAvailable(result.available))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  async function subscribe(planId: PlanId) {
    setError("");
    setLoadingPlan(planId);
    try {
      const { checkoutUrl } = await api<{ checkoutUrl: string }>("/api/billing/checkout", {
        method: "POST",
        body: { planId },
      });
      window.location.assign(checkoutUrl);
    } catch (e) {
      setError(errorMessage(e));
      setLoadingPlan(null);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow green">PLANOS AV FLOW</p>
          <h1>Escolha seu plano</h1>
          <p>Assinatura mensal com pagamento processado diretamente pela InfinitePay.</p>
        </div>
      </div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {!isAdmin && <p className="callout" role="status">Somente o administrador da empresa pode contratar ou alterar o plano.</p>}
      <div className="pricing-grid">
        {plans.map((plan) => (
          <article className={plan.featured ? "pricing-card featured" : "pricing-card"} key={plan.id}>
            {plan.featured && <span className="pricing-badge"><Sparkles size={13} /> MAIS ESCOLHIDO</span>}
            <h2>{plan.name}</h2>
            <p className="pricing-description">{plan.description}</p>
            <p className="pricing-price">{money(plan.price)}<span>/mês</span></p>
            <ul>
              {plan.features.map((feature) => <li key={feature}><Check size={16} />{feature}</li>)}
            </ul>
            <button
              className={plan.featured ? "button pricing-action" : "button secondary pricing-action"}
              disabled={!isAdmin || !available.includes(plan.id) || loadingPlan !== null}
              onClick={() => void subscribe(plan.id)}
            >
              <CreditCard size={16} />
              {loadingPlan === plan.id ? "Abrindo pagamento..." : available.includes(plan.id) ? "Assinar com InfinitePay" : "Link em configuração"}
              {available.includes(plan.id) && <ArrowUpRight size={15} />}
            </button>
          </article>
        ))}
      </div>
      <section className="panel spaced">
        <div className="panel-title"><div><h2>Compare antes de escolher</h2><p>Posicionamento de preço pensado para pequenas equipes.</p></div></div>
        <p className="muted">
          Como referência indicativa, comparativos de mercado de 2026 apontam planos por usuário de cerca de R$ 81/mês no Pipedrive e R$ 86–193/mês no Kommo. Os valores variam conforme câmbio, cobrança anual e condições comerciais.
          {" "}<a className="underline" href="https://www.calculadorakommo.com.br/blog/quanto-custa-crm-brasil-precos" target="_blank" rel="noreferrer">Fonte de referência</a>.
        </p>
      </section>
      <section className="callout billing-note">
        <CreditCard size={18} />
        <p>
          O pagamento e a renovação recorrente são gerenciados na sua conta InfinitePay. Após o pagamento, confirme a assinatura no painel InfinitePay: este app ainda não recebe confirmação automática nem altera limites de acesso com base no plano. Custos de mensagens da Meta e de uso de IA podem ser cobrados à parte.
          {" "}Os meios de pagamento dependem das opções disponíveis para a cobrança configurada na InfinitePay. Os preços são uma sugestão comercial, não uma garantia de lucro; revise custos, taxas e impostos antes de publicar.
        </p>
      </section>
    </>
  );
}
