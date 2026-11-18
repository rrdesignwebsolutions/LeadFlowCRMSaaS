import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Env, Session } from "../worker/index"
import { aiRoutes } from "../worker/ai"

function setup() {
  const db = new DatabaseSync(":memory:")
  for (const file of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))
  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES('org','GoO','goo');
    INSERT INTO users(id,email,name,password_hash,password_salt)
      VALUES('admin','admin@example.com','Admin','hash','salt');
  `)
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = []
        return {
          bind(...values: unknown[]) { args = values; return this },
          async first() { return db.prepare(sql).get(...args as never[]) ?? null },
          async all() { return { results: db.prepare(sql).all(...args as never[]) } },
          async run() { return { meta: { changes: Number(db.prepare(sql).run(...args as never[]).changes) } } },
        }
      },
    },
  } as unknown as Env
  const auth: Session = { userId: "admin", organizationId: "org", role: "admin" }
  const call = (method: string, body?: unknown, path = "/api/ai/settings") => {
    const url = new URL(`https://example.com${path}`)
    const request = new Request(url, {
      method,
      ...(body === undefined ? {} : {
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    })
    return aiRoutes(request, env, url, auth)
  }
  return { db, call }
}

describe("consentimento de processamento de mídia", () => {
  it("começa desligado e só ativa por opção explícita da empresa", async () => {
    const { db, call } = setup()

    expect(await (await call("GET"))?.json()).toMatchObject({
      settings: { mediaProcessingEnabled: false },
    })

    await call("PUT", {
      enabled: true,
      assistantName: "Theo",
      instructions: "",
      mediaProcessingEnabled: true,
    })
    expect(db.prepare("SELECT media_processing_enabled FROM ai_settings WHERE organization_id='org'").get())
      .toMatchObject({ media_processing_enabled: 1 })

    await call("PUT", {
      enabled: true,
      assistantName: "Theo",
      instructions: "",
      mediaProcessingEnabled: false,
    })
    expect(db.prepare("SELECT media_processing_enabled FROM ai_settings WHERE organization_id='org'").get())
      .toMatchObject({ media_processing_enabled: 0 })
    db.close()
  })

  it("salva o perfil do agente e registra FAQs como fonte de conhecimento", async () => {
    const { db, call } = setup()
    await call("PUT", {
      enabled: true,
      assistantName: "Theo",
      instructions: "Ser cordial.",
      responseStyle: "creative",
      businessDescription: "Loja de scooters elétricas.",
      language: "pt-BR",
    })
    expect(await (await call("GET"))?.json()).toMatchObject({
      settings: {
        responseStyle: "creative",
        businessDescription: "Loja de scooters elétricas.",
        language: "pt-BR",
      },
    })

    const created = await call(
      "POST",
      { question: "Qual o prazo?", answer: "Consulte nossa equipe." },
      "/api/ai/knowledge/faq",
    )
    expect(created?.status).toBe(201)
    expect(
      db.prepare("SELECT source_type,question,answer FROM ai_knowledge").get(),
    ).toMatchObject({
      source_type: "faq",
      question: "Qual o prazo?",
      answer: "Consulte nossa equipe.",
    })
    db.close()
  })

  it("recusa importação de página não segura sem fazer requisição externa", async () => {
    const { db, call } = setup()
    const response = await call(
      "POST",
      { url: "http://localhost/private" },
      "/api/ai/knowledge/website",
    )
    expect(response?.status).toBe(400)
    expect(db.prepare("SELECT COUNT(*) count FROM ai_knowledge").get()).toMatchObject({ count: 0 })
    db.close()
  })
})
