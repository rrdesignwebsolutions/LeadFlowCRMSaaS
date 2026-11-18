import { describe, expect, it } from "vitest"
import { formatCentsInput, formatExistingCurrency } from "../src/currency"

describe("formatação de moeda do catálogo", () => {
  it("interpreta a digitação como centavos e formata em reais", () => {
    expect(formatCentsInput("")).toBe("")
    expect(formatCentsInput("1")).toBe("R$ 0,01")
    expect(formatCentsInput("1250")).toBe("R$ 12,50")
    expect(formatCentsInput("1299000")).toBe("R$ 12.990,00")
    expect(formatCentsInput("000012")).toBe("R$ 0,12")
    expect(formatCentsInput("R$ 12,50")).toBe("R$ 12,50")
  })

  it("mantém o valor de preços já cadastrados e reconhece centavos", () => {
    expect(formatExistingCurrency("R$ 12.990")).toBe("R$ 12.990,00")
    expect(formatExistingCurrency("R$ 1.250,5")).toBe("R$ 1.250,50")
    expect(formatExistingCurrency("1250")).toBe("R$ 1.250,00")
    expect(formatExistingCurrency("")).toBe("")
    expect(formatExistingCurrency("a consultar")).toBeNull()
    expect(formatExistingCurrency("12.99")).toBeNull()
  })

  it("limita entradas sem truncar valores antigos em silêncio", () => {
    expect(formatCentsInput("1234567890123456")).toBe("R$ 1.234.567.890.123,45")
    expect(formatExistingCurrency("12345678901234")).toBeNull()
  })
})
