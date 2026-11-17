import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env, Session } from "../worker/index"
import { decryptToken, whatsappRoutes } from "../worker/whatsapp"

const auth: Session = { userId: "user", organizationId: "org", role: "admin" }
const url = new URL("https://example.test/api/integrations/whatsapp/embedded-signup")

function setup(numbers: unknown, subscriptionSuccess = true) {
  const statements: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      const statement = {
        args: [] as unknown[],
        bind(...args: unknown[]) {
          this.args = args
          return this
        },
        async first() {
          if (sql.includes("FROM whatsapp_pending_signups")) {
            const pending = statements.find((s) => s.sql.includes("INSERT INTO whatsapp_pending_signups"))
            if (pending && this.args[0] === pending.args[0] && this.args[1] === pending.args[1] && this.args[2] === pending.args[2])
              return { waba_id: pending.args[3], access_token_enc: pending.args[4] }
          }
          return null
        },
        async run() {
          statements.push({ sql, args: this.args })
          return { meta: { changes: 1 } }
        },
      }
      return statement
    },
  }
  const env = {
    DB: db,
    APP_ORIGIN: "https://example.test",
    META_APP_ID: "12345",
    META_APP_SECRET: "secret",
    META_CONFIG_ID: "12345",
    ENCRYPTION_KEY: btoa("01234567890123456789012345678901"),
    GRAPH_API_BASE: "https://graph.example.test",
  } as unknown as Env
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const path = String(input)
    if (path.includes("/oauth/access_token"))
      return Response.json({ access_token: "access_token_123456789012345" })
    if (path.includes("/phone_numbers?"))
      return Response.json(numbers)
    if (path.includes("/subscribed_apps"))
      return Response.json(subscriptionSuccess ? { success: true } : { error: { message: "subscription failed" } }, { status: subscriptionSuccess ? 200 : 400 })
    return Response.json({ display_phone_number: "+15551234567", verified_name: "Store" })
  })
  vi.stubGlobal("fetch", fetchMock)
  return { env, statements, fetchMock }
}

async function submit(env: Env, body: object) {
  return whatsappRoutes(
    new Request(url, { method: "POST", body: JSON.stringify(body) }),
    env,
    url,
    auth,
  )
}

afterEach(() => vi.unstubAllGlobals())

describe("WhatsApp Embedded Signup", () => {
  it("uses the existing configuration and resolves the sole coexistence number", async () => {
    const { env, statements, fetchMock } = setup({ data: [{ id: "98765" }] })
    const response = await submit(env, { code: "authorization-code", wabaId: "12345", connectionMode: "coexistence" })
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({ ok: true, subscribed: true })
    expect(statements.find((s) => s.sql.includes("INSERT INTO integrations"))?.args).toContain("coexistence")
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/12345/subscribed_apps"))).toBe(true)
  })

  it("preserves the Cloud API flow without looking up coexistence numbers", async () => {
    const { env, fetchMock } = setup({ data: [] })
    const response = await submit(env, { code: "authorization-code", wabaId: "12345", phoneNumberId: "98765" })
    expect(response?.status).toBe(200)
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/phone_numbers?"))).toBe(false)
  })

  it("does not choose a number when the account is ambiguous or paginated", async () => {
    const { env, statements } = setup({ data: [{ id: "98765" }], paging: { next: "next" } })
    const response = await submit(env, { code: "authorization-code", wabaId: "12345", connectionMode: "coexistence" })
    expect(response?.status).toBe(400)
    expect(statements.some((s) => s.sql.includes("INSERT INTO integrations"))).toBe(false)
  })

  it("requests a choice for multiple numbers and stores the token encrypted", async () => {
    const { env, statements } = setup({ data: [
      { id: "98765", display_phone_number: "+15551111111" },
      { id: "98766", display_phone_number: "+15552222222" },
    ] })
    const response = await submit(env, { code: "authorization-code", wabaId: "12345", connectionMode: "coexistence" })
    const result = await response?.json() as { selectionRequired: boolean; pendingId: string; phoneNumbers: Array<{ id: string }> }
    expect(result.selectionRequired).toBe(true)
    expect(result.phoneNumbers.map((number) => number.id)).toEqual(["98765", "98766"])
    const pending = statements.find((s) => s.sql.includes("INSERT INTO whatsapp_pending_signups"))
    expect(pending?.args.slice(0, 4)).toEqual([result.pendingId, "org", "user", "12345"])
    expect(pending?.args[4]).not.toBe("access_token_123456789012345")
    expect(await decryptToken(env, String(pending?.args[4]))).toBe("access_token_123456789012345")
    expect(JSON.stringify(result)).not.toContain("access_token_123456789012345")
  })

  it("rejects selecting a number from a pending signup of another session", async () => {
    const { env } = setup({ data: [{ id: "98765" }, { id: "98766" }] })
    const signup = await submit(env, { code: "authorization-code", wabaId: "12345", connectionMode: "coexistence" })
    const pending = await signup?.json() as { pendingId: string }
    const selectionUrl = new URL(`${url}/select-number`)
    const response = await whatsappRoutes(
      new Request(selectionUrl, { method: "POST", body: JSON.stringify({ pendingId: pending.pendingId, phoneNumberId: "98765" }) }),
      env, selectionUrl, { userId: "other", organizationId: "other-org", role: "admin" },
    )
    expect(response?.status).toBe(404)
  })

  it("completes selection only for a number in the authorized WABA", async () => {
    const { env, statements } = setup({ data: [{ id: "98765" }, { id: "98766" }] })
    const signup = await submit(env, { code: "authorization-code", wabaId: "12345", connectionMode: "coexistence" })
    const pending = await signup?.json() as { pendingId: string }
    const selectionUrl = new URL(`${url}/select-number`)
    const request = (phoneNumberId: string) => new Request(selectionUrl, {
      method: "POST", body: JSON.stringify({ pendingId: pending.pendingId, phoneNumberId }),
    })
    const rejected = await whatsappRoutes(request("55555"), env, selectionUrl, auth)
    expect(rejected?.status).toBe(400)
    const accepted = await whatsappRoutes(request("98766"), env, selectionUrl, auth)
    expect(accepted?.status).toBe(200)
    expect(statements.find((s) => s.sql.includes("INSERT INTO integrations"))?.args).toContain("98766")
    expect(statements.some((s) => s.sql.startsWith("DELETE FROM whatsapp_pending_signups WHERE id="))).toBe(true)
  })

  it("rejects a number not belonging to the supplied account", async () => {
    const { env, statements } = setup({ data: [{ id: "98765" }] })
    const response = await submit(env, { code: "authorization-code", wabaId: "12345", phoneNumberId: "55555", connectionMode: "coexistence" })
    expect(response?.status).toBe(400)
    expect(statements.some((s) => s.sql.includes("INSERT INTO integrations"))).toBe(false)
  })

  it("marks the integration as error when webhook subscription fails", async () => {
    const { env, statements } = setup({ data: [{ id: "98765" }] }, false)
    const response = await submit(env, { code: "authorization-code", wabaId: "12345", connectionMode: "coexistence" })
    expect(await response?.json()).toMatchObject({ subscribed: false })
    expect(statements.some((s) => s.sql.includes("status='error'") && s.sql.includes("webhook_subscription"))).toBe(true)
  })
})
