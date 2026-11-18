import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../worker/index"
import { autoReply } from "../worker/ai"
import {
  catalogEnabled,
  processPendingCatalogDeliveries,
  sendCatalog,
} from "../worker/catalog"
import { sendFile, sendText } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", () => ({
  sendText: vi.fn(async () => new Response(null, { status: 200 })),
  sendFile: vi.fn(async () => new Response(null, { status: 200 })),
}))

vi.mock("../worker/catalog", () => ({
  catalogEnabled: vi.fn(async () => false),
  catalogTools: [],
  processPendingCatalogDeliveries: vi.fn(async () => {}),
  runCatalogTool: vi.fn(),
  sendCatalog: vi.fn(async () => ({
    enviadas: 0,
    erro: null,
    status: "ENVIANDO",
    totalSelecionados: 30,
    totalLotes: 8,
  })),
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
    purchaseReadiness: "ready_now" | "considering" | "future" | "unknown"
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
    catalogStatus?: string
    catalogJobStatus?: string | null
    aiState?: string
    organization?: string
    assistantName?: string
  } = {},
) {
  const statements: string[] = []
  const db = {
    prepare(sql: string) {
      return {
        bind() { return this },
        async first() {
          if (sql.includes("FROM ai_settings")) return { enabled: 1, assistant_name: options.assistantName ?? "Ana", instructions: "" }
          if (sql.includes("SELECT l.id leadId")) return {
            leadId: "lead", status: "in_service", handoffAt: null, organization: options.organization ?? "Loja",
            contactName: null, attendantName: null, humanActive: null, aiState: options.aiState ?? "IA_ATIVA",
            catalogStatus: options.catalogStatus ?? "ENVIADO", catalogSourceExternalId: null,
            assignedTo: options.assignedTo ?? null, assignmentRevision: 0,
          }
          if (sql.includes("FROM catalog_delivery_jobs"))
            return options.catalogJobStatus
              ? { status: options.catalogJobStatus }
              : null
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
      mainInterest: null, budgetRange: null, paymentMethod: null, purchaseTimeline: null,
      purchaseReadiness: "ready_now", paymentViability: "viable",
    },
    ...overrides,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.mocked(catalogEnabled).mockResolvedValue(false)
  vi.mocked(processPendingCatalogDeliveries).mockResolvedValue(undefined)
  vi.mocked(sendCatalog).mockResolvedValue({
    enviadas: 0,
    erro: null,
    status: "ENVIANDO",
    totalSelecionados: 30,
    totalLotes: 8,
  })
})

describe("oferta de vendedor pela IA", () => {
  it("envia a saudação aceita pela API antes de iniciar o catálogo no primeiro contato", async () => {
    vi.mocked(catalogEnabled).mockResolvedValue(true)
    const { env, statements, fetchMock } = setup(decision(), 1, {
      catalogStatus: "PENDENTE",
      assistantName: "Theo",
      organization: "Goo Elétricos",
    })

    vi.mocked(processPendingCatalogDeliveries).mockImplementationOnce(
      async () => {
        await sendFile(
          env,
          { userId: "", organizationId: "org", role: "ai" },
          "conversation",
          new File([new Uint8Array([1])], "catalogo.pdf", {
            type: "application/pdf",
          }),
          "Catálogo",
        )
      },
    )
    expect(await autoReply(env, "org", "conversation", "latest")).toBe(true)

    const calls = vi.mocked(sendText).mock.calls
    expect(calls[0]?.[3]).toBe(
      "Oi! Tudo bem? 😊 Eu sou o Theo, assistente virtual da GoO Elétricos Itajubá! 🛵\n\nVou te enviar nosso catálogo com todas as nossas opções de scooters para você conhecer.\n\nPode olhar com calma! Se tiver alguma dúvida sobre os modelos ou quiser conhecer as formas de pagamento, estou à disposição!",
    )
    expect(calls[0]?.[4]).toEqual({ aiReplyKey: "ai:latest:welcome" })
    expect(sendText.mock.invocationCallOrder[0]).toBeLessThan(
      sendCatalog.mock.invocationCallOrder[0]!,
    )
    expect(sendCatalog).toHaveBeenCalledOnce()
    expect(vi.mocked(sendCatalog).mock.calls[0]).toHaveLength(5)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.[3]).toBe("Como posso ajudar?")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(sendFile).toHaveBeenCalledOnce()
    expect(sendText.mock.invocationCallOrder[1]).toBeLessThan(
      sendFile.mock.invocationCallOrder[0]!,
    )
    expect(statements.some((sql) => sql.includes("ai_state='HUMANO'"))).toBe(false)
  })

  it("responde sobre financiamento Sicredi depois do catálogo sem reenviar a saudação", async () => {
    const answer =
      "Consegue sim! Trabalhamos com financiamento pela Sicredi em até 36 parcelas, sujeito à análise de crédito. Para solicitar, é necessário nome limpo, sem restrições e bom score. Você está com o nome limpo atualmente?"
    const { env, fetchMock } = setup(
      decision({ reply: answer }),
      2,
      { messageBody: "Eu consigo fazer uma simulação por financiamento?" },
    )

    await autoReply(env, "org", "conversation", "latest")

    expect(sendText).toHaveBeenCalledOnce()
    expect(vi.mocked(sendText).mock.calls[0]?.[3]).toBe(answer)
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request.instructions).toContain("Sicredi em até 36 parcelas")
    expect(request.instructions).toContain("nome limpo, sem restrições e bom score")
  })

  it("continua atendendo por texto quando o envio inicial do catálogo falha", async () => {
    vi.mocked(catalogEnabled).mockResolvedValue(true)
    vi.mocked(sendCatalog).mockResolvedValue({
      enviadas: 0,
      erro: "A Meta recusou o envio.",
    })
    const { env, fetchMock } = setup(decision({ reply: "Como posso ajudar?" }), 1, {
      catalogStatus: "PENDENTE",
    })

    expect(await autoReply(env, "org", "conversation", "latest")).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(sendText).toHaveBeenCalledTimes(2)
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request.input[0].content[0].text).toContain(
      "O catálogo não foi aceito para envio",
    )
  })

  it("ignora a resposta da mensagem antiga e responde a mensagem mais recente", async () => {
    const { env } = setup(decision(), 2)

    expect(await autoReply(env, "org", "conversation", "previous-1")).toBeUndefined()
    expect(sendText).not.toHaveBeenCalled()

    expect(await autoReply(env, "org", "conversation", "latest")).toBe(true)
    expect(sendText).toHaveBeenCalledOnce()
  })

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
    expect(request.text.format.schema.properties.lead.required).toContain("purchaseReadiness")
  })

  it.each([
    ["sem necessidade identificada", decision()],
    ["lead qualificado", decision({ offerSalesperson: true, lead: { ...decision().lead, status: "qualified", score: 80, purchaseReadiness: "considering" } })],
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

  it("envia saudação e catálogo uma vez e pede reenvio por texto para erro 131060", async () => {
    vi.mocked(catalogEnabled).mockResolvedValue(true)
    const { env, fetchMock } = setup(decision(), 1, {
      messageType: "unsupported",
      messageErrorCode: "131060",
      messageBody: "[Conteúdo da mensagem não fornecido pela Meta.]",
      contentAvailable: 0,
      catalogStatus: "PENDENTE",
    })

    await autoReply(env, "org", "conversation", "latest")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sendText).mock.calls[0]?.[3]).toContain("Eu sou o Ana")
    expect(vi.mocked(sendText).mock.calls[1]?.[3]).toContain(
      "Pode me reenviar sua dúvida por texto?",
    )
    expect(sendCatalog).toHaveBeenCalledOnce()
  })

  it("responde à pergunta do cliente enquanto o catálogo está sendo enviado", async () => {
    const { env } = setup(
      decision({ reply: "A autonomia informada é de até 50 km." }),
      2,
      {
        messageBody: "Qual é a autonomia?",
        catalogStatus: "ENVIANDO",
        catalogJobStatus: "processing",
      },
    )

    await autoReply(env, "org", "conversation", "latest")

    expect(sendCatalog).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledOnce()
    expect(vi.mocked(sendText).mock.calls[0]?.[3]).toBe(
      "A autonomia informada é de até 50 km.",
    )
  })

  it("não repete saudação nem catálogo em um novo erro 131060", async () => {
    const { env, fetchMock } = setup(decision(), 1, {
      messageType: "unsupported",
      messageErrorCode: "131060",
      messageBody: "[Conteúdo da mensagem não fornecido pela Meta.]",
      contentAvailable: 0,
      catalogStatus: "ENVIADO",
    })

    await autoReply(env, "org", "conversation", "latest")

    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendCatalog).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledOnce()
    expect(vi.mocked(sendText).mock.calls[0]?.[3]).toContain(
      "Pode me reenviar sua dúvida por texto?",
    )
  })

  it("não afirma que o catálogo foi enviado quando a Meta rejeita o envio", async () => {
    vi.mocked(catalogEnabled).mockResolvedValue(true)
    vi.mocked(sendCatalog).mockResolvedValue({
      enviadas: 0,
      erro: "A Meta recusou o envio.",
    })
    const { env } = setup(decision(), 1, {
      messageType: "unsupported",
      messageErrorCode: "131060",
      contentAvailable: 0,
      catalogStatus: "PENDENTE",
    })

    await autoReply(env, "org", "conversation", "latest")

    expect(vi.mocked(sendText).mock.calls[1]?.[3]).toContain(
      "Não consegui confirmar o envio completo do catálogo",
    )
  })

  it("envia uma resposta neutra se a IA retornar texto vazio", async () => {
    const { env } = setup(decision({ reply: "" }))

    await autoReply(env, "org", "conversation", "latest")

    expect(sendText).toHaveBeenCalledOnce()
    expect(vi.mocked(sendText).mock.calls[0]?.[3]).toContain(
      "Pode me contar um pouco mais",
    )
    expect(vi.mocked(sendText).mock.calls[0]?.[4]).toMatchObject({
      aiReplyKey: "ai:latest:fallback:0",
    })
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

  it("continua respondendo enquanto a conversa estiver atribuída mas não houver mensagem humana", async () => {
    const { env, fetchMock } = setup(decision(), 2, { assignedTo: "agent" })
    expect(await autoReply(env, "org", "conversation", "latest")).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(sendText).toHaveBeenCalledOnce()
  })

  it("não envia uma resposta que estava sendo preparada quando houve atribuição", async () => {
    const { env } = setup(decision(), 2, { takenOver: true })
    await autoReply(env, "org", "conversation", "latest")
    expect(sendText).not.toHaveBeenCalled()
  })
})
