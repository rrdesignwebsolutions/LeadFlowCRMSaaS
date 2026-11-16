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
          if (sql.includes("FROM integrations")) return { id: "integration", organization_id: "org" }
          return null
        },
        async run() {
          statements.push({ sql, args: this.args })
          return { meta: { changes: 1 } }
        },
      }
    },
    async batch(batch: Array<{ sql: string; args: unknown[] }>) {
      statements.push(...batch)
      return []
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
    expect(statements.find((s) => s.sql.includes("unread_count=unread_count+?"))?.args[1]).toBe(0)
    expect(after).not.toHaveBeenCalled()
  })

  it("records unsupported history events as failed rather than claiming synchronization succeeded", async () => {
    const { env, statements } = database()
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await handleMetaPayload(env, {
        object: "whatsapp_business_account",
        entry: [{ id: "12345", changes: [{ field: "history", value: { metadata: { phone_number_id: "98765" } } }] }],
      }, "hash")
      expect(statements.some((s) => s.sql.includes("status='failed'"))).toBe(true)
      expect(statements.some((s) => s.sql.includes("status='processed'"))).toBe(false)
    } finally {
      log.mockRestore()
    }
  })
})
