import { describe, expect, it } from "vitest"
import type { Env } from "../worker/index"
import { runCatalogTool } from "../worker/catalog"

function product(model: string, availability: string, availabilityAt: string | null) {
  return {
    id: model,
    name: model,
    model,
    version: null,
    brand: "GoO",
    category: "Scooter",
    description: null,
    specs: "[]",
    priceText: null,
    salePriceText: null,
    cardInstallments: null,
    cardInstallmentText: null,
    status: "approved",
    authorized: 1,
    availability,
    availabilityAt,
    updatedAt: new Date().toISOString(),
  }
}

function setup(rows: ReturnType<typeof product>[]) {
  const env = {
    DB: {
      prepare() {
        return {
          bind() { return this },
          async all() { return { results: rows } },
        }
      },
    },
  } as unknown as Env
  return env
}

describe("disponibilidade no catálogo da IA", () => {
  it("lista somente produtos com estoque confirmado nos últimos sete dias", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")
    const env = setup([
      product("TERA", "in_stock", recent),
      product("GT1000", "in_stock", recentIso),
      product("PIX", "in_stock", stale),
      product("NEXT", "unknown", null),
    ])

    await expect(runCatalogTool(env, "org", "conv", "listarModelosDisponiveis", {}, { sentImages: new Set() }))
      .resolves.toMatchObject({
        modelosDisponiveis: [
          { modelo: "TERA", estoque: "confirmado" },
          { modelo: "GT1000", estoque: "confirmado" },
        ],
        quantidadeComEstoqueNaoConfirmado: 2,
      })
  })

  it("não envia pelo catálogo da IA produtos sem estoque atual confirmado", async () => {
    const env = setup([
      product("GT1000", "in_stock", null),
      product("PIX", "unknown", null),
    ])

    await expect(runCatalogTool(env, "org", "conv", "enviarCatalogoFiltrado", {}, { sentImages: new Set() }))
      .resolves.toMatchObject({
        enviadas: 0,
        erro: "Nenhum produto aprovado e autorizado tem estoque confirmado recentemente.",
      })
  })
})
