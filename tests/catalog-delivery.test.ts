import { DatabaseSync } from "node:sqlite"

import { readdirSync, readFileSync } from "node:fs"

import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  decodePDFRawStream,
  PDFArray,
  PDFDocument,
  PDFRawStream,
} from "pdf-lib"

import type { Env } from "../worker/index"

import {
  queueCatalogDelivery,
  processPendingCatalogDeliveries,
  recoverUnqueuedCatalogDeliveries,
} from "../worker/catalog"

import { createCatalogPdf } from "../worker/catalog-pdf"

import { sendFile } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/whatsapp")>()

  return { ...actual, sendFile: vi.fn() }
})

function setup() {
  const db = new DatabaseSync(":memory:")

  for (const file of readdirSync("migrations")

    .filter((name) => name.endsWith(".sql"))

    .sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))

  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES
      ('org','GoO Elétricos Itajubá','goo'),
      ('org-other','Outra empresa','outra');
    INSERT INTO contacts(id,organization_id,phone_e164) VALUES('contact','org','15551234567');
    INSERT INTO integrations(id,organization_id,provider) VALUES('integration','org','meta_whatsapp');
    INSERT INTO conversations(id,organization_id,contact_id,integration_id) VALUES('conv','org','contact','integration');
  `)

  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = []

        return {
          sql,

          args,

          bind(...values: unknown[]) {
            args = values

            this.args = values

            return this
          },

          async first() {
            return db.prepare(sql).get(...args as never[])
          },

          async all() {
            return { results: db.prepare(sql).all(...args as never[]) }
          },

          async run() {
            const result = db.prepare(sql).run(...args as never[])

            return { meta: { changes: Number(result.changes) } }
          },
        }
      },

      async batch(statements: Array<{ sql: string args: unknown[] }>) {
        return statements.map((statement) => {
          const result = db

            .prepare(statement.sql)

            .run(...statement.args as never[])

          return { meta: { changes: Number(result.changes) } }
        })
      },
    },
  } as unknown as Env

  return { db, env }
}

function addProduct(
  db: DatabaseSync,

  id: string,

  organizationId: string,

  options: {
    status?: "approved" | "draft" | "rejected"

    authorized?: number

    availability?: "in_stock" | "out_of_stock" | "unknown"
  } = {},
) {
  db.prepare(
    `INSERT INTO catalog_products(
      id,organization_id,name,model,status,authorized_for_sale,availability,description
    ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    id,

    organizationId,

    `Scooter ${id}`,

    id,

    options.status ?? "approved",

    options.authorized ?? 1,

    options.availability ?? "unknown",

    `Descrição comercial verificada ${id}`,
  )
}

function mockAcceptedFiles() {
  const mock = vi.mocked(sendFile)

  mock.mockReset()

  mock.mockImplementation(async () => {
    const messageId = `accepted-${mock.mock.calls.length}`

    return new Response(JSON.stringify({ messageId }), { status: 200 })
  })

  return mock
}

async function includedPdfIds(mock: ReturnType<typeof mockAcceptedFiles>) {
  const ids: string[] = []

  for (const call of mock.mock.calls) {
    const file = call[3]

    const pdf = await PDFDocument.load(await file.arrayBuffer())

    ids.push(...(pdf.getSubject() ?? "").split(",").filter(Boolean))

    expect(pdf.getPageCount()).toBeGreaterThan(0)
  }

  return ids
}

async function pdfText(file: File) {
  const pdf = await PDFDocument.load(await file.arrayBuffer())

  const text: string[] = []

  for (const page of pdf.getPages()) {
    const contents = pdf.context.lookup(page.node.Contents())

    const streams =
      contents instanceof PDFArray ? contents.asArray() : [page.node.Contents()]

    for (const reference of streams) {
      const stream = pdf.context.lookup(reference)

      if (!(stream instanceof PDFRawStream))
        throw new Error("O conteúdo da página do PDF não é um stream.")

      text.push(new TextDecoder().decode(decodePDFRawStream(stream).decode()))
    }
  }

  return text.join("\n")
}

function pdfHexText(value: string) {
  return `<${Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )

    .join("")

    .toUpperCase()}> Tj`
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("envio integral do catálogo aprovado", () => {
  it("inclui todas as fotos cadastradas para o produto no PDF", async () => {
    const png = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lFcAAAAASUVORK5CYII=",
        "base64",
      ),
    )
    const pdf = await createCatalogPdf(
      [
        {
          id: "MODEL",
          name: "Scooter MODEL",
          model: "MODEL",
          version: null,
          brand: "GoO",
          category: "Scooter",
          description: "Descrição verificada",
          specs: [],
          priceText: null,
          salePriceText: null,
          cardInstallments: null,
          cardInstallmentText: null,
        },
      ],
      new Map([
        [
          "MODEL",
          [
            { mime: "image/png", bytes: png },
            { mime: "image/png", bytes: png },
          ],
        ],
      ]),
      "Financiamento sujeito à aprovação.",
    )
    const file = new File([pdf], "catalogo.pdf", {
      type: "application/pdf",
    })
    const pageContent = await pdfText(file)

    expect(pageContent).toContain(pdfHexText("Scooter MODEL - fotos"))
    expect(pageContent.match(/\bDo\b/g)).toHaveLength(2)
  })

  it("inclui 20 aprovados com apenas 5 em estoque e registra ficha textual sem foto", async () => {
    const { db, env } = setup()

    const approvedIds = Array.from(
      { length: 20 },
      (_, index) => `GOO-${index + 1}`,
    )

    for (const [index, id] of approvedIds.entries())
      addProduct(db, id, "org", {
        availability: index < 5 ? "in_stock" : "out_of_stock",
      })

    addProduct(db, "PENDENTE", "org", { status: "draft" })

    addProduct(db, "REPROVADO", "org", { status: "rejected" })

    addProduct(db, "SEM-PERMISSAO", "org", { authorized: 0 })

    addProduct(db, "OUTRA-EMPRESA", "org-other")

    const mock = mockAcceptedFiles()

    const queued = await queueCatalogDelivery(env, "org", "conv", "inbound-20")

    expect(queued).toMatchObject({
      status: "ENVIANDO",

      totalAprovados: 20,

      totalSelecionados: 20,

      totalIncluidos: 20,

      totalLotes: 5,
    })

    await processPendingCatalogDeliveries(env, "org", "conv", 10)

    expect((await includedPdfIds(mock)).sort()).toEqual([...approvedIds].sort())

    for (const call of mock.mock.calls) {
      const pdf = await PDFDocument.load(await call[3].arrayBuffer())

      const text = await pdfText(call[3])

      for (const id of (pdf.getSubject() ?? "").split(","))
        expect(text).toContain(pdfHexText(`Modelo: ${id}`))
    }

    expect(mock).toHaveBeenCalledTimes(5)

    expect(
      db

        .prepare(
          "SELECT status,total_approved,total_selected,total_included FROM catalog_delivery_jobs",
        )

        .get(),
    ).toMatchObject({
      status: "completed",

      total_approved: 20,

      total_selected: 20,

      total_included: 20,
    })

    expect(
      db.prepare("SELECT product_ids FROM catalog_delivery_batches").all(),
    ).toHaveLength(5)

    db.close()
  })

  it("inclui 30 aprovados em várias páginas, inclusive modelo fora da lista histórica", async () => {
    const { db, env } = setup()

    const approvedIds = Array.from(
      { length: 29 },
      (_, index) => `MODEL-${index + 1}`,
    )

    approvedIds.push("MODELO-FORA-DA-LISTA")

    for (const [index, id] of approvedIds.entries())
      addProduct(db, id, "org", {
        availability: index < 5 ? "in_stock" : "unknown",
      })

    const mock = mockAcceptedFiles()

    const queued = await queueCatalogDelivery(env, "org", "conv", "inbound-30")

    expect(queued).toMatchObject({
      totalAprovados: 30,

      totalSelecionados: 30,

      totalIncluidos: 30,

      totalLotes: 8,
    })

    await processPendingCatalogDeliveries(env, "org", "conv", 10)

    expect((await includedPdfIds(mock)).sort()).toEqual([...approvedIds].sort())

    expect(mock).toHaveBeenCalledTimes(8)

    db.close()
  })

  it("recupera o catálogo se a saudação foi aceita antes de uma interrupção", async () => {
    const { db, env } = setup()
    addProduct(db, "RECUPERADO", "org")
    db.prepare(
      `UPDATE conversations SET ai_catalog_status='ENVIANDO',
       ai_catalog_source_external_id='inbound-orphan' WHERE id='conv'`,
    ).run()
    db.prepare(
      `INSERT INTO messages(
        id,organization_id,conversation_id,direction,type,body,status,is_ai,ai_reply_key
      ) VALUES('welcome','org','conv','outbound','text','Saudação','accepted',1,
        'ai:inbound-orphan:welcome')`,
    ).run()

    const mock = mockAcceptedFiles()
    expect(await recoverUnqueuedCatalogDeliveries(env)).toBe(1)
    await processPendingCatalogDeliveries(env, "org", "conv", 1)

    expect(mock).toHaveBeenCalledOnce()
    expect(
      db.prepare("SELECT status FROM catalog_delivery_jobs").get(),
    ).toMatchObject({ status: "completed" })
    db.close()
  })

  it("retoma no terceiro lote após rejeição recuperável sem reenviar lotes já aceitos", async () => {
    const { db, env } = setup()

    for (let index = 1; index <= 12; index++)
      addProduct(db, `RETRY-${index}`, "org")

    const mock = vi.mocked(sendFile)

    mock.mockReset()

    mock.mockImplementation(
      async (
        _env,
        _sender,
        _conversationId,
        _file,
        _caption,
        _revision,
        replyKey,
      ) => {
        const callNumber = mock.mock.calls.length

        if (callNumber === 3) {
          const messageId = "failed-third-attempt"

          db.prepare(
            `INSERT INTO messages(
            id,organization_id,conversation_id,direction,type,body,status,is_ai,ai_reply_key,error_code
          ) VALUES(?, 'org','conv','outbound','document','PDF','failed',1,?,'131000')`,
          ).run(messageId, replyKey)

          return new Response(
            JSON.stringify({
              messageId,
              error: "Meta recusou temporariamente o lote.",
            }),

            { status: 500 },
          )
        }

        return new Response(
          JSON.stringify({ messageId: `accepted-${callNumber}` }),
          {
            status: 200,
          },
        )
      },
    )

    await queueCatalogDelivery(env, "org", "conv", "inbound-retry")

    await processPendingCatalogDeliveries(env, "org", "conv", 1)

    expect(mock).toHaveBeenCalledTimes(3)

    expect(
      db

        .prepare("SELECT status FROM catalog_delivery_jobs")

        .get(),
    ).toMatchObject({ status: "pending" })

    expect(
      db

        .prepare(
          "SELECT status FROM catalog_delivery_batches ORDER BY batch_index",
        )

        .all(),
    ).toEqual([
      { status: "accepted" },

      { status: "accepted" },

      { status: "pending" },
    ])

    db.exec(
      "UPDATE catalog_delivery_jobs SET next_attempt_at=datetime('now','-1 seconds')",
    )

    await processPendingCatalogDeliveries(env, "org", "conv", 10)

    expect(mock).toHaveBeenCalledTimes(4)

    expect(mock.mock.calls.map((call) => call[6])).toEqual([
      expect.stringContaining(":batch:0:attempt:1"),

      expect.stringContaining(":batch:1:attempt:1"),

      expect.stringContaining(":batch:2:attempt:1"),

      expect.stringContaining(":batch:2:attempt:2"),
    ])

    expect(
      db

        .prepare("SELECT status FROM catalog_delivery_jobs")

        .get(),
    ).toMatchObject({ status: "completed" })

    db.close()
  })
})
