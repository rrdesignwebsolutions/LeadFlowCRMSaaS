import { DatabaseSync } from "node:sqlite"

import { readdirSync, readFileSync } from "node:fs"

import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env, Session } from "../worker/index"

import worker from "../worker/index"

import {
  claimPublicCheckout,
  confirmPublicCheckout,
  createPublicCheckout,
  publicCheckoutStatus,
} from "../worker/billing"

import { supportRoutes } from "../worker/support"

function setup() {
  const db = new DatabaseSync(":memory:")

  for (const file of readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))

  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES('org','Empresa','empresa'),('other','Outra','outra');
    INSERT INTO users(id,email,name,password_hash,password_salt)
      VALUES('user','user@example.test','Usuário','hash','salt');
    INSERT INTO organization_members(organization_id,user_id,role)
      VALUES('org','user','admin');
    INSERT INTO subscriptions(id,organization_id,status,plan,period_ends_at)
      VALUES('subscription','org','trialing','starter',datetime('now','+7 days'));
  `)

  const dbApi = {
    prepare(sql: string) {
      let args: unknown[] = []

      return {
        bind(...values: unknown[]) {
          args = values

          return this
        },

        async first() {
          return db.prepare(sql).get(...args as never[]) ?? null
        },

        async run() {
          const result = db.prepare(sql).run(...args as never[])

          return { meta: { changes: Number(result.changes) } }
        },
      }
    },

    async batch(
      statements: Array<{ run(): Promise<{ meta: { changes: number } }> }>,
    ) {
      db.exec("BEGIN")

      try {
        const results = []

        for (const statement of statements) results.push(await statement.run())

        db.exec("COMMIT")

        return results
      } catch (error) {
        db.exec("ROLLBACK")

        throw error
      }
    },
  }

  const env = {
    DB: dbApi,

    APP_ORIGIN: "https://avflowcrm.com.br",

    INFINITEPAY_API_KEY: "test-key",

    INFINITEPAY_HANDLE: "test-handle",

    SUPPORT_EMAIL: "support@example.test",

    RESEND_API_KEY: "test-resend-key",

    EMAIL_FROM: "AV Flow <noreply@example.test>",
  } as unknown as Env

  const request = (path: string, method: string, body?: unknown) =>
    new Request(`https://avflowcrm.com.br${path}`, {
      method,

      ...(body !== undefined
        ? {
            body: JSON.stringify(body),

            headers: { "content-type": "application/json" },
          }
        : {}),
    })

  return { db, env, request }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("checkout público", () => {
  it("cria um pedido pendente e usa o link de checkout retornado pela InfinitePay", async () => {
    const { db, env } = setup()

    vi.stubGlobal(
      "fetch",

      vi.fn(async () =>
        Response.json({ url: "https://checkout.infinitepay.io/link/test" }),
      ),
    )

    const checkout = await createPublicCheckout(env, "essencial", "monthly")

    expect(checkout?.checkoutUrl).toBe(
      "https://checkout.infinitepay.io/link/test",
    )

    expect(await publicCheckoutStatus(env, checkout!.orderNsu)).toEqual({
      status: "pending",

      plan: "essencial",
    })

    expect(
      db
        .prepare("SELECT amount_cents,period_days FROM public_checkout_orders")
        .get(),
    ).toEqual({ amount_cents: 11900, period_days: 30 })

    db.close()
  })

  it("confirma somente pagamentos verificados no valor esperado", async () => {
    const { db, env } = setup()

    vi.stubGlobal(
      "fetch",

      vi
        .fn()

        .mockResolvedValueOnce(
          Response.json({ url: "https://checkout.infinitepay.io/link/test" }),
        )

        .mockResolvedValueOnce(
          Response.json({ paid: true, paid_amount: 11899 }),
        )

        .mockResolvedValueOnce(
          Response.json({ paid: true, paid_amount: 11900 }),
        ),
    )

    const checkout = await createPublicCheckout(env, "essencial")

    await expect(
      confirmPublicCheckout(env, { orderNsu: checkout!.orderNsu }),
    ).resolves.toBe("ignored")

    expect(await publicCheckoutStatus(env, checkout!.orderNsu)).toMatchObject({
      status: "pending",
    })

    await expect(
      confirmPublicCheckout(env, { orderNsu: checkout!.orderNsu }),
    ).resolves.toBe("activated")

    expect(await publicCheckoutStatus(env, checkout!.orderNsu)).toMatchObject({
      status: "paid",
    })

    db.close()
  })

  it("vincula o plano à empresa de forma idempotente", async () => {
    const { db, env } = setup()

    db.prepare(
      `INSERT INTO public_checkout_orders(order_nsu,plan,amount_cents,period_days,status)
       VALUES('public_test','pro',14900,30,'paid'),
             ('public_without_subscription','scale',24900,365,'paid')`,
    ).run()

    await expect(claimPublicCheckout(env, "public_test", "org")).resolves.toBe(
      true,
    )

    await expect(claimPublicCheckout(env, "public_test", "org")).resolves.toBe(
      true,
    )

    expect(
      db
        .prepare(
          "SELECT plan,status FROM subscriptions WHERE organization_id='org'",
        )
        .get(),
    )

      .toMatchObject({ plan: "pro", status: "active" })

    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM billing_orders WHERE order_nsu='public_test'",
        )
        .get(),
    )

      .toMatchObject({ count: 1 })

    expect(await publicCheckoutStatus(env, "public_test")).toMatchObject({
      status: "claimed",

      plan: "pro",
    })

    await expect(
      claimPublicCheckout(env, "public_without_subscription", "other"),
    ).resolves.toBe(true)

    expect(
      db
        .prepare(
          "SELECT plan,status FROM subscriptions WHERE organization_id='other'",
        )
        .get(),
    ).toMatchObject({ plan: "scale", status: "active" })

    db.close()
  })
})

describe("cadastro após pagamento", () => {
  it("bloqueia cadastros não pagos e cria uma empresa com o plano já ativado após pagamento", async () => {
    const { db, env, request } = setup()

    delete env.RESEND_API_KEY

    delete env.EMAIL_FROM

    const ctx = { waitUntil() {} } as ExecutionContext

    const body = {
      company: "Nova Empresa",

      name: "Nova Pessoa",

      email: "nova@example.test",

      password: "senha-com-mais-de-12",

      order_nsu: "public_not_paid",
    }

    const blocked = await worker.fetch(
      request("/api/auth/register", "POST", body),
      env,
      ctx,
    )

    expect(blocked.status).toBe(402)

    expect(db.prepare("SELECT COUNT(*) count FROM users").get()).toMatchObject({
      count: 1,
    })

    db.prepare(
      `INSERT INTO public_checkout_orders(order_nsu,plan,amount_cents,period_days,status)
       VALUES('public_paid','scale',24900,30,'paid')`,
    ).run()

    const registered = await worker.fetch(
      request("/api/auth/register", "POST", {
        ...body,
        order_nsu: "public_paid",
      }),

      env,

      ctx,
    )

    expect(registered.status).toBe(201)

    expect(
      db
        .prepare(
          "SELECT subscriptions.plan,subscriptions.status FROM subscriptions JOIN organizations ON organizations.id=subscriptions.organization_id WHERE organizations.slug LIKE 'nova-empresa-%'",
        )
        .get(),
    )

      .toMatchObject({ plan: "scale", status: "active" })

    const reused = await worker.fetch(
      request("/api/auth/register", "POST", {
        ...body,
        order_nsu: "public_paid",
      }),

      env,

      ctx,
    )

    expect(reused.status).toBe(409)

    expect(db.prepare("SELECT COUNT(*) count FROM users").get()).toMatchObject({
      count: 2,
    })

    db.close()
  })
})

describe("solicitações de suporte", () => {
  it("envia e-mail ao destino configurado, limita reenvio e não permite vínculo sem associação ativa", async () => {
    const { db, env, request } = setup()

    const fetchMock = vi.fn(async () => Response.json({ id: "email-id" }))

    vi.stubGlobal("fetch", fetchMock)

    const auth: Session = {
      userId: "user",
      organizationId: "org",
      role: "admin",
    }

    const first = await supportRoutes(
      request("/api/support", "POST", {
        email: "retorno@example.test",

        message: "Preciso de ajuda com minha conta.",
      }),

      env,

      auth,
    )

    expect(first?.status).toBe(201)

    const sentEmail = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))

    expect(sentEmail.to).toEqual(["support@example.test"])

    expect(sentEmail.reply_to).toBe("retorno@example.test")

    expect(
      db.prepare("SELECT status FROM support_messages").get(),
    ).toMatchObject({
      status: "sent",
    })

    const repeated = await supportRoutes(
      request("/api/support", "POST", {
        email: "retorno@example.test",

        message: "Outra mensagem de suporte.",
      }),

      env,

      auth,
    )

    expect(repeated?.status).toBe(429)

    const unassociated = await supportRoutes(
      request("/api/support", "POST", {
        email: "retorno@example.test",

        message: "Tentativa em outra empresa.",
      }),

      env,

      { ...auth, organizationId: "other" },
    )

    expect(unassociated?.status).toBe(404)

    expect(fetchMock).toHaveBeenCalledTimes(1)

    db.close()
  })
})
