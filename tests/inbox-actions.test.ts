import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Env, Session } from "../worker/index"
import { handleMetaPayload, whatsappRoutes } from "../worker/whatsapp"

function setup() {
  const db = new DatabaseSync(":memory:")
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))
  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES('org','Loja','loja');
    INSERT INTO users(id,email,name,password_hash,password_salt) VALUES('user','user@example.test','Usuário','hash','salt');
    INSERT INTO contacts(id,organization_id,phone_e164) VALUES('contact','org','15551234567');
    INSERT INTO integrations(id,organization_id,provider,status,phone_number_id,external_account_id) VALUES('integration','org','meta_whatsapp','connected','98765','12345');
    INSERT INTO conversations(id,organization_id,contact_id,integration_id) VALUES('conv','org','contact','integration');
    INSERT INTO leads(id,organization_id,contact_id) VALUES('lead','org','contact');
    INSERT INTO messages(id,organization_id,conversation_id,external_id,direction,type,body,status,external_created_at)
      VALUES('message','org','conv','wamid','inbound','text','Olá','received',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
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
    async batch(items: Array<{ run: () => Promise<unknown> }>) {
      const results = []
      for (const item of items) results.push(await item.run())
      return results
    },
  }
  const env = { DB: adapter } as unknown as Env
  const call = (path: string, method: string, role: Session["role"] = "admin", organizationId = "org") => {
    const url = new URL(`https://example.com${path}`)
    return whatsappRoutes(new Request(url, { method }), env, url, { userId: "user", organizationId, role })
  }
  return { db, env, call }
}

describe("ações da caixa de entrada", () => {
  it("permite marcar como não lida para toda a equipe sem reduzir contagem existente", async () => {
    const { db, call } = setup()
    expect((await call("/api/conversations/conv/unread", "POST", "agent"))?.status).toBe(200)
    expect(db.prepare("SELECT unread_count FROM conversations").get()).toMatchObject({ unread_count: 1 })
    db.exec("UPDATE conversations SET unread_count=5")
    await call("/api/conversations/conv/unread", "POST", "agent")
    expect(db.prepare("SELECT unread_count FROM conversations").get()).toMatchObject({ unread_count: 5 })
    db.close()
  })

  it("restringe exclusões a administradores e isola organizações", async () => {
    const { db, call } = setup()
    expect((await call("/api/messages/message", "DELETE", "agent"))?.status).toBe(403)
    expect((await call("/api/conversations/conv", "DELETE", "manager"))?.status).toBe(403)
    expect((await call("/api/messages/message", "DELETE", "admin", "other"))?.status).toBe(404)
    expect(db.prepare("SELECT count(*) n FROM messages").get()).toMatchObject({ n: 1 })
    db.close()
  })

  it("remove mensagem, preserva a janela de atendimento e impede reimportação", async () => {
    const { db, env, call } = setup()
    expect((await call("/api/messages/message", "DELETE"))?.status).toBe(200)
    expect(db.prepare("SELECT count(*) n FROM messages").get()).toMatchObject({ n: 0 })
    const thread = await call("/api/conversations/conv/messages", "GET")
    expect(await thread?.json()).toMatchObject({ messages: [], windowOpen: true })
    await handleMetaPayload(env, {
      object: "whatsapp_business_account",
      entry: [{ id: "12345", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "98765" },
        messages: [{ id: "wamid", from: "15551234567", type: "text", text: { body: "Olá" }, timestamp: "1700000000" }],
      } }] }],
    }, "hash")
    expect(db.prepare("SELECT count(*) n FROM messages").get()).toMatchObject({ n: 0 })
    db.close()
  })

  it("exclui conversa e histórico sem excluir o lead", async () => {
    const { db, call } = setup()
    expect((await call("/api/conversations/conv", "DELETE"))?.status).toBe(200)
    expect(db.prepare("SELECT count(*) n FROM conversations").get()).toMatchObject({ n: 0 })
    expect(db.prepare("SELECT count(*) n FROM messages").get()).toMatchObject({ n: 0 })
    expect(db.prepare("SELECT count(*) n FROM leads").get()).toMatchObject({ n: 1 })
    expect(db.prepare("SELECT conversation_id FROM deleted_whatsapp_messages").get()).toMatchObject({ conversation_id: null })
    db.close()
  })

  it("impede exclusão durante envio", async () => {
    const { db, call } = setup()
    db.exec("UPDATE messages SET status='queued'")
    expect((await call("/api/messages/message", "DELETE"))?.status).toBe(409)
    expect((await call("/api/conversations/conv", "DELETE"))?.status).toBe(409)
    db.close()
  })
})
