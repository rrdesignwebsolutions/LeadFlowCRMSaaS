import { describe, expect, it } from "vitest"
import { displayMessage } from "../src/messageDisplay"

describe("exibição de mensagens antigas indisponíveis", () => {
  it("esclarece o aviso antigo sem inventar o motivo ou conteúdo", () => {
    expect(displayMessage("[Mensagem não suportada]", "unsupported")).toBe("[Mensagem não disponibilizada pela Meta. Confira no WhatsApp Business.]")
    expect(displayMessage("[Mensagem não suportada]", "text")).toBe("[Mensagem não suportada]")
    expect(displayMessage("Olá", "text")).toBe("Olá")
    expect(displayMessage(null, null)).toBeNull()
  })
})
