import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env, Session } from "../worker/index"
import { whatsappRoutes } from "../worker/whatsapp"

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
