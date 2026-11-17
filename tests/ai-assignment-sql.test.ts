import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../worker/index"
import { autoReply } from "../worker/ai"
import { sendText } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", () => ({
  sendText: vi.fn(async () => new Response(null, { status: 200 })),
}))
vi.mock("../worker/catalog", () => ({
  catalogEnabled: vi.fn(async () => false), catalogTools: [], runCatalogTool: vi.fn(),
}))
vi.mock("../worker/verification", () => ({
  escapeHtml: (text: string) => text, sendNotificationEmail: vi.fn(),
}))

function setup() {
  const db = new DatabaseSync(":memory:")
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))
  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES('org','Loja','loja');
    INSERT INTO users(id,email,name,password_hash,password_salt) VALUES('agent','agent@example.test','Agente','hash','salt');
    INSERT INTO contacts(id,organization_id,phone_e164) VALUES('contact','org','15551234567');
    INSERT INTO integrations(id,organization_id,provider) VALUES('integration','org','meta_whatsapp');
    INSERT INTO conversations(id,organization_id,contact_id,integration_id) VALUES('conv','org','contact','integration');
    INSERT INTO leads(id,organization_id,contact_id) VALUES('lead','org','contact');
    INSERT INTO ai_settings(organization_id,enabled) VALUES('org',1);
    INSERT INTO messages(id,organization_id,conversation_id,external_id,direction,type,body,status,external_created_at)
      VALUES('in','org','conv','wamid','inbound','text','Olá','received',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  `)
  const adapter = {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...values: unknown[]) { args = values; return this },
        async first() { return db.prepare(sql).get(...args as never[]) ?? null },
        async all() { return { results: db.prepare(sql).all(...args as never[]) } },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } } },
      }
    },
  }
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      reply: "Olá!", handoff: false, offerSalesperson: false,
      lead: { status: "in_service", score: 35, summary: null, productInterest: null,
        mainInterest: null, budgetRange: null, paymentMethod: null, purchaseTimeline: null, paymentViability: "unknown" },
    }) }] }],
  }))))
  return { db, env: { DB: adapter, OPENAI_API_KEY: "test" } as unknown as Env }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("atribuição com SQL real", () => {
  it("mantém a IA pausada enquanto uma pessoa estiver responsável", async () => {
    const { db, env } = setup()
    db.exec("UPDATE conversations SET assigned_to='agent' WHERE id='conv'")
    await autoReply(env, "org", "conv", "wamid")
    expect(sendText).not.toHaveBeenCalled()
    expect(db.prepare("SELECT ai_reply_lock FROM conversations WHERE id='conv'").get()).toMatchObject({ ai_reply_lock: null })
    db.close()
  })

  it("retoma após mensagem humana anterior quando o atendimento volta para a IA", async () => {
    const { db, env } = setup()
    db.exec(`
      INSERT INTO messages(id,organization_id,conversation_id,direction,type,body,status,is_ai,created_at)
        VALUES('human','org','conv','outbound','text','Resposta','sent',0,datetime('now','-1 minute'));
      UPDATE conversations SET ai_resumed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),assignment_revision=1 WHERE id='conv';
    `)
    expect(await autoReply(env, "org", "conv", "wamid")).toBe(true)
    expect(sendText).toHaveBeenCalledOnce()
    expect(db.prepare("SELECT ai_reply_lock FROM conversations WHERE id='conv'").get()).toMatchObject({ ai_reply_lock: null })
    db.close()
  })
})
