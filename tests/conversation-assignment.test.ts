import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Env, Session } from "../worker/index"
import { whatsappRoutes } from "../worker/whatsapp"
import { autoReply } from "../worker/ai"

vi.mock("../worker/ai", () => ({
  autoReply: vi.fn(async () => true),
  classifyLead: vi.fn(),
  requestHuman: vi.fn(),
  TALK_TO_HUMAN_ID: "talk_to_human",
}))

const auth: Session = { userId: "user", organizationId: "org", role: "agent" }

function setup(options: {
  member?: boolean
  assignedTo?: string | null
  pending?: object | null
  enqueueFails?: boolean
} = {}) {
  const statements: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        sql, args: [] as unknown[],
        bind(...args: unknown[]) { this.args = args; return this },
        async first() {
          if (sql.startsWith("SELECT id FROM conversations")) return { id: "conv" }
          if (sql.includes("FROM organization_members")) return options.member ? { user_id: "agent" } : null
          if (sql.startsWith("SELECT assigned_to")) return { assignedTo: options.assignedTo ?? null }
          if (sql.includes("FROM ai_settings")) return { enabled: 1 }
          if (sql.startsWith("SELECT direction,type,status,external_id")) return options.pending ?? null
          if (sql.includes("FROM whatsapp_processing_jobs")) {
            return { id: "job", status: "processing", active: 1 }
          }
          return null
        },
        async run() {
          if (
            options.enqueueFails &&
            sql.includes("INSERT OR IGNORE INTO whatsapp_processing_jobs")
          )
            throw new Error("falha")
          statements.push({ sql, args: this.args })
          return { meta: { changes: 1 } }
        },
      }
    },
    async batch(items: Array<{ sql: string; args: unknown[] }>) { statements.push(...items); return [] },
  }
  const env = { DB: db, OPENAI_API_KEY: "test" } as unknown as Env
  const call = (assignedTo: unknown) => {
    const url = new URL("https://example.com/api/conversations/conv/assignment")
    const request = new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignedTo }) })
    return whatsappRoutes(request, env, url, auth)
  }
  return { env, statements, call }
}

beforeEach(() => vi.clearAllMocks())

describe("atribuição de conversas", () => {
  it("atribui a conversa a membro ativo da mesma organização", async () => {
    const { call, statements } = setup({ member: true })
    expect((await call("agent"))?.status).toBe(200)
    const update = statements.find((s) => s.sql.includes("assignment_revision=assignment_revision+1"))
    expect(update?.args).toEqual([
      "agent",
      "agent",
      "agent",
      "agent",
      "conv",
      "org",
    ])
    expect(autoReply).not.toHaveBeenCalled()
  })

  it("rejeita membro que não pertence à organização ou está desativado", async () => {
    const { call, statements } = setup()
    expect((await call("other"))?.status).toBe(400)
    expect(statements).toHaveLength(0)
  })

  it("coloca a mensagem pendente na fila e não chama a IA diretamente", async () => {
    const { call, env, statements } = setup({
      assignedTo: "agent",
      pending: { direction: "inbound", type: "text", externalId: "wamid", at: new Date().toISOString() },
    })
    const response = await call(null)
    expect(response?.status).toBe(200)
    expect(await response?.json()).toMatchObject({
      notice: "A IA já está processando a mensagem pendente.",
    })
    expect(autoReply).not.toHaveBeenCalledWith(env, "org", "conv", "wamid")
    expect(
      statements.some((statement) =>
        statement.sql.includes("INSERT OR IGNORE INTO whatsapp_processing_jobs"),
      ),
    ).toBe(true)
    expect(statements.some((s) => s.sql.includes("ai_handoff_at=NULL"))).toBe(true)
  })

  it("não responde novamente quando a última mensagem é de saída", async () => {
    const { call } = setup({ assignedTo: "agent", pending: { direction: "outbound" } })
    expect((await call(null))?.status).toBe(200)
    expect(autoReply).not.toHaveBeenCalled()
  })

  it("avisa quando a janela de atendimento expirou", async () => {
    const { call } = setup({ assignedTo: "agent", pending: {
      direction: "inbound", type: "text", externalId: "wamid", at: "2020-01-01T00:00:00Z",
    } })
    const response = await call(null)
    expect(await response?.json()).toMatchObject({ warning: expect.stringContaining("24 horas") })
    expect(autoReply).not.toHaveBeenCalled()
  })

  it("avisa se houver falha ao responder a mensagem pendente", async () => {
    const { call } = setup({ assignedTo: "agent", pending: {
      direction: "inbound", type: "text", externalId: "wamid", at: new Date().toISOString(),
    }, enqueueFails: true })
    const response = await call(null)
    expect(await response?.json()).toMatchObject({ warning: expect.stringContaining("não foi possível") })
  })
})
