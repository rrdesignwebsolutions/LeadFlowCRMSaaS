import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Env, Session } from "../worker/index"
import { quickReplyRoutes } from "../worker/quick-replies"

function setup() {
  const db = new DatabaseSync(":memory:")
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))
  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES('org','Empresa','empresa'),('other','Outra','outra');
    INSERT INTO users(id,email,name,password_hash,password_salt) VALUES('user','user@example.test','Usuário','hash','salt');
  `)
  const env = { DB: {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...values: unknown[]) { args = values; return this },
        async all() { return { results: db.prepare(sql).all(...args as never[]) } },
        async run() { return { meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } } },
      }
    },
  } } as unknown as Env
  const call = (path: string, method: string, body?: unknown, organizationId = "org", role: Session["role"] = "agent") => {
    const url = new URL(`https://example.com${path}`)
    const request = new Request(url, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) })
    return quickReplyRoutes(request, env, url, { userId: "user", organizationId, role })
  }
  return { db, call }
}

describe("mensagens rápidas", () => {
  it("permite criar, listar, editar e excluir mensagens compartilhadas", async () => {
    const { db, call } = setup()
    const created = await call("/api/quick-replies", "POST", { title: " Saudação ", body: " Olá!\nComo vai? " })
    expect(created?.status).toBe(201)
    const { id } = await created!.json() as { id: string }
    const list = await call("/api/quick-replies", "GET", undefined, "org", "manager")
    expect(await list?.json()).toEqual({ results: [{ id, title: "Saudação", body: "Olá!\nComo vai?" }] })
    expect((await call(`/api/quick-replies/${id}`, "PUT", { title: "Novo", body: "Texto" }))?.status).toBe(200)
    expect((await call(`/api/quick-replies/${id}`, "DELETE"))?.status).toBe(200)
    expect(await (await call("/api/quick-replies", "GET"))?.json()).toEqual({ results: [] })
    db.close()
  })

  it("isola organizações em leitura, edição e exclusão", async () => {
    const { db, call } = setup()
    const response = await call("/api/quick-replies", "POST", { title: "A", body: "B" })
    const { id } = await response!.json() as { id: string }
    expect(await (await call("/api/quick-replies", "GET", undefined, "other"))?.json()).toEqual({ results: [] })
    expect((await call(`/api/quick-replies/${id}`, "PUT", { title: "C", body: "D" }, "other"))?.status).toBe(404)
    expect((await call(`/api/quick-replies/${id}`, "DELETE", undefined, "other"))?.status).toBe(404)
    db.close()
  })

  it("rejeita textos vazios ou acima do limite", async () => {
    const { db, call } = setup()
    for (const body of [{ title: " ", body: "Olá" }, { title: "A", body: "" }, { title: "A".repeat(81), body: "B" }, { title: "A", body: "B".repeat(4097) }])
      expect((await call("/api/quick-replies", "POST", body))?.status).toBe(400)
    expect((await call("/api/quick-replies/inexistente", "DELETE"))?.status).toBe(404)
    db.close()
  })
})
