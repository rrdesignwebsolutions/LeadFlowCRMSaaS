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

  images: Array<{ id: string; key: string; mime: string; productId?: string }> = [],
) {
  const env = {
    DB: {
      prepare(sql: string) {
        let params: unknown[] = []

        return {
          bind(...values: unknown[]) {
            params = values

            return this
          },

          async all() {
            return {
              results: sql.includes("FROM catalog_images")
                ? images.filter(
                    (image) =>
                      !image.productId || image.productId === params[0],
                  )
                : rows,
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

  it("envia pelo catálogo da IA todos os produtos aprovados, mesmo sem estoque confirmado", async () => {
    const now = new Date().toISOString()
    const env = setup([
      product("TERA", "out_of_stock", now),
      product("GT1000", "in_stock", now),
      product("PIX", "unknown", null),
    ], [
      { id: "image-tera", productId: "TERA", key: "tera", mime: "image/jpeg" },
      { id: "image-gt1000", productId: "GT1000", key: "gt1000", mime: "image/jpeg" },
      { id: "image-pix", productId: "PIX", key: "pix", mime: "image/jpeg" },
    ])
    const sendFileMock = vi.mocked(sendFile)
    sendFileMock.mockReset()
    sendFileMock.mockResolvedValue(new Response(null, { status: 200 }))

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
        enviadas: 3,
        erro: null,
        modelosEnviados: ["TERA", "GT1000", "PIX"],
      })

    expect(sendFileMock).toHaveBeenCalledTimes(3)
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
