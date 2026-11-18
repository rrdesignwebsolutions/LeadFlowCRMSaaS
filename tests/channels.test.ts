import { DatabaseSync } from "node:sqlite"

import { readdirSync, readFileSync } from "node:fs"

import { join } from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

import type { Env, Session } from "../worker/index"

import worker from "../worker/index"

import {
  gmailOAuthCallback,
  gmailRoutes,
  syncAllGmailAccounts,
} from "../worker/gmail"

import { replyToWebchat } from "../worker/ai"

import { webchatPublicRoutes, webchatRoutes } from "../worker/webchat"

import { decryptToken, encryptToken } from "../worker/whatsapp"

const encryptionKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))

function setup() {
  const db = new DatabaseSync(":memory:")

  for (const file of readdirSync("migrations")

    .filter((name) => name.endsWith(".sql"))

    .sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))

  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES
      ('org','Empresa','empresa'),('other','Outra','outra');
    INSERT INTO users(id,email,name,password_hash,password_salt) VALUES
      ('user','user@example.test','Usuário','hash','salt');
    INSERT INTO organization_members(organization_id,user_id,role)
      VALUES('org','user','admin');
  `)

  const DB = {
    prepare(sql: string) {
      let args: unknown[] = []

      return {
        bind(...values: unknown[]) {
          args = values

          return this
        },

        async first<T,>() {
          return (
            db.prepare(sql).get(...args as never[]) as T | undefined ?? null
          )
        },

        async all<T,>() {
          return { results: db.prepare(sql).all(...args as never[]) as T[] }
        },

        async run() {
          const result = db.prepare(sql).run(...args as never[])

          return { meta: { changes: Number(result.changes) } }
        },
      }
    },

    async batch(statements: Array<{ run(): Promise<unknown> }>) {
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
    DB,

    APP_ORIGIN: "https://avflow.example",

    GOOGLE_CLIENT_ID: "google-client-id",

    GOOGLE_CLIENT_SECRET: "google-client-secret",

    GOOGLE_REDIRECT_URI: "https://avflow.example/api/gmail/callback",

    ENCRYPTION_KEY: encryptionKey,
  } as unknown as Env

  const auth: Session = { userId: "user", organizationId: "org", role: "admin" }

  return { db, env, auth }
}

const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,

    headers: { "content-type": "application/json" },
  })

afterEach(() => {
  vi.restoreAllMocks()

  vi.unstubAllGlobals()
})

describe("widget do site", () => {
  it("não conclui um job de resposta quando a IA não está configurada", async () => {
    const { db, env } = setup()

    db.exec(`
      INSERT INTO webchat_settings(organization_id,public_key)
        VALUES('org','widget-key');
      INSERT INTO webchat_sessions(
        id,organization_id,public_key,visitor_token_hash,origin_domain,expires_at
      ) VALUES('session','org','widget-key','token-hash','shop.example',
        datetime('now','+1 day'));
      INSERT INTO webchat_messages(
        id,organization_id,session_id,direction,body
      ) VALUES('inbound','org','session','customer','Olá');
      INSERT INTO ai_settings(organization_id,enabled) VALUES('org',1);
    `)

    await expect(replyToWebchat(env, "org", "session", "inbound"))

      .rejects.toThrow("OPENAI_API_KEY não está configurada")

    db.close()
  })

  it("aplica a allowlist de domínio e inicia sessões/mensagens isoladas", async () => {
    const { db, env, auth } = setup()

    const settingsUrl = new URL("https://avflow.example/api/widget/settings")

    await webchatRoutes(new Request(settingsUrl), env, settingsUrl, auth)

    const settings = (await db

      .prepare(
        "SELECT public_key FROM webchat_settings WHERE organization_id='org'",
      )

      .get()) as { public_key: string }

    await webchatRoutes(
      new Request(settingsUrl, {
        method: "PUT",

        headers: { "content-type": "application/json" },

        body: JSON.stringify({
          enabled: true,

          displayName: "Atendimento",

          welcomeMessage: "Olá!",

          color: "#1769e0",

          allowedDomains: ["shop.example"],
        }),
      }),

      env,

      settingsUrl,

      auth,
    )

    const publicUrl = new URL(
      `https://avflow.example/api/widget/public/config?key=${settings.public_key}`,
    )

    const denied = await webchatPublicRoutes(
      new Request(publicUrl, { headers: { origin: "https://evil.example" } }),

      env,

      publicUrl,

      () => undefined,
    )

    expect(denied?.status).toBe(403)

    const origin = "https://shop.example"

    const sessionUrl = new URL(
      `https://avflow.example/api/widget/public/session?key=${settings.public_key}`,
    )

    const sessionResponse = await webchatPublicRoutes(
      new Request(sessionUrl, {
        method: "POST",

        headers: { origin, "content-type": "application/json" },

        body: "{}",
      }),

      env,

      sessionUrl,

      () => undefined,
    )

    expect(sessionResponse?.status).toBe(201)

    const created = (await sessionResponse!.json()) as {
      token: string
      sessionId: string
    }

    const messageUrl = new URL(
      `https://avflow.example/api/widget/public/messages?key=${settings.public_key}`,
    )

    const routedResponse = await worker.fetch(
      new Request(publicUrl, { headers: { origin } }),

      env,

      { waitUntil: () => undefined } as unknown as ExecutionContext,
    )

    expect(routedResponse.status).toBe(200)

    expect(routedResponse.headers.get("access-control-allow-origin")).toBe(
      origin,
    )

    const messageResponse = await webchatPublicRoutes(
      new Request(messageUrl, {
        method: "POST",

        headers: {
          origin,

          authorization: `Bearer ${created.token}`,

          "content-type": "application/json",
        },

        body: JSON.stringify({ text: "Quero saber mais" }),
      }),

      env,

      messageUrl,

      () => undefined,
    )

    expect(messageResponse?.status).toBe(201)

    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM webchat_messages WHERE session_id=?",
        )

        .get(created.sessionId),
    ).toEqual({ count: 1 })

    expect(
      db
        .prepare("SELECT organization_id FROM webchat_sessions WHERE id=?")

        .get(created.sessionId),
    ).toEqual({ organization_id: "org" })

    db.close()
  })
})

describe("integração Gmail", () => {
  it("usa state OAuth de uso único e armazena tokens criptografados", async () => {
    const { db, env, auth } = setup()

    const connectUrl = new URL("https://avflow.example/api/gmail/connect")

    const connect = await gmailRoutes(
      new Request(connectUrl),

      env,

      connectUrl,

      auth,
    )

    expect(connect?.status).toBe(302)

    const state = new URL(connect!.headers.get("location")!).searchParams.get(
      "state",
    )!

    vi.stubGlobal(
      "fetch",
      vi
        .fn()

        .mockResolvedValueOnce(
          response({
            access_token: "access-secret",

            refresh_token: "refresh-secret",

            expires_in: 3600,
          }),
        )

        .mockResolvedValueOnce(
          response({
            emailAddress: "team@example.test",

            historyId: "history-1",
          }),
        ),
    )

    const callbackUrl = new URL(
      `https://avflow.example/api/gmail/callback?code=one-time-code&state=${state}`,
    )

    const callback = await gmailOAuthCallback(
      new Request(callbackUrl),

      env,

      callbackUrl,
    )

    expect(callback?.status).toBe(303)

    expect(callback?.headers.get("location")).toContain("gmail=connected")

    const account = db
      .prepare(
        "SELECT email,access_token_enc,refresh_token_enc FROM gmail_accounts WHERE organization_id='org'",
      )
      .get() as {
      email: string
      access_token_enc: string
      refresh_token_enc: string
    }

    expect(account.email).toBe("team@example.test")

    expect(account.access_token_enc).not.toContain("access-secret")

    expect(account.refresh_token_enc).not.toContain("refresh-secret")

    expect(await decryptToken(env, account.access_token_enc)).toBe(
      "access-secret",
    )

    expect(await decryptToken(env, account.refresh_token_enc)).toBe(
      "refresh-secret",
    )

    const repeated = await gmailOAuthCallback(
      new Request(callbackUrl),

      env,

      callbackUrl,
    )

    expect(repeated?.headers.get("location")).toContain("gmail=error")

    db.close()
  })

  it("percorre páginas da inbox sem duplicar mensagens", async () => {
    const { db, env } = setup()

    const access = await encryptToken(env, "access-secret")

    const refresh = await encryptToken(env, "refresh-secret")

    db.prepare(
      `INSERT INTO gmail_accounts(
        organization_id,email,access_token_enc,refresh_token_enc,token_expires_at,
        history_id,status
      ) VALUES('org','team@example.test',?,?,?,'history-1','connected')`,
    ).run(access, refresh, new Date(Date.now() + 3_600_000).toISOString())

    const message = (id: string, threadId: string, sender: string) => ({
      id,

      threadId,

      internalDate: String(Date.now()),

      labelIds: ["INBOX", "UNREAD"],

      snippet: `Snippet ${id}`,

      payload: {
        mimeType: "text/plain",

        headers: [
          { name: "From", value: `Cliente <${sender}>` },

          { name: "To", value: "team@example.test" },

          { name: "Subject", value: `Assunto ${id}` },
        ],

        body: {
          data: btoa(`Corpo ${id}`)
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, ""),
        },
      },
    })

    const fetchMock = vi
      .fn()

      .mockResolvedValueOnce(
        response({
          messages: [{ id: "message-1" }],

          nextPageToken: "page-2",
        }),
      )

      .mockResolvedValueOnce(
        response(message("message-1", "thread-1", "a@example.test")),
      )

      .mockResolvedValueOnce(
        response({
          messages: [{ id: "message-2" }],
        }),
      )

      .mockResolvedValueOnce(
        response(message("message-2", "thread-2", "b@example.test")),
      )

    vi.stubGlobal("fetch", fetchMock)

    await syncAllGmailAccounts(env)

    await syncAllGmailAccounts(env)

    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM email_messages WHERE organization_id='org'",
        )

        .get(),
    ).toEqual({ count: 2 })

    expect(
      db
        .prepare(
          "SELECT initial_sync_done FROM gmail_accounts WHERE organization_id='org'",
        )

        .get(),
    ).toEqual({ initial_sync_done: 1 })

    expect(
      db
        .prepare(
          "SELECT unread_count FROM email_threads WHERE gmail_thread_id='thread-1'",
        )

        .get(),
    ).toEqual({ unread_count: 1 })

    db.close()
  })

  it("responde apenas a threads da própria empresa e registra o envio aceito", async () => {
    const { db, env, auth } = setup()

    const access = await encryptToken(env, "access-secret")

    const refresh = await encryptToken(env, "refresh-secret")

    db.prepare(
      `INSERT INTO gmail_accounts(
        organization_id,email,access_token_enc,refresh_token_enc,token_expires_at,status
      ) VALUES('org','team@example.test',?,?,?,'connected')`,
    ).run(access, refresh, new Date(Date.now() + 3_600_000).toISOString())

    db.prepare(
      `INSERT INTO email_threads(id,organization_id,gmail_thread_id,subject,from_address,last_message_at)
       VALUES('thread','org','gmail-thread','Dúvida','customer@example.test',CURRENT_TIMESTAMP)`,
    ).run()

    db.prepare(
      `INSERT INTO email_messages(
        id,organization_id,thread_id,gmail_message_id,direction,from_address,
        to_address,subject,body,rfc_message_id,created_at
      ) VALUES('inbound','org','thread','gmail-message','inbound',
        'customer@example.test','team@example.test','Dúvida','Olá','<id@example.test>',CURRENT_TIMESTAMP)`,
    ).run()

    const fetchMock = vi.fn().mockResolvedValueOnce(
      response({
        id: "sent-message",

        threadId: "gmail-thread",
      }),
    )

    vi.stubGlobal("fetch", fetchMock)

    const url = new URL(
      "https://avflow.example/api/gmail/threads/thread/messages",
    )

    const result = await gmailRoutes(
      new Request(url, {
        method: "POST",

        headers: { "content-type": "application/json" },

        body: JSON.stringify({ body: "Minha resposta" }),
      }),

      env,

      url,

      auth,
    )

    expect(result?.status).toBe(201)

    expect(
      db
        .prepare(
          "SELECT direction,body,status FROM email_messages WHERE gmail_message_id='sent-message'",
        )
        .get(),
    ).toEqual({
      direction: "outbound",

      body: "Minha resposta",

      status: "accepted",
    })

    db.prepare(
      `INSERT INTO email_threads(id,organization_id,gmail_thread_id,subject,from_address,last_message_at)
       VALUES('other-thread','other','other-gmail-thread','Outro','other@example.test',CURRENT_TIMESTAMP)`,
    ).run()

    const otherUrl = new URL(
      "https://avflow.example/api/gmail/threads/other-thread/messages",
    )

    const isolated = await gmailRoutes(
      new Request(otherUrl),

      env,

      otherUrl,

      auth,
    )

    expect(isolated?.status).toBe(404)

    db.close()
  })
})
