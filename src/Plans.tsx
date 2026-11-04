import { useEffect, useState } from "react";
import { ArrowUpRight, Check, CreditCard, ShieldCheck, Sparkles } from "lucide-react";
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
    price: 11900,
    description: "Para organizar o atendimento e não perder oportunidades.",
    features: ["Funil de vendas e gestão de leads", "Relatórios comerciais", "Até 3 usuários"],
  },
  {
    id: "pro",
    name: "Pro",
    price: 14900,
    description: "Para equipes que querem acelerar o acompanhamento.",
    features: ["Tudo do Essencial", "Assistente de IA", "Integração oficial com WhatsApp", "Até 3 usuários"],
  },
  {
    id: "scale",
    name: "Scale",
    price: 24900,
    description: "A experiência completa para sua equipe vender com mais organização.",
    features: ["Tudo do Pro", "Acesso a todos os recursos atuais do CRM", "Até 3 usuários"],
    featured: true,
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
            {plan.featured && <span className="pricing-badge"><Sparkles size={13} /> MELHOR ESCOLHA</span>}
            <h2>{plan.name}</h2>
            <p className="pricing-description">{plan.description}</p>
            <p className="pricing-price">{money(plan.price)}<span>/mês</span></p>
            <p className={plan.featured ? "pricing-per-user highlighted" : "pricing-per-user"}>
              {money(Math.round(plan.price / 3))} por pessoa/mês · 3 usuários
            </p>
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
      <section className="panel benchmark-panel">
        <div className="panel-title">
          <div>
            <p className="eyebrow green">COMPARATIVO DE MERCADO</p>
            <h2>Mais equipe, por um valor competitivo</h2>
            <p>Referência de custo mensal para uma equipe de 3 pessoas.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table className="leads-table benchmark-table">
            <thead><tr><th>CRM</th><th>Referência por pessoa/mês</th><th>Total para 3 pessoas/mês</th></tr></thead>
            <tbody>
              <tr><td>Pipedrive</td><td>~R$ 81</td><td>~R$ 243</td></tr>
              <tr><td>Kommo</td><td>~R$ 86–193</td><td>~R$ 258–579</td></tr>
              <tr className="benchmark-highlight"><td><b>AV Flow Scale</b><span className="benchmark-tag">3 usuários incluídos</span></td><td><b>R$ 83</b></td><td><b>R$ 249</b><span className="benchmark-tag">Preço mensal</span></td></tr>
            </tbody>
          </table>
        </div>
        <p className="benchmark-footnote">
          Valores de mercado aproximados, consultados em 2026. Planos, recursos, periodicidade e condições comerciais não são necessariamente equivalentes; preços podem variar.
          {" "}<a className="underline" href="https://www.calculadorakommo.com.br/blog/quanto-custa-crm-brasil-precos" target="_blank" rel="noreferrer">Ver referência</a>.
        </p>
      </section>
      <section className="billing-note">
        <span className="billing-icon"><ShieldCheck size={20} /></span>
        <div>
          <h3>Pagamento seguro pela InfinitePay</h3>
          <p>Ao escolher um plano, você será direcionado à InfinitePay para concluir a contratação. Os pagamentos recorrentes e as opções disponíveis são apresentados com segurança na plataforma.</p>
        </div>
      </section>
    </>
  );
}
