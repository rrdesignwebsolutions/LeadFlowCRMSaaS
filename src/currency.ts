const MAX_CENTS_DIGITS = 15

export function formatCentsInput(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, MAX_CENTS_DIGITS)
  if (!digits) return ""
  const padded = digits.replace(/^0+(?=\d)/, "").padStart(3, "0")
  const whole = padded.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ".")
  return `R$ ${whole},${padded.slice(-2)}`
}

export function formatExistingCurrency(value: string | null | undefined) {
  if (!value) return ""
  const trimmed = value.trim()
  const match = trimmed.match(/^(?:R\$\s*)?(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?$/i)
  if (!match) return null
  const whole = match[1].replace(/\./g, "").replace(/^0+(?=\d)/, "")
  const cents = (match[2] ?? "").padEnd(2, "0")
  if (`${whole}${cents}`.length > MAX_CENTS_DIGITS) return null
  return formatCentsInput(`${whole}${cents}`)
}
