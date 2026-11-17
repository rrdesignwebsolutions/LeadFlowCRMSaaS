export const effectiveLeadStatus = (alias: string) =>
  `CASE WHEN ${alias}.status='follow_up' AND ${alias}.financial_pending=1 THEN 'financial_pending' ELSE ${alias}.status END`

export function normalizeLeadAssessment(
  status: string | null,
  score: number | null,
  paymentViability: "blocked" | "viable" | "unknown",
  previousStatus: string,
) {
  const pending = paymentViability === "blocked" ||
    (previousStatus === "financial_pending" && paymentViability !== "viable") ||
    (status === "financial_pending" && paymentViability !== "viable")
  return {
    status: pending ? "financial_pending" : status === "financial_pending" ? "qualified" : status,
    score: pending ? Math.min(score ?? 69, 69) : score,
  }
}
