import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
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
    INSERT INTO messages(id,organization_id,conversation_id,external_id,direction,type,body,status,external_created_at,content_available)
      VALUES('message','org','conv','wamid','inbound','text','Olá','received',strftime('%Y-%m-%dT%H:%M:%fZ','now'),1);
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
  const env = {
    DB: adapter,
    APP_ORIGIN: "https://example.test",
  } as unknown as Env
  const call = (path: string, method: string, role: Session["role"] = "admin", organizationId = "org") => {
    const url = new URL(`https://example.com${path}`)
    return whatsappRoutes(new Request(url, { method }), env, url, { userId: "user", organizationId, role })
  }
  return { db, env, call }
}

describe("ações da caixa de entrada", () => {
  it("grava mensagem indisponível e código da Meta no banco", async () => {
    const { db, env, call } = setup()
    const after = vi.fn()
    db.exec("UPDATE contacts SET phone_e164='+15551234567' WHERE id='contact'")
    db.exec("DELETE FROM messages")
    await handleMetaPayload(env, {
      object: "whatsapp_business_account",
      entry: [{ id: "12345", changes: [{ field: "messages", value: {
        metadata: { phone_number_id: "98765" },
        messages: [{ id: "wamid.indisponivel", from: "15551234567", type: "unsupported",
          errors: [{ code: 131060 }], timestamp: String(Math.floor(Date.now() / 1000)) }],
      } }] }],
    }, "unsupported-hash", after)
    expect(db.prepare("SELECT body,error_code,type,direction,status FROM messages WHERE external_id=?").get("wamid.indisponivel")).toMatchObject({
      body: "[A Meta não compartilhou o conteúdo desta mensagem com o AV Flow. Abra o WhatsApp Business para lê-la; a Meta não enviará esse conteúdo novamente.]", error_code: "131060",
      type: "unsupported", direction: "inbound", status: "received",
    })
    expect(db.prepare("SELECT unread_count FROM conversations WHERE id='conv'").get()).toMatchObject({ unread_count: 1 })
    expect(await (await call("/api/conversations/conv/messages", "GET"))?.json()).toMatchObject({
      windowOpen: true,
    })
    expect(after).toHaveBeenCalledOnce()
    expect(
      db
        .prepare("SELECT inbound_external_id FROM whatsapp_processing_jobs")
        .get(),
    ).toMatchObject({ inbound_external_id: "wamid.indisponivel" })
    db.exec("UPDATE messages SET body='[Mensagem não suportada]' WHERE external_id='wamid.indisponivel'")
    const list = await call("/api/conversations", "GET")
    expect(await list?.json()).toMatchObject({
      results: [
        {
          preview: "[Mensagem não suportada]",
          previewType: "unsupported",
          aiState: "IA_ATIVA",
        },
      ],
    })
    db.close()
  })

  it("retorna o diagnóstico da integração sem colisão no nome da tabela messages", async () => {
    const { db, call } = setup()

    const response = await call("/api/integrations/whatsapp", "GET")

    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({
      diagnostics: {
        unavailableMessages24h: 0,
        adReferralMessages24h: 0,
        failedSends24h: 0,
      },
    })
    db.close()
  })

  it("expõe quando a IA está pausada na lista de conversas", async () => {
    const { db, call } = setup()
    db.exec("UPDATE conversations SET ai_state='HUMANO' WHERE id='conv'")

    const response = await call("/api/conversations", "GET")

    expect(await response?.json()).toMatchObject({
      results: [{ aiState: "HUMANO" }],
    })
    db.close()
  })

  it("ordena as conversas pela mensagem mais recente, mesmo se outra aguarda vendedor", async () => {
    const { db, call } = setup()
    db.exec(`
      INSERT INTO contacts(id,organization_id,phone_e164) VALUES('new-contact','org','15559876543');
      INSERT INTO conversations(id,organization_id,contact_id,integration_id,last_message_at)
        VALUES('new-conv','org','new-contact','integration','2026-11-18T15:00:00.000Z');
      UPDATE conversations
        SET last_message_at='2026-11-18T14:00:00.000Z',human_requested_at='2026-11-18T14:00:00.000Z'
        WHERE id='conv';
    `)

    const response = await call("/api/conversations", "GET")

    expect(await response?.json()).toMatchObject({
      results: [{ id: "new-conv" }, { id: "conv", humanRequestedAt: "2026-11-18T14:00:00.000Z" }],
    })
    db.close()
  })

  it("aplica edições e exclusões do cliente na mensagem original", async () => {
    const { db, env } = setup()

    await handleMetaPayload(
      env,
      {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "98765" },
                  messages: [
                    {
                      id: "wamid.edit-event",
                      from: "15551234567",
                      type: "edit",
                      edit: {
                        original_message_id: "wamid",
                        message: {
                          type: "text",
                          text: { body: "Texto editado" },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "customer-edit-hash",
    )
    expect(
      db
        .prepare("SELECT body,direction,content_available FROM messages WHERE external_id='wamid'")
        .get(),
    ).toMatchObject({
      body: "Texto editado",
      direction: "inbound",
      content_available: 1,
    })
    expect(db.prepare("SELECT count(*) n FROM messages").get()).toMatchObject({
      n: 1,
    })

    await handleMetaPayload(
      env,
      {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "98765" },
                  messages: [
                    {
                      id: "wamid.revoke-event",
                      from: "15551234567",
                      type: "revoke",
                      revoke: { original_message_id: "wamid" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "customer-revoke-hash",
    )
    expect(
      db
        .prepare("SELECT body,content_available FROM messages WHERE external_id='wamid'")
        .get(),
    ).toMatchObject({
      body: "[Mensagem apagada no WhatsApp Business.]",
      content_available: 0,
    })
    db.close()
  })

  it("persists WhatsApp Business App contact sync, including phone-less BSUIDs", async () => {
    const { db, env } = setup()

    await handleMetaPayload(
      env,
      {
        object: "whatsapp_business_account",
        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "smb_app_state_sync",
                value: {
                  state_sync: [
                    {
                      type: "contact",
                      action: "add",
                      contact: {
                        user_id: "US.123456789",
                        phone_number: "15551234567",
                        full_name: "Contato",
                      },
                    },
                    {
                      type: "contact",
                      action: "add",
                      contact: { user_id: "US.987654321", username: "cliente" },
                    },
                    {
                      type: "contact",
                      action: "remove",
                      contact: { user_id: "US.123456789" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "app-contact-sync-hash",
    )

    expect(
      db
        .prepare(
          "SELECT user_id,phone_e164,is_removed FROM whatsapp_business_app_contacts ORDER BY user_id",
        )
        .all(),
    ).toEqual([
      {
        user_id: "US.123456789",
        phone_e164: "+15551234567",
        is_removed: 1,
      },
      { user_id: "US.987654321", phone_e164: null, is_removed: 0 },
    ])
    expect(
      db
        .prepare("SELECT event_type,status FROM webhook_events")
        .get(),
    ).toMatchObject({
      event_type: "smb_app_state_sync",
      status: "processed",
    })
    db.close()
  })

  it("remove somente o aviso de solicitação humana, preservando atribuição e pausa da IA", async () => {
    const { db, call } = setup()
    db.exec(`UPDATE conversations SET human_requested_at=CURRENT_TIMESTAMP,assigned_to='user',assignment_revision=3;
      UPDATE leads SET ai_handoff_at=CURRENT_TIMESTAMP,next_action='Cliente quer falar com o vendedor';`)
    expect((await call("/api/conversations/conv/human-request", "DELETE", "agent"))?.status).toBe(200)
    expect(db.prepare("SELECT human_requested_at,assigned_to,assignment_revision FROM conversations").get()).toMatchObject({
      human_requested_at: null, assigned_to: "user", assignment_revision: 3,
    })
    expect(db.prepare("SELECT ai_handoff_at,next_action FROM leads").get()).toMatchObject({
      ai_handoff_at: expect.any(String), next_action: "Cliente quer falar com o vendedor",
    })
    expect((await call("/api/conversations/conv/human-request", "DELETE", "agent", "other"))?.status).toBe(404)
    expect((await call("/api/conversations/conv/human-request", "DELETE", "agent"))?.status).toBe(200)
    db.close()
  })

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
