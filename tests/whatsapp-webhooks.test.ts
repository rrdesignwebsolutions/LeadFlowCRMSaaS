import { describe, expect, it, vi } from "vitest"

import type { Env } from "../worker/index"

import {
  handleMetaPayload,
  isWithinCustomerServiceWindow,
} from "../worker/whatsapp"

function database() {
  const statements: Array<{ sql: string args: unknown[] }> = []

  const db = {
    prepare(sql: string) {
      return {
        sql,

        args: [] as unknown[],

        bind(...args: unknown[]) {
          this.args = args

          return this
        },

        async first() {
          if (sql.includes("FROM integrations"))
            return {
              id: "integration",
              organization_id: "org",
              display_phone_number: "+15550000000",
            }

          if (sql.includes("FROM webhook_events")) return { id: "event" }

          if (sql.includes("SELECT id,status FROM messages"))
            return { id: "stored-message", status: "accepted" }

          return null
        },

        async all() {
          return { results: [{ id: "integration", organization_id: "org" }] }
        },

        async run() {
          statements.push({ sql, args: this.args })

          return { meta: { changes: 1 } }
        },
      }
    },

    async batch(batch: Array<{ sql: string args: unknown[] }>) {
      statements.push(...batch)

      return batch.map(() => ({ meta: { changes: 1 } }))
    },
  }

  return { env: { DB: db } as unknown as Env, statements }
}

describe("WhatsApp coexistence webhooks", () => {
  it.each([
    [
      131060,
      undefined,
      "[A Meta não compartilhou o conteúdo desta mensagem com o AV Flow. Abra o WhatsApp Business para lê-la; a Meta não enviará esse conteúdo novamente.]",
    ],

    [
      131051,
      "poll_creation",
      "[enquete: tipo de mensagem não suportado pela API da Meta. Confira no WhatsApp Business.]",
    ],

    [
      131051,
      "unknown_kind",
      "[Tipo de mensagem não suportado pela API da Meta. Confira no WhatsApp Business.]",
    ],
  ])(
    "informa o motivo para mensagem não disponibilizada (%s)",
    async (code, subtype, expected) => {
    const { env, statements } = database()

    const after = vi.fn()

      await handleMetaPayload(
        env,
        {
      object: "whatsapp_business_account",

          entry: [
            {
              id: "12345",
              changes: [
                {
                  field: "messages",
                  value: {
        metadata: { phone_number_id: "98765" },

                    messages: [
                      {
                        id: "wamid.unsupported",
                        from: "15551234567",
                        type: "unsupported",

                        errors: [{ code }],
                        unsupported: { type: subtype },
                        timestamp: "1700000000",
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
        "unsupported-hash",
        after,
      )

      const message = statements.find((s) =>
        s.sql.includes("INSERT OR IGNORE INTO messages"),
      )

    expect(message?.args[6]).toBe(expected)

    expect(message?.args[12]).toBe(String(code))

      expect(
        statements.find((s) => s.sql.includes("unread_count=unread_count+?"))
          ?.args[2],
      ).toBe(1)

    if (code === 131060) expect(after).toHaveBeenCalledTimes(1)
    else expect(after).not.toHaveBeenCalled()
    },
  )

  it("preserva código desconhecido sem atribuir um motivo específico", async () => {
    const { env, statements } = database()

    await handleMetaPayload(
      env,
      {
      object: "whatsapp_business_account",

        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "messages",
                value: {
        metadata: { phone_number_id: "98765" },

                  messages: [
                    {
                      id: "wamid.unknown",
                      from: "15551234567",
                      type: "unsupported",
                      errors: [{ code: 999 }],
                      timestamp: "1700000000",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "unknown-hash",
    )

    const message = statements.find((s) =>
      s.sql.includes("INSERT OR IGNORE INTO messages"),
    )

    expect(message?.args[12]).toBe("999")

    expect(message?.args[6]).toBe(
      "[A Meta não enviou o conteúdo desta mensagem ao AV Flow. Consulte-a no WhatsApp Business; a Meta pode não reenviá-la.]",
    )
  })

  it("explica quando a Meta não compartilha o conteúdo da mensagem (131060)", async () => {
    const { env, statements } = database()

    await handleMetaPayload(
      env,
      {
        object: "whatsapp_business_account",

        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "98765" },

                  messages: [
                    {
                      id: "wamid.hidden",
                      from: "15551234567",
                      type: "unsupported",

                      errors: [{ code: 131060 }],
                      timestamp: "1700000000",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "unsupported-hidden-hash",
    )

    const message = statements.find((s) =>
      s.sql.includes("INSERT OR IGNORE INTO messages"),
    )

    expect(message?.args[6]).toContain("Abra o WhatsApp Business")

    expect(message?.args[6]).toContain("não enviará esse conteúdo novamente")

    expect(message?.args[12]).toBe("131060")
  })

  it("registra a resposta do formulário e agenda o processamento da IA", async () => {
    const { env, statements } = database()

    const after = vi.fn()

    await handleMetaPayload(
      env,
      {
        object: "whatsapp_business_account",

        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "98765" },

                  messages: [
                    {
                      id: "wamid.form",

                      from: "15551234567",

                      type: "interactive",

                      interactive: {
                        type: "nfm_reply",

                        nfm_reply: {
                          name: "lead_capture",

                          body: "Sent",

                          response_json: JSON.stringify({
                            flow_token: "do-not-store",

                            nome: "Lavínia",

                            interesse: "Moto elétrica",
                          }),
                        },
                      },

                      timestamp: "1700000000",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "form-reply-hash",
      after,
    )

    const message = statements.find((s) =>
      s.sql.includes("INSERT OR IGNORE INTO messages"),
    )

    expect(message?.args[4]).toBe("inbound")

    expect(message?.args[5]).toBe("interactive")

    expect(message?.args[6]).toContain("nome: Lavínia")

    expect(message?.args[6]).toContain("Dê continuidade ao atendimento")

    expect(message?.args[6]).not.toContain("do-not-store")

    expect(after).toHaveBeenCalledTimes(1)
  })

  it("persists the Meta delivery error details", async () => {
    const { env, statements } = database()

    await handleMetaPayload(
      env,
      {
        object: "whatsapp_business_account",

        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "98765" },

                  statuses: [
                    {
                      id: "wamid.outbound",

                      status: "failed",

                      errors: [
                        {
                          code: 131026,

                          title: "Message undeliverable",

                          message: "The message could not be delivered.",

                          error_data: { details: "Recipient unavailable" },
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "status-error-hash",
    )

    const update = statements.find((s) =>
      s.sql.includes("SET status='failed',error_code=?,error_message=?"),
    )

    expect(update?.args).toEqual([
      "131026",

      "Message undeliverable: The message could not be delivered.: Recipient unavailable",

      "stored-message",

      "org",
    ])
  })

  it("valida a janela de 24 horas pelo horário da última mensagem recebida", () => {
    const now = Date.parse("2026-03-16T12:00:00.000Z")

    expect(
      isWithinCustomerServiceWindow(
        new Date(now - 24 * 60 * 60 * 1000 + 1).toISOString(),

        now,
      ),
    ).toBe(true)

    expect(
      isWithinCustomerServiceWindow(
        new Date(now - 24 * 60 * 60 * 1000).toISOString(),

        now,
      ),
    ).toBe(false)

    expect(
      isWithinCustomerServiceWindow(
        new Date(now + 1).toISOString(),

        now,
      ),
    ).toBe(false)

    expect(isWithinCustomerServiceWindow(null, now)).toBe(false)
  })

  it("stores an app message as outbound without marking it unread or scheduling AI", async () => {
    const { env, statements } = database()

    const after = vi.fn()

    await handleMetaPayload(
      env,
      {
      object: "whatsapp_business_account",

        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "smb_message_echoes",
                value: {
        metadata: { phone_number_id: "98765" },

                  message_echoes: [
                    {
                      id: "wamid.1",
                      to: "15551234567",
                      type: "text",
                      text: { body: "Olá" },
                      timestamp: "1700000000",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "hash",
      after,
    )

    const message = statements.find((s) =>
      s.sql.includes("INSERT OR IGNORE INTO messages"),
    )

    expect(message?.args).toContain("outbound")

    expect(message?.args).toContain("Olá")

    expect(
      statements.find((s) => s.sql.includes("unread_count=unread_count+?"))
        ?.args[2],
    ).toBe(0)

    expect(after).not.toHaveBeenCalled()
  })

  it("imports historical messages without marking them unread and records sync progress", async () => {
    const { env, statements } = database()

    await handleMetaPayload(
      env,
      {
      object: "whatsapp_business_account",

        entry: [
          {
        id: "12345",

            changes: [
              {
          field: "history",

          value: {
            metadata: { phone_number_id: "98765" },

                  history: [
                    {
              metadata: { phase: 0, chunk_order: 0, progress: 100 },

                      threads: [
                        {
                id: "15551234567",

                context: { wa_id: "15551234567" },

                messages: [
                            {
                              id: "wamid.inbound",
                              from: "15551234567",
                              type: "text",
                              text: { body: "Mensagem antiga" },
                              timestamp: "1700000000",
                            },

                            {
                              id: "wamid.outbound",
                              from: "15550000000",
                              type: "text",
                              text: { body: "Resposta antiga" },
                              timestamp: "1700000001",
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "history-hash",
    )

    const messages = statements.filter((s) =>
      s.sql.includes("INSERT OR IGNORE INTO messages"),
    )

    expect(messages.map((message) => message.args[4])).toEqual([
      "inbound",
      "outbound",
    ])

    expect(messages.map((message) => message.args[6])).toEqual([
      "Mensagem antiga",
      "Resposta antiga",
    ])

    expect(
      statements
        .filter((s) => s.sql.includes("unread_count=unread_count+?"))
        .map((s) => s.args[2]),
    ).toEqual([0, 0])

    expect(
      statements.some((s) =>
        s.sql.includes("history_sync_status=CASE WHEN ?=100 THEN 'completed'"),
      ),
    ).toBe(true)

    expect(
      statements.some((s) =>
        s.sql.includes("UPDATE webhook_events SET status='failed'"),
      ),
    ).toBe(false)
  })

  it("marks the sync declined when the WhatsApp Business App denied history sharing", async () => {
    const { env, statements } = database()

    await handleMetaPayload(
      env,
      {
      object: "whatsapp_business_account",

        entry: [
          {
        id: "12345",

            changes: [
              {
          field: "history",

          value: {
            metadata: { phone_number_id: "98765" },

            errors: [{ code: 2593109 }],
          },
              },
            ],
          },
        ],
      },
      "declined-hash",
    )

    expect(
      statements.some((s) => s.sql.includes("history_sync_status='declined'")),
    ).toBe(true)
  })

  it("applies account updates to all integrations sharing a WABA", async () => {
    const { env, statements } = database()

    const originalPrepare = env.DB.prepare.bind(env.DB)

    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql)

      if (sql.includes("external_account_id=?")) {
        statement.all = async () =>
          ({
          results: [
            { id: "integration", organization_id: "org" },

            { id: "integration-2", organization_id: "org-2" },
          ],
        }) as never
      }

      return statement
    })

    await handleMetaPayload(
      env,
      {
      object: "whatsapp_business_account",

        entry: [
          {
            id: "12345",
            changes: [
              {
                field: "account_update",
                value: { event: "ACCOUNT_RESTRICTION" },
              },
            ],
          },
        ],
      },
      "hash",
    )

    const updates = statements.filter(
      (s) =>
        s.sql.includes("UPDATE integrations") &&
        s.sql.includes("status='error'"),
    )

    expect(updates).toHaveLength(2)

    expect(updates.map((s) => s.args.slice(-2))).toEqual([
      ["integration", "org"],
      ["integration-2", "org-2"],
    ])
  })
})
