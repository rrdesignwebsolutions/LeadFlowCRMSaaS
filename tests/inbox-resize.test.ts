import { describe, expect, it } from "vitest"
import { clampSidebarWidth, sidebarWidthLimit } from "../src/inboxResize"

describe("largura da lista de conversas", () => {
  it("limita a largura mínima e máxima em telas grandes", () => {
    expect(clampSidebarWidth(100, 1600)).toBe(270)
    expect(clampSidebarWidth(450, 1600)).toBe(450)
    expect(clampSidebarWidth(1000, 1600)).toBe(700)
  })

  it("mantém espaço para a conversa em telas menores", () => {
    expect(sidebarWidthLimit(800)).toBe(472)
    expect(clampSidebarWidth(700, 800)).toBe(472)
    expect(clampSidebarWidth(100, 800)).toBe(270)
  })
})
