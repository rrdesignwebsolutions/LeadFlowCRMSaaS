import { describe, expect, it, vi } from "vitest"
import type { Env } from "../worker/index"
import { handleMetaPayload } from "../worker/whatsapp"

function database() {
  const statements: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        sql,
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args
          return this
        },
        async first() {
          if (sql.includes("FROM integrations")) return { id: "integration", organization_id: "org", display_phone_number: "+15550000000" }
          if (sql.includes("FROM webhook_events")) return { id: "event" }
          return null
        },
        async all() {
          return { results: [{ id: "integration", organization_id: "org" }] }
        },
        async run() {
          statements.push({ sql, args: this.args })
          return { meta: { changes: 1 } }
        },
      }
    },
    async batch(batch: Array<{ sql: string; args: unknown[] }>) {
      statements.push(...batch)
      return batch.map(() => ({ meta: { changes: 1 } }))
    },
  }
  return { env: { DB: db } as unknown as Env, statements }
}

describe("WhatsApp coexistence webhooks", () => {
  it("stores an app message as outbound without marking it unread or scheduling AI", async () => {
    const { env, statements } = database()
    const after = vi.fn()
    await handleMetaPayload(env, {
      object: "whatsapp_business_account",
      entry: [{ id: "12345", changes: [{ field: "smb_message_echoes", value: {
        metadata: { phone_number_id: "98765" },
        message_echoes: [{ id: "wamid.1", to: "15551234567", type: "text", text: { body: "Olá" }, timestamp: "1700000000" }],
      } }] }],
    }, "hash", after)
    const message = statements.find((s) => s.sql.includes("INSERT OR IGNORE INTO messages"))
    expect(message?.args).toContain("outbound")
    expect(message?.args).toContain("Olá")
    expect(statements.find((s) => s.sql.includes("unread_count=unread_count+?"))?.args[2]).toBe(0)
    expect(after).not.toHaveBeenCalled()
  })

  it("imports historical messages without marking them unread and records sync progress", async () => {
    const { env, statements } = database()
    await handleMetaPayload(env, {
      object: "whatsapp_business_account",
      entry: [{
        id: "12345",
        changes: [{
          field: "history",
          value: {
            metadata: { phone_number_id: "98765" },
            history: [{
              metadata: { phase: 0, chunk_order: 0, progress: 100 },
              threads: [{
                id: "15551234567",
                context: { wa_id: "15551234567" },
                messages: [
                  { id: "wamid.inbound", from: "15551234567", type: "text", text: { body: "Mensagem antiga" }, timestamp: "1700000000" },
                  { id: "wamid.outbound", from: "15550000000", type: "text", text: { body: "Resposta antiga" }, timestamp: "1700000001" },
                ],
              }],
            }],
          },
        }],
      }],
    }, "history-hash")

    const messages = statements.filter((s) => s.sql.includes("INSERT OR IGNORE INTO messages"))
    expect(messages.map((message) => message.args[4])).toEqual(["inbound", "outbound"])
    expect(messages.map((message) => message.args[6])).toEqual(["Mensagem antiga", "Resposta antiga"])
    expect(statements.filter((s) => s.sql.includes("unread_count=unread_count+?")).map((s) => s.args[2])).toEqual([0, 0])
    expect(statements.some((s) => s.sql.includes("history_sync_status=CASE WHEN ?=100 THEN 'completed'"))).toBe(true)
    expect(statements.some((s) => s.sql.includes("UPDATE webhook_events SET status='failed'"))).toBe(false)
  })

  it("marks the sync declined when the WhatsApp Business App denied history sharing", async () => {
    const { env, statements } = database()
    await handleMetaPayload(env, {
      object: "whatsapp_business_account",
      entry: [{
        id: "12345",
        changes: [{
          field: "history",
          value: {
            metadata: { phone_number_id: "98765" },
            errors: [{ code: 2593109 }],
          },
        }],
      }],
    }, "declined-hash")

    expect(statements.some((s) => s.sql.includes("history_sync_status='declined'"))).toBe(true)
  })

  it("applies account updates to all integrations sharing a WABA", async () => {
    const { env, statements } = database()
    const originalPrepare = env.DB.prepare.bind(env.DB)
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql)
      if (sql.includes("external_account_id=?")) {
        statement.all = async () => ({
          results: [
            { id: "integration", organization_id: "org" },
            { id: "integration-2", organization_id: "org-2" },
          ],
        }) as never
      }
      return statement
    })
    await handleMetaPayload(env, {
      object: "whatsapp_business_account",
      entry: [{ id: "12345", changes: [{ field: "account_update", value: { event: "ACCOUNT_RESTRICTION" } }] }],
    }, "hash")
    const updates = statements.filter((s) => s.sql.includes("UPDATE integrations") && s.sql.includes("status='error'"))
    expect(updates).toHaveLength(2)
    expect(updates.map((s) => s.args.slice(-2))).toEqual([["integration", "org"], ["integration-2", "org-2"]])
  })
})
