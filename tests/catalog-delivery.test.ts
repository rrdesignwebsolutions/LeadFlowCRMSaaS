import { DatabaseSync } from "node:sqlite"

import { readdirSync, readFileSync } from "node:fs"

import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env, Session } from "../worker/index"

import {
  queueCatalogDelivery,
  processPendingCatalogDeliveries,
  recoverUnqueuedCatalogDeliveries,
  sendCatalog,
} from "../worker/catalog"

import { sendFile, sendText } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../worker/whatsapp")>()

  return { ...actual, sendFile: vi.fn(), sendText: vi.fn() }
})

function setup() {
  const db = new DatabaseSync(":memory:")

  const files = new Map<string, Uint8Array>()

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

    CATALOG: {
      async get(key: string) {
        const bytes = files.get(key)

        if (!bytes) return null

        return {
          async arrayBuffer() {
            return bytes.slice().buffer
          },
        }
      },
    },
  } as unknown as Env

  return { db, env, files }
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
      id,organization_id,name,model,status,authorized_for_sale,availability,
      description,specs,price_text,sale_price_text
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,

    organizationId,

    `Scooter ${id}`,

    id,

    options.status ?? "approved",

    options.authorized ?? 1,

    options.availability ?? "unknown",

    `Descrição comercial verificada ${id}`,

    JSON.stringify([{ label: "Autonomia", value: "50 km" }]),

    "R$ 10.000",

    "R$ 9.500",
  )
}

function addImage(
  db: DatabaseSync,

  productId: string,

  key: string,

  organizationId = "org",
) {
  db.prepare(
    `INSERT INTO catalog_images(
      id,organization_id,product_id,r2_key,mime,size,is_primary
    ) VALUES(?,?,?,?,?,?,1)`,
  ).run(`image-${productId}`, organizationId, productId, key, "image/png", 4)
}

function mockAcceptedMessages() {
  const textMock = vi.mocked(sendText)

  const fileMock = vi.mocked(sendFile)

  textMock.mockReset()

  fileMock.mockReset()

  textMock.mockImplementation(async () => {
    return new Response(
      JSON.stringify({ messageId: `text-${textMock.mock.calls.length}` }),

      { status: 200 },
    )
  })

  fileMock.mockImplementation(async () => {
    return new Response(
      JSON.stringify({ messageId: `image-${fileMock.mock.calls.length}` }),

      { status: 200 },
    )
  })

  return { textMock, fileMock }
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("envio integral do catálogo aprovado", () => {
  it("envia os 20 aprovados sem exigir estoque ou fotografia e inclui preço, especificações e foto disponível", async () => {
    const { db, env, files } = setup()

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

    files.set("photo-GOO-1", Uint8Array.from([1, 2, 3, 4]))

    addImage(db, "GOO-1", "photo-GOO-1")

    const { textMock, fileMock } = mockAcceptedMessages()

    const queued = await queueCatalogDelivery(env, "org", "conv", "inbound-20")

    expect(queued).toMatchObject({
      status: "ENVIANDO",

      totalAprovados: 20,

      totalSelecionados: 20,

      totalIncluidos: 20,

      totalLotes: 20,
    })

    await processPendingCatalogDeliveries(env, "org", "conv", 10)

    const sentTexts = textMock.mock.calls.map((call) => String(call[3]))

    expect(sentTexts).toHaveLength(20)

    for (const id of approvedIds)
      expect(sentTexts.join("\n")).toContain(`*${id}*`)

    expect(sentTexts.join("\n")).not.toContain("PENDENTE")

    expect(sentTexts.join("\n")).not.toContain("REPROVADO")

    expect(sentTexts.join("\n")).toContain("R$ 9.500")

    expect(sentTexts.join("\n")).toContain("Autonomia: 50 km")

    expect(fileMock).toHaveBeenCalledOnce()

    expect(fileMock.mock.calls[0]?.[3]).toMatchObject({ type: "image/png" })

    expect(String(fileMock.mock.calls[0]?.[4])).toContain("R$ 9.500")

    expect(
      db.prepare("SELECT status FROM catalog_delivery_jobs").get(),
    ).toMatchObject({ status: "completed" })

    expect(
      db.prepare("SELECT product_ids FROM catalog_delivery_batches").all(),
    ).toHaveLength(20)

    db.close()
  })

  it("envia 30 modelos em sequência, inclusive produto fora da lista histórica", async () => {
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

    const { textMock, fileMock } = mockAcceptedMessages()

    const queued = await queueCatalogDelivery(env, "org", "conv", "inbound-30")

    expect(queued).toMatchObject({
      totalAprovados: 30,

      totalSelecionados: 30,

      totalIncluidos: 30,

      totalLotes: 30,
    })

    await processPendingCatalogDeliveries(env, "org", "conv", 10)

    const sentTexts = textMock.mock.calls
      .map((call) => String(call[3]))
      .join("\n")

    for (const id of approvedIds) expect(sentTexts).toContain(`*${id}*`)

    expect(textMock).toHaveBeenCalledTimes(30)

    expect(fileMock).not.toHaveBeenCalled()

    expect(
      db.prepare("SELECT status FROM catalog_delivery_jobs").get(),
    ).toMatchObject({ status: "completed" })

    db.close()
  })

  it("retoma no terceiro produto após rejeição recuperável sem duplicar os anteriores", async () => {
    const { db, env } = setup()

    for (let index = 1; index <= 5; index++)
      addProduct(db, `RETRY-${index}`, "org")

    const textMock = vi.mocked(sendText)

    vi.mocked(sendFile).mockReset()

    textMock.mockReset()

    textMock.mockImplementation(
      async (_env, _sender, _conversation, text, options) => {
        const callNumber = textMock.mock.calls.length

        if (callNumber === 3) {
          const messageId = "failed-third-attempt"

          db.prepare(
            `INSERT INTO messages(
            id,organization_id,conversation_id,direction,type,body,status,is_ai,
            ai_reply_key,error_code
          ) VALUES(?, 'org','conv','outbound','text',?,'failed',1,?,'131000')`,
          ).run(messageId, String(text), options?.aiReplyKey)

          return new Response(
            JSON.stringify({
              messageId,
              error: "Meta recusou temporariamente o item.",
            }),

            { status: 500 },
          )
        }

        return new Response(
          JSON.stringify({ messageId: `accepted-${callNumber}` }),

          { status: 200 },
        )
      },
    )

    await queueCatalogDelivery(env, "org", "conv", "inbound-retry")

    await processPendingCatalogDeliveries(env, "org", "conv", 1)

    expect(textMock).toHaveBeenCalledTimes(3)

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

      { status: "pending" },

      { status: "pending" },
    ])

    db.exec(
      "UPDATE catalog_delivery_jobs SET next_attempt_at=datetime('now','-1 seconds')",
    )

    await processPendingCatalogDeliveries(env, "org", "conv", 10)

    expect(textMock).toHaveBeenCalledTimes(6)

    expect(
      textMock.mock.calls.map((call) => call[4]?.aiReplyKey),
    ).toEqual([
      expect.stringContaining(":batch:0:product:RETRY-1:text:0:attempt:1"),

      expect.stringContaining(":batch:1:product:RETRY-2:text:0:attempt:1"),

      expect.stringContaining(":batch:2:product:RETRY-3:text:0:attempt:1"),

      expect.stringContaining(":batch:2:product:RETRY-3:text:0:attempt:2"),

      expect.stringContaining(":batch:3:product:RETRY-4:text:0:attempt:1"),

      expect.stringContaining(":batch:4:product:RETRY-5:text:0:attempt:1"),
    ])

    expect(
      db.prepare("SELECT status FROM catalog_delivery_jobs").get(),
    ).toMatchObject({ status: "completed" })

    db.close()
  })

  it("retoma o catálogo se a saudação foi aceita antes de uma interrupção", async () => {
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

    const { textMock } = mockAcceptedMessages()

    expect(await recoverUnqueuedCatalogDeliveries(env)).toBe(1)

    await processPendingCatalogDeliveries(env, "org", "conv", 1)

    expect(textMock).toHaveBeenCalledOnce()

    expect(
      db.prepare("SELECT status FROM catalog_delivery_jobs").get(),
    ).toMatchObject({ status: "completed" })

    db.close()
  })

  it("envia manualmente por produto e não cria documentos PDF", async () => {
    const { db, env, files } = setup()

    addProduct(db, "MANUAL", "org")

    files.set("manual-photo", Uint8Array.from([5, 6, 7]))

    addImage(db, "MANUAL", "manual-photo")

    const { textMock, fileMock } = mockAcceptedMessages()

    const result = await sendCatalog(
      env,

      { userId: "user", organizationId: "org", role: "admin" } as Session,

      "conv",

      ["MANUAL"],
    )

    expect(result).toMatchObject({
      status: "ENVIADO",

      totalSelecionados: 1,

      totalIncluidos: 1,

      totalAceitos: 1,
    })

    expect(textMock).toHaveBeenCalledOnce()

    expect(String(textMock.mock.calls[0]?.[3])).toContain("Autonomia: 50 km")

    expect(fileMock).toHaveBeenCalledOnce()

    expect(fileMock.mock.calls[0]?.[3]).toMatchObject({ type: "image/png" })

    db.close()
  })
})
