import { describe, expect, it } from "vitest"
import { historySyncWasSuperseded } from "../src/WhatsAppSettings"

describe("estado da sincronização do histórico", () => {
  it("identifica pedido anterior à reconexão", () => {
    expect(historySyncWasSuperseded("2026-11-17 18:08:01", "2026-11-17 17:33:22")).toBe(true)
  })

  it("mantém o acompanhamento quando o pedido pertence à conexão atual", () => {
    expect(historySyncWasSuperseded("2026-11-17 17:20:08", "2026-11-17 17:33:22")).toBe(false)
  })

  it("não declara uma tentativa anterior sem os dois horários", () => {
    expect(historySyncWasSuperseded(null, "2026-11-17 17:33:22")).toBe(false)
    expect(historySyncWasSuperseded("2026-11-17 18:08:01", null)).toBe(false)
  })
})
