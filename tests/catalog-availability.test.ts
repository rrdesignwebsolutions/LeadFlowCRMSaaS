import { describe, expect, it, vi } from "vitest"

import type { Env } from "../worker/index"

import { runCatalogTool } from "../worker/catalog"

import { sendFile } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", () => ({ sendFile: vi.fn() }))

function product(
  model: string,
  availability: string,
  availabilityAt: string | null,
) {
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

function setup(
  rows: ReturnType<typeof product>[],

  images: Array<{ id: string key: string mime: string }> = [],
) {
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind() {
            return this
          },

          async all() {
        return {
              results: sql.includes("FROM catalog_images") ? images : rows,
        }
      },
        }
      },
    },

    CATALOG: {
      async get() {
        return { arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer }
      },
    },
  } as unknown as Env

  return env
}

const toolState = () => ({
  sentImages: new Set<string>(),

  attemptedImages: new Set<string>(),

  imageFailures: new Map<string, string>(),
})

describe("disponibilidade no catálogo da IA", () => {
  it("lista somente produtos com estoque confirmado nos últimos sete dias", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "")

    const recentIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()

    const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d{3}Z$/, "")

    const env = setup([
      product("TERA", "in_stock", recent),

      product("GT1000", "in_stock", recentIso),

      product("PIX", "in_stock", stale),

      product("NEXT", "unknown", null),
    ])

    await expect(
      runCatalogTool(
        env,
        "org",
        "conv",
        "listarModelosDisponiveis",
        {},
        toolState(),
      ),
    )

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

    await expect(
      runCatalogTool(
        env,
        "org",
        "conv",
        "enviarCatalogoFiltrado",
        {},
        toolState(),
      ),
    )

      .resolves.toMatchObject({
        enviadas: 0,

        erro: "Nenhum produto aprovado e autorizado tem estoque confirmado recentemente.",
      })
  })

  it("não tenta enviar novamente uma foto após erro da API no mesmo turno", async () => {
    const now = new Date().toISOString()

    const env = setup(
      [product("TERA", "in_stock", now)],

      [{ id: "image-1", key: "image-key", mime: "image/jpeg" }],
    )

    const state = toolState()

    const sendFileMock = vi.mocked(sendFile)

    sendFileMock.mockReset()

    sendFileMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: "A Meta recusou o envio: erro de API" }),
        {
          status: 502,
        },
      ),
    )

    const first = await runCatalogTool(
      env,

      "org",

      "conv",

      "enviarCatalogoFiltrado",

      {},

      state,
    )

    const second = await runCatalogTool(
      env,

      "org",

      "conv",

      "enviarCatalogoFiltrado",

      {},

      state,
    )

    expect(first).toMatchObject({
      enviadas: 0,

      erro: "A Meta recusou o envio: erro de API",
    })

    expect(second).toMatchObject({
      enviadas: 0,

      erro: "A Meta recusou o envio: erro de API",
    })

    expect(sendFileMock).toHaveBeenCalledTimes(1)
  })
})
