import { describe, expect, it, vi } from "vitest"

import type { Env } from "../worker/index"

import {
  handleMetaPayload,
  isWithinCustomerServiceWindow,
} from "../worker/whatsapp"

function database(duplicateMessage: { conversation_id: string } | null = null) {
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

          if (sql.startsWith("SELECT conversation_id FROM messages"))
            return duplicateMessage

          if (sql.startsWith("SELECT conversation_id conversationId FROM messages"))
            return { conversationId: "conversation" }

          if (sql.includes("SELECT id,status FROM messages"))
            return { id: "stored-message", status: "accepted" }

          if (sql.includes("FROM whatsapp_processing_jobs"))
            return statements.some((statement) =>
              statement.sql.includes(
                "INSERT OR IGNORE INTO whatsapp_processing_jobs",
              ),
            )
              ? { id: "processing-job" }
              : null

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

    expect(message?.args[5]).toBe(expected)

    expect(message?.args[11]).toBe(String(code))

    expect(message?.args[13]).toBe(0)

      expect(
        statements.find((s) => s.sql.includes("unread_count=unread_count+?"))
          ?.args[2],
      ).toBe(1)

    const jobInsert = statements.some((s) =>
      s.sql.includes("INSERT OR IGNORE INTO whatsapp_processing_jobs"),
    )
    expect(jobInsert).toBe(code === 131060)
    if (code === 131060) expect(after).toHaveBeenCalledOnce()
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

    expect(message?.args[11]).toBe("999")

    expect(message?.args[5]).toBe(
      "[A Meta não enviou o conteúdo desta mensagem ao AV Flow. Consulte-a no WhatsApp Business; a Meta pode não reenviá-la.]",
    )
  })

  it("explica quando a Meta não compartilha o conteúdo da mensagem (131060)", async () => {
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
      after,
    )

    const message = statements.find((s) =>
      s.sql.includes("INSERT OR IGNORE INTO messages"),
    )

    expect(message?.args[5]).toContain("Abra o WhatsApp Business")

    expect(message?.args[5]).toContain("não enviará esse conteúdo novamente")

    expect(message?.args[11]).toBe("131060")

    expect(
      statements.some((statement) =>
        statement.sql.includes("INSERT OR IGNORE INTO whatsapp_processing_jobs"),
      ),
    ).toBe(true)
    expect(after).toHaveBeenCalledOnce()
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

    expect(message?.args[3]).toBe("inbound")
    expect(message?.args[4]).toBe("interactive")
    expect(message?.args[5]).toContain("nome: Lavínia")
    expect(message?.args[5]).toContain("Dê continuidade ao atendimento")
    expect(message?.args[5]).not.toContain("do-not-store")
    expect(message?.args[13]).toBe(1)
    expect(
      statements.some((statement) =>
        statement.sql.includes("INSERT OR IGNORE INTO whatsapp_processing_jobs"),
      ),
    ).toBe(true)

    expect(after).toHaveBeenCalledTimes(1)
  })

  it("persists Click-to-WhatsApp text together with its referral and context", async () => {
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
                      id: "wamid.click-to-whatsapp",
                      from: "15551234567",
                      type: "text",
                      text: { body: "Olá, quero mais informações." },
                      referral: {
                        source_url: "https://example.test/ad",
                        source_id: "ad-123",
                        source_type: "ad",
                        headline: "Oferta",
                        body: "Mensagem do anúncio",
                      },
                      context: {
                        from: "15557654321",
                        id: "wamid.parent",
                        forwarded: true,
                      },
                      timestamp: String(Math.floor(Date.now() / 1000)),
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "ctwa-message-hash",
      after,
    )

    const message = statements.find((statement) =>
      statement.sql.includes("INSERT OR IGNORE INTO messages"),
    )
    expect(message?.args[5]).toBe("Olá, quero mais informações.")
    expect(message?.args[13]).toBe(1)
    expect(JSON.parse(String(message?.args[14]))).toMatchObject({
      source_id: "ad-123",
      source_type: "ad",
      headline: "Oferta",
    })
    expect(JSON.parse(String(message?.args[15]))).toMatchObject({
      forwarded: true,
      id: "wamid.parent",
    })
    expect(after).toHaveBeenCalledOnce()
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
    expect(
      statements.some((statement) =>
        statement.sql.includes(
          "UPDATE catalog_delivery_batches SET delivery_status=?",
        ),
      ),
    ).toBe(true)
    expect(
      statements.some((statement) =>
        statement.sql.includes("UPDATE catalog_delivery_jobs SET delivery_status=CASE"),
      ),
    ).toBe(true)
  })

  it.each(["sent", "delivered", "read"] as const)(
    "propagates the Meta %s status to the catalog batch",
    async (status) => {
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
                    statuses: [{ id: "wamid.outbound", status }],
                  },
                },
              ],
            },
          ],
        },
        `status-${status}`,
      )

      expect(
        statements.some(
          (statement) =>
            statement.sql.includes(
              "UPDATE catalog_delivery_batches SET delivery_status=?",
            ) && statement.args[0] === status,
        ),
      ).toBe(true)
    },
  )

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
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "98765" },
                  messages: [
                    {
                      id: "wamid.customer-edit-event",
                      from: "15551234567",
                      type: "edit",
                      edit: {
                        original_message_id: "wamid.customer-original",
                        message: {
                          type: "text",
                          text: { body: "Texto corrigido pelo cliente" },
                        },
                      },
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

    expect(
      statements.some((statement) =>
        statement.sql.includes("SET ai_state='HUMANO'"),
      ),
    ).toBe(true)

    expect(after).not.toHaveBeenCalled()
  })

  it("pauses AI when a redelivered app echo matches an existing message", async () => {
    const { env, statements } = database({ conversation_id: "conversation" })

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
                      id: "wamid.duplicate-echo",
                      to: "15551234567",
                      type: "text",
                      text: { body: "Vou assumir o atendimento" },
                      timestamp: "1700000000",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "duplicate-echo-hash",
    )

    expect(
      statements.some((statement) =>
        statement.sql.includes("SET ai_state='HUMANO'"),
      ),
    ).toBe(true)
  })

  it("applies edits and revocations from WhatsApp Business echoes to the original outbound message", async () => {
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
                field: "smb_message_echoes",
                value: {
                  metadata: { phone_number_id: "98765" },
                  message_echoes: [
                    {
                      id: "wamid.edit-event",
                      to: "15551234567",
                      type: "edit",
                      edit: {
                        original_message_id: "wamid.original-edit",
                        message: {
                          type: "image",
                          image: {
                            id: "media-edited",
                            caption: "Legenda corrigida",
                            mime_type: "image/jpeg",
                          },
                        },
                      },
                    },
                    {
                      id: "wamid.revoke-event",
                      to: "15551234567",
                      type: "revoke",
                      revoke: { original_message_id: "wamid.original-revoke" },
                    },
                  ],
                },
              },
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "98765" },
                  messages: [
                    {
                      id: "wamid.customer-edit-event",
                      from: "15551234567",
                      type: "edit",
                      edit: {
                        original_message_id: "wamid.customer-original",
                        message: {
                          type: "text",
                          text: { body: "Texto corrigido pelo cliente" },
                        },
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "edit-revoke-hash",
    )

    const edit = statements.find((statement) =>
      statement.sql.includes("UPDATE messages SET type=?,body=?"),
    )
    expect(edit?.args[0]).toBe("image")
    expect(edit?.args[1]).toContain("Legenda corrigida")
    expect(edit?.args[7]).toBe("wamid.original-edit")

    const revoke = statements.find((statement) =>
      statement.sql.includes("Mensagem apagada no WhatsApp Business."),
    )
    expect(revoke?.args).toContain("wamid.original-revoke")

    const customerEdit = statements.find(
      (statement) =>
        statement.sql.includes("UPDATE messages SET type=?,body=?") &&
        statement.args[7] === "wamid.customer-original",
    )
    expect(customerEdit?.args[0]).toBe("text")
    expect(customerEdit?.args[1]).toBe("Texto corrigido pelo cliente")
    expect(customerEdit?.args[8]).toBe("inbound")
    expect(
      statements.some((statement) =>
        statement.sql.includes("INSERT OR IGNORE INTO messages"),
      ),
    ).toBe(false)
  })

  it("synchronizes WhatsApp Business App contacts by BSUID without inventing phone numbers", async () => {
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
                field: "smb_app_state_sync",
                value: {
                  state_sync: [
                    {
                      type: "contact",
                      action: "add",
                      contact: {
                        user_id: "US.123456789",
                        phone_number: "15551234567",
                        full_name: "Contato sincronizado",
                      },
                    },
                    {
                      type: "contact",
                      action: "remove",
                      contact: { user_id: "US.987654321" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      "app-state-sync-hash",
    )

    const contacts = statements.filter((statement) =>
      statement.sql.includes("INSERT INTO whatsapp_business_app_contacts"),
    )
    expect(contacts).toHaveLength(2)
    expect(contacts[0]?.args.slice(2, 8)).toEqual([
      "US.123456789",
      null,
      null,
      "+15551234567",
      "Contato sincronizado",
      null,
    ])
    expect(contacts[0]?.args[8]).toBe(0)
    expect(contacts[1]?.args[2]).toBe("US.987654321")
    expect(contacts[1]?.args[5]).toBeNull()
    expect(contacts[1]?.args[8]).toBe(1)
    expect(
      statements.some((statement) =>
        statement.sql.includes("status='ignored'"),
      ),
    ).toBe(false)
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

    expect(messages.map((message) => message.args[3])).toEqual([
      "inbound",
      "outbound",
    ])

    expect(messages.map((message) => message.args[5])).toEqual([
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

  it("applies account updates to integrations in the same tenant", async () => {
    const { env, statements } = database()

    const originalPrepare = env.DB.prepare.bind(env.DB)

    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const statement = originalPrepare(sql)

      if (sql.includes("external_account_id=?")) {
        statement.all = async () =>
          ({
          results: [
            { id: "integration", organization_id: "org" },

            { id: "integration-2", organization_id: "org" },
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
      ["integration-2", "org"],
    ])
  })
})
