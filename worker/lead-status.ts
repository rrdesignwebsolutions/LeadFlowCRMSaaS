export const effectiveLeadStatus = (alias: string) =>
  `CASE WHEN ${alias}.status='follow_up' AND ${alias}.financial_pending=1 THEN 'financial_pending' ELSE ${alias}.status END`

export type PurchaseReadiness = "ready_now" | "considering" | "future" | "unknown"

export function normalizeLeadAssessment(
  status: string | null,
  score: number | null,
  paymentViability: "blocked" | "viable" | "unknown",
  purchaseReadiness: PurchaseReadiness,
  previousStatus: string,
) {
  const pending = paymentViability === "blocked" ||
    (previousStatus === "financial_pending" && paymentViability !== "viable") ||
    (status === "financial_pending" && paymentViability !== "viable")
  if (pending)
    return {
      status: "financial_pending",
      score: Math.min(score ?? 69, 69),
    }

  if (
    purchaseReadiness === "ready_now" &&
    paymentViability === "viable" &&
    score !== null &&
    score >= 70 &&
    score <= 100
  )
    return { status: "hot", score }

  const scoreBelowHotThreshold =
    score !== null && score >= 70 ? 69 : score
  return {
    status:
      status === "financial_pending" || status === "hot"
        ? "qualified"
        : status,
    score: scoreBelowHotThreshold,
  }
}
