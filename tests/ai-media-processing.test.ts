import { afterEach, describe, expect, it, vi } from "vitest"
import type { Env } from "../worker/index"
import { autoReply, classifyLead } from "../worker/ai"
import { fetchInboundMessageMedia, sendText } from "../worker/whatsapp"

vi.mock("../worker/whatsapp", () => ({
  fetchInboundMessageMedia: vi.fn(),
  sendText: vi.fn(async () => new Response(null, { status: 200 })),
}))

vi.mock("../worker/catalog", () => ({
  catalogEnabled: vi.fn(async () => false),
  catalogTools: [],
  processPendingCatalogDeliveries: vi.fn(async () => {}),
  runCatalogTool: vi.fn(),
}))

vi.mock("../worker/verification", () => ({
  escapeHtml: (text: string) => text,
  sendNotificationEmail: vi.fn(async () => {}),
}))

function setup(type: "audio" | "image", mediaProcessingEnabled = 1) {
  const updates: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      let args: unknown[] = []
      return {
        bind(...values: unknown[]) { args = values; return this },
        async first() {
          if (sql.includes("FROM ai_settings"))
            return { enabled: 1, assistant_name: "Theo", instructions: "", mediaProcessingEnabled }
          if (sql.includes("SELECT l.id leadId"))
            return {
              leadId: "lead", status: "in_service", organization: "GoO",
              contactName: null, attendantName: null, humanActive: null,
              assignedTo: null, assignmentRevision: 0,
            }
          if (sql.includes("SELECT status,ai_summary")) return { status: "in_service" }
          if (sql.includes("SELECT direction,external_id externalId"))
            return { direction: "inbound", externalId: "wamid.media" }
          if (sql.includes("SELECT 1 x FROM conversations")) return null
          if (sql.startsWith("SELECT 1 FROM conversations")) return { ok: 1 }
          return null
        },
        async all() {
          if (sql.includes("SELECT direction,body,type"))
            return {
              results: [{
                direction: "inbound", body: type === "audio" ? "[Áudio]" : "[Imagem]",
                type, contentAvailable: 1, externalId: "wamid.media",
              }],
            }
          return { results: [] }
        },
        async run() { updates.push({ sql, args }); return { meta: { changes: 1 } } },
      }
    },
  }
  return { env: { DB: db, OPENAI_API_KEY: "test" } as unknown as Env, updates }
}

function decision() {
  return {
    reply: "Posso te ajudar com esse modelo.",
    handoff: false,
    offerSalesperson: false,
    lead: {
      status: "qualified", score: 55, summary: null, productInterest: null,
      mainInterest: null, budgetRange: null, paymentMethod: null,
      purchaseTimeline: null, purchaseReadiness: "unknown", paymentViability: "unknown",
    },
  }
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe("mídia recebida pela IA", () => {
  it("transcreve áudio e inclui a transcrição no contexto e histórico", async () => {
    const { env, updates } = setup("audio")
    vi.mocked(fetchInboundMessageMedia).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "audio/ogg",
    })
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.endsWith("/audio/transcriptions"))
        return new Response(JSON.stringify({ text: "Quero saber o preço da TERA." }))
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision()) }] }],
      }))
    }))

    await autoReply(env, "org", "conv", "wamid.media")

    expect(fetchInboundMessageMedia).toHaveBeenCalledWith(env, "org", "conv", "wamid.media")
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions")
    expect(requests[0]?.init?.body).toBeInstanceOf(FormData)
    expect(updates.some(({ sql, args }) =>
      sql.includes("UPDATE messages SET body=?") && String(args[0]).includes("Quero saber o preço da TERA"),
    )).toBe(true)
    const responseRequest = JSON.parse(String(requests[1]?.init?.body))
    expect(responseRequest.input[0].content[0].text).toContain("Quero saber o preço da TERA.")
    expect(sendText).toHaveBeenCalledOnce()
  })

  it("envia imagem como input visual ao modelo configurado", async () => {
    const { env } = setup("image")
    vi.mocked(fetchInboundMessageMedia).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/jpeg",
    })
    let requestBody: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision()) }] }],
      }))
    }))

    await autoReply(env, "org", "conv", "wamid.media")

    const request = requestBody as unknown as { model: string; input: Array<{ content: Array<{ type: string; image_url?: string }> }> }
    expect(request.model).toBe("gpt-6-luna")
    expect(request.input[0]?.content).toContainEqual({
      type: "input_image", image_url: "data:image/jpeg;base64,AQID", detail: "auto",
    })
    expect(sendText).toHaveBeenCalledOnce()
  })

  it("não transmite mídia quando o processamento está desativado", async () => {
    const { env } = setup("audio", 0)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    await expect(autoReply(env, "org", "conv", "wamid.media")).resolves.toBe(true)

    expect(fetchInboundMessageMedia).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(sendText).toHaveBeenCalledOnce()
    expect(vi.mocked(sendText).mock.calls[0]?.[3]).toContain("transcrever seu áudio")
  })

  it("usa a imagem recebida também na classificação quando a IA de resposta está desligada", async () => {
    const { env } = setup("image")
    vi.mocked(fetchInboundMessageMedia).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mime: "image/png",
    })
    let requestBody: Record<string, unknown> | null = null
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(decision()) }] }],
      }))
    }))

    await classifyLead(env, "org", "conv", "wamid.media")

    expect(fetchInboundMessageMedia).toHaveBeenCalledOnce()
    const request = requestBody as unknown as { model: string; input: Array<{ content: Array<{ type: string }> }> }
    expect(request.model).toBe("gpt-6-luna")
    expect(request.input[0]?.content.some((part) => part.type === "input_image")).toBe(true)
  })
})
