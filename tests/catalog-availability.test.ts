import { describe, expect, it, vi } from "vitest"
import { PDFDocument } from "pdf-lib"

import type { Env } from "../worker/index"

import { runCatalogTool, sendCatalog } from "../worker/catalog"

import { sendFile, sendText } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", () => ({
  sendFile: vi.fn(),
  sendText: vi.fn(),
}))

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

  images: Array<{
    id: string
    key: string
    mime: string
    productId?: string
    size?: number
  }> = [],
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
                ? images
                    .filter((image) =>
                      sql.includes("product_id=? AND organization_id=?")
                        ? image.productId === params[0]
                        : params.slice(1).includes(image.productId),
                    )
                    .map((image) => ({ ...image, size: image.size ?? 3 }))
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

  it("envia PDFs em lotes com todos os produtos aprovados, sem filtrar estoque ou fotos", async () => {
    const products = Array.from({ length: 16 }, (_, index) =>
      product(
        `MODEL-${index + 1}`,
        index === 0 ? "out_of_stock" : index === 1 ? "unknown" : "in_stock",
        null,
      ),
    )
    const env = setup(
      products,
      products.slice(0, 15).map((item) => ({
        id: `image-${item.id}`,
        productId: item.id,
        key: item.id,
        mime: "image/jpeg",
        size: 3,
      })),
    )
    const sendFileMock = vi.mocked(sendFile)
    sendFileMock.mockReset()
    sendFileMock.mockResolvedValue(new Response(null, { status: 200 }))
    const sendTextMock = vi.mocked(sendText)
    sendTextMock.mockReset()
    sendTextMock.mockResolvedValue(new Response(null, { status: 200 }))

    await expect(
      sendCatalog(
        env,
        { userId: "user", organizationId: "org", role: "admin" },
        "conv",
        null,
      ),
    )
      .resolves.toMatchObject({
        enviadas: 4,
        erro: null,
        modelosEnviados: products.map((item) => item.model),
      })

    expect(sendFileMock).toHaveBeenCalledTimes(4)
    expect(sendTextMock).not.toHaveBeenCalled()
    const includedIds: string[] = []
    for (const [file] of sendFileMock.mock.calls.map((call) => [call[3]])) {
      const pdf = await PDFDocument.load(await file.arrayBuffer())
      includedIds.push(...(pdf.getSubject() ?? "").split(","))
      expect(pdf.getPageCount()).toBeGreaterThan(0)
    }
    expect(includedIds).toEqual(products.map((item) => item.id))
  })
})
