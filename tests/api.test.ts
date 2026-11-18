import { afterEach, describe, expect, it, vi } from "vitest"
import { api, ApiError } from "../src/api"

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("cliente da API", () => {
  it("rejeita HTML do fallback do Vite em vez de tratá-lo como dados", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<!doctype html><html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      ),
    )

    await expect(api("/api/me")).rejects.toMatchObject({
      status: 502,
      message: "A API do AV Flow não respondeu em JSON. Verifique se o Worker está ativo.",
    })
  })

  it("preserva mensagens de erro JSON do servidor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({ error: "Não autorizado.", code: "unauthorized" }, { status: 401 }),
      ),
    )

    await expect(api("/api/me")).rejects.toMatchObject({
      status: 401,
      message: "Não autorizado.",
      code: "unauthorized",
    } satisfies Partial<ApiError>)
  })
})
