import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../worker/index"
import { recoverUnqueuedInboundMessages } from "../worker/whatsapp"

function setup() {
  const db = new DatabaseSync(":memory:")
  for (const file of readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))
  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES('org','Loja','loja');
    INSERT INTO contacts(id,organization_id,phone_e164) VALUES('contact','org','15551234567');
    INSERT INTO integrations(id,organization_id,provider) VALUES('integration','org','meta_whatsapp');
    INSERT INTO conversations(id,organization_id,contact_id,integration_id) VALUES('conv','org','contact','integration');
    INSERT INTO leads(id,organization_id,contact_id) VALUES('lead','org','contact');
  `)

  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = []
        return {
          bind(...values: unknown[]) {
            args = values
            return this
          },
          async run() {
            const result = db.prepare(sql).run(...(args as never[]))
            return { meta: { changes: Number(result.changes) } }
          },
        }
      },
    },
  } as unknown as Env

  return { db, env }
}

function inbound(
  db: DatabaseSync,
  externalId: string,
  options: {
    type?: string
    contentAvailable?: number
    origin?: string
    age?: string
  } = {},
) {
  db.prepare(
    `INSERT INTO messages(
      id,organization_id,conversation_id,external_id,direction,type,body,status,
      external_created_at,content_available,origin,created_at
    ) VALUES(?, 'org','conv',?,'inbound',?,'mensagem recebida','received',
      datetime('now',?),?,?,datetime('now',?))`,
  ).run(
    `message-${externalId}`,
    externalId,
    options.type ?? "text",
    options.age ?? "0 seconds",
    options.contentAvailable ?? 1,
    options.origin ?? "customer",
    options.age ?? "0 seconds",
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("recuperação de mensagens sem job da IA", () => {
  it("cria um job idempotente para mensagem real persistida sem resposta", async () => {
    const { db, env } = setup()
    inbound(db, "orphan-text")

    expect(await recoverUnqueuedInboundMessages(env)).toBe(1)
    expect(await recoverUnqueuedInboundMessages(env)).toBe(0)
    expect(
      db
        .prepare(
          "SELECT status,attempts FROM whatsapp_processing_jobs WHERE inbound_external_id='orphan-text'",
        )
        .get(),
    ).toMatchObject({ status: "pending", attempts: 0 })
    db.close()
  })

  it("não reprocessa conteúdo indisponível, histórico, expirado ou já respondido", async () => {
    const { db, env } = setup()
    inbound(db, "unsupported", {
      type: "unsupported",
      contentAvailable: 0,
    })
    inbound(db, "history", { origin: "history" })
    inbound(db, "expired", { age: "-25 hours" })
    inbound(db, "answered")
    db.prepare(
      `INSERT INTO messages(
        id,organization_id,conversation_id,direction,type,body,status,is_ai,
        ai_reply_key,created_at
      ) VALUES('ai-reply','org','conv','outbound','text','Resposta','accepted',1,
        'ai:answered:text:0',datetime('now'))`,
    ).run()

    expect(await recoverUnqueuedInboundMessages(env)).toBe(0)
    expect(
      db
        .prepare("SELECT COUNT(*) count FROM whatsapp_processing_jobs")
        .get(),
    ).toMatchObject({ count: 0 })
    db.close()
  })
})
