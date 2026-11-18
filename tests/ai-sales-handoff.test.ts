import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../worker/index"
import { autoReply } from "../worker/ai"
import { sendText } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", () => ({
  sendText: vi.fn(async () => new Response(null, { status: 200 })),
}))

vi.mock("../worker/catalog", () => ({
  catalogEnabled: vi.fn(async () => false),
  catalogTools: [],
  runCatalogTool: vi.fn(),
}))

vi.mock("../worker/verification", () => ({
  escapeHtml: (text: string) => text,
  sendNotificationEmail: vi.fn(async () => {}),
}))

type TestDecision = {
  reply: string
  handoff: boolean
  offerSalesperson: boolean
  lead: {
    status: string | null
    score: number | null
    summary: string | null
    productInterest: string | null
    mainInterest: string | null
    budgetRange: string | null
    paymentMethod: string | null
    purchaseTimeline: string | null
    paymentViability: "blocked" | "viable" | "unknown"
  }
}

function setup(
  decision: TestDecision,
  inboundCount = 2,
  options: {
    assignedTo?: string
    takenOver?: boolean
    messageType?: string
    messageErrorCode?: string
    messageBody?: string
    contentAvailable?: number
  } = {},
) {
  const statements: string[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this },
        async first() {
          if (sql.includes("FROM ai_settings")) return { enabled: 1, assistant_name: "Ana", instructions: "" }
          if (sql.includes("SELECT l.id leadId")) return {
            leadId: "lead", status: "in_service", handoffAt: null, organization: "Loja",
            contactName: null, attendantName: null, humanActive: null, assignedTo: options.assignedTo ?? null, assignmentRevision: 0,
          }
          if (sql.includes("SELECT 1 x FROM conversations")) return options.takenOver ? { x: 1 } : null
          if (sql.includes("SELECT direction,external_id externalId")) return { direction: "inbound", externalId: "latest" }
          if (sql.startsWith("SELECT 1 FROM conversations")) return { ok: 1 }
          if (sql.includes("SELECT ct.id contactId")) return {
            contactId: "contact", name: "Cliente", phone: "123", requestedAt: null,
          }
          return null
        },
        async all() {
          if (sql.includes("SELECT direction,body,type")) return {
            results: Array.from({ length: inboundCount }, (_, index) => ({
              direction: "inbound",
              body: index === 0 ? options.messageBody ?? "Olá" : "Olá",
              type: index === 0 ? options.messageType ?? "text" : "text",
              errorCode: index === 0 ? options.messageErrorCode ?? null : null,
              contentAvailable:
                index === 0
                  ? options.contentAvailable ??
                    (options.messageType === "unsupported" ? 0 : 1)
                  : 1,
              externalId: index === 0 ? "latest" : `previous-${index}`,
            })),
          }
          return { results: [] }
        },
        async run() { statements.push(sql); return { meta: { changes: 1 } } },
        sql,
      }
    },
    async batch(batch: Array<{ sql: string }>) { statements.push(...batch.map((item) => item.sql)); return [] },
  }
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision) }] }],
  })))
  vi.stubGlobal("fetch", fetchMock)
  return { env: { DB: db, OPENAI_API_KEY: "test" } as unknown as Env, statements, fetchMock }
}

function decision(overrides: Partial<TestDecision> = {}): TestDecision {
  return {
    reply: "Como posso ajudar?",
    handoff: false,
    offerSalesperson: false,
    lead: {
      status: "hot", score: 70, summary: null, productInterest: null,
      mainInterest: null, budgetRange: null, paymentMethod: null, purchaseTimeline: null, paymentViability: "viable",
    },
    ...overrides,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("oferta de vendedor pela IA", () => {
  it("não oferece o botão na primeira resposta, mesmo se a IA o solicitar", async () => {
    const { env } = setup(decision({ offerSalesperson: true }), 1)
    await autoReply(env, "org", "conversation", "latest")
    expect(vi.mocked(sendText).mock.calls[0][4]).toEqual({
      talkButton: false,
      assignmentRevision: 0,
      aiReplyKey: "ai:latest:text:0",
    })
  })

  it("oferece o botão somente quando a IA identifica necessidade e lead quente", async () => {
    const { env, statements, fetchMock } = setup(decision({ offerSalesperson: true }))
    await autoReply(env, "org", "conversation", "latest")
    expect(vi.mocked(sendText).mock.calls[0][4]).toEqual({
      talkButton: true,
      assignmentRevision: 0,
      aiReplyKey: "ai:latest:text:0",
    })
    expect(statements.some((sql) => sql.includes("UPDATE conversations SET human_requested_at"))).toBe(false)
    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(request.text.format.schema.required).toContain("offerSalesperson")
  })

  it.each([
    ["sem necessidade identificada", decision()],
    ["lead qualificado", decision({ offerSalesperson: true, lead: { ...decision().lead, status: "qualified", score: 80 } })],
    ["nota abaixo de 70", decision({ offerSalesperson: true, lead: { ...decision().lead, score: 69 } })],
    ["nota ausente", decision({ offerSalesperson: true, lead: { ...decision().lead, score: null } })],
    ["nota inválida", decision({ offerSalesperson: true, lead: { ...decision().lead, score: 101 } })],
    ["pagamento impedido", decision({ offerSalesperson: true, lead: { ...decision().lead, paymentViability: "blocked" } })],
    ["viabilidade desconhecida", decision({ offerSalesperson: true, lead: { ...decision().lead, paymentViability: "unknown" } })],
  ])("não oferece o botão: %s", async (_label, result) => {
    const { env } = setup(result)
    await autoReply(env, "org", "conversation", "latest")
    expect(vi.mocked(sendText).mock.calls[0][4]).toEqual({
      talkButton: false,
      assignmentRevision: 0,
      aiReplyKey: "ai:latest:text:0",
    })
  })

  it("envia respostas longas em partes e limita a mensagem com botão", async () => {
    const { env } = setup(decision({ offerSalesperson: true, reply: "a".repeat(1500) }))
    await autoReply(env, "org", "conversation", "latest")
    const calls = vi.mocked(sendText).mock.calls
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => String(call[3]).length <= 1024)).toBe(true)
    expect(calls[0]?.[4]).toEqual({
      talkButton: false,
      assignmentRevision: 0,
      aiReplyKey: "ai:latest:text:0",
    })
    expect(calls[1]?.[4]).toEqual({
      talkButton: true,
      assignmentRevision: 0,
      aiReplyKey: "ai:latest:text:1",
    })
  })

  it("responde a formulários do WhatsApp recebidos como mensagens interativas", async () => {
    const { env } = setup(decision(), 1, {
      messageType: "interactive",
      messageBody:
        "O cliente concluiu um formulário no WhatsApp. Nome: Anderson. Interesse: moto elétrica.",
    })

    await autoReply(env, "org", "conversation", "latest")

    expect(vi.mocked(sendText).mock.calls[0]?.[3]).toBe("Como posso ajudar?")
  })

  it("não aciona a IA quando a Meta não disponibiliza o conteúdo (131060)", async () => {
    const { env, fetchMock } = setup(decision({ reply: "" }), 1, {
      messageType: "unsupported",
      messageErrorCode: "131060",
      messageBody: "[Conteúdo da mensagem não fornecido pela Meta.]",
    })

    await autoReply(env, "org", "conversation", "latest")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
  })

  it("não separa um emoji entre duas mensagens", async () => {
    const reply = `${"a".repeat(1023)}😀${"b".repeat(8)}`
    const { env } = setup(decision({ offerSalesperson: true, reply }))
    await autoReply(env, "org", "conversation", "latest")
    const parts = vi.mocked(sendText).mock.calls.map((call) => String(call[3]))
    expect(parts.join("")).toBe(reply)
    expect(parts.some((part) => part.includes("\ud83d") && !part.includes("😀"))).toBe(false)
  })

  it("preserva uma ficha longa em mensagens dentro do limite do WhatsApp", async () => {
    const reply = "Especificação verificada. ".repeat(350)
    const { env } = setup(decision({ reply }))
    await autoReply(env, "org", "conversation", "latest")
    const calls = vi.mocked(sendText).mock.calls
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.every((call) => String(call[3]).length <= 4000)).toBe(true)
    expect(calls.map((call) => call[3]).join(" ")).toContain("Especificação verificada.")
  })

  it("mantém o encaminhamento imediato quando a IA identifica necessidade de atendimento humano", async () => {
    const { env, statements } = setup(decision({ handoff: true, offerSalesperson: true }))
    await autoReply(env, "org", "conversation", "latest")
    expect(vi.mocked(sendText).mock.calls[0][4]).toEqual({
      talkButton: false,
      assignmentRevision: 0,
      aiReplyKey: "ai:latest:text:0",
    })
    expect(statements.some((sql) => sql.includes("UPDATE conversations SET human_requested_at"))).toBe(true)
  })

  it("não gera resposta quando a conversa está atribuída a uma pessoa", async () => {
    const { env, fetchMock } = setup(decision(), 2, { assignedTo: "agent" })
    await autoReply(env, "org", "conversation", "latest")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendText).not.toHaveBeenCalled()
  })

  it("não envia uma resposta que estava sendo preparada quando houve atribuição", async () => {
    const { env } = setup(decision(), 2, { takenOver: true })
    await autoReply(env, "org", "conversation", "latest")
    expect(sendText).not.toHaveBeenCalled()
  })
})
