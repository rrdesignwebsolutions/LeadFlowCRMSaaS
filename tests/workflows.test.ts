import { DatabaseSync } from "node:sqlite"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Env, Session } from "../worker/index"
import {
  executeInboundWorkflows,
  workflowRoutes,
} from "../worker/workflows"
import {
  DEFAULT_WORKFLOW,
  validateWorkflowDefinition,
} from "../worker/workflow-model"

function setup() {
  const db = new DatabaseSync(":memory:")
  for (const file of readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join("migrations", file), "utf8"))
  db.exec(`
    INSERT INTO organizations(id,name,slug) VALUES
      ('org','GoO','goo'),('other','Outra','outra');
    INSERT INTO users(id,email,name,password_hash,password_salt) VALUES
      ('admin','admin@example.com','Admin','hash','salt');
    INSERT INTO organization_members(organization_id,user_id,role)
      VALUES('org','admin','admin');
    INSERT INTO contacts(id,organization_id,phone_e164,name)
      VALUES('contact','org','15551234567','Cliente');
    INSERT INTO integrations(id,organization_id,provider)
      VALUES('integration','org','meta_whatsapp');
    INSERT INTO conversations(id,organization_id,contact_id,integration_id)
      VALUES('conversation','org','contact','integration');
    INSERT INTO leads(id,organization_id,contact_id,status)
      VALUES('lead','org','contact','new');
    INSERT INTO messages(
      id,organization_id,conversation_id,external_id,direction,type,body,status
    ) VALUES('message','org','conversation','inbound-1','inbound','text',
      'Quero saber sobre financiamento','received');
  `)
  const env = {
    DB: {
      prepare(sql: string) {
        let args: unknown[] = []
        return {
          bind(...values: unknown[]) {
            args = values
            return this
          },
          async first() {
            return db.prepare(sql).get(...(args as never[])) ?? null
          },
          async all() {
            return { results: db.prepare(sql).all(...(args as never[])) }
          },
          async run() {
            const result = db.prepare(sql).run(...(args as never[]))
            return { meta: { changes: Number(result.changes) } }
          },
        }
      },
    },
  } as unknown as Env
  const auth: Session = { userId: "admin", organizationId: "org", role: "admin" }
  const call = (path: string, method: string, body?: unknown, session = auth) => {
    const url = new URL(`https://example.com/api/workflows${path}`)
    const request = new Request(url, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    })
    return workflowRoutes(request, env, url, session)
  }
  return { db, env, auth, call }
}

describe("validação de fluxos", () => {
  it("aceita o gatilho inicial e rejeita ciclos, nós desconectados e condições incompletas", () => {
    expect(validateWorkflowDefinition(DEFAULT_WORKFLOW).definition).toBeTruthy()
    expect(
      validateWorkflowDefinition({
        nodes: [
          { id: "trigger", type: "trigger", kind: "message_received", config: {} },
          { id: "action", type: "action", kind: "stop", config: {} },
        ],
        edges: [{ id: "a", source: "trigger", target: "action" }, { id: "b", source: "action", target: "trigger" }],
      }).error,
    ).toContain("ciclos")
    expect(
      validateWorkflowDefinition({
        nodes: [
          { id: "trigger", type: "trigger", kind: "message_received", config: {} },
          { id: "action", type: "action", kind: "stop", config: {} },
        ],
        edges: [],
      }).error,
    ).toContain("conectados")
    expect(
      validateWorkflowDefinition({
        nodes: [
          { id: "trigger", type: "trigger", kind: "message_received", config: {} },
          { id: "condition", type: "condition", kind: "is_priority", config: {} },
          { id: "yes", type: "action", kind: "stop", config: {} },
          { id: "no", type: "action", kind: "stop", config: {} },
        ],
        edges: [
          { id: "a", source: "trigger", target: "condition" },
          { id: "b", source: "condition", target: "yes", sourceHandle: "true" },
          { id: "c", source: "condition", target: "no", sourceHandle: "true" },
        ],
      }).error,
    ).toContain("verdadeiro e falso")
  })
})

describe("API de fluxos", () => {
  it("cria o modelo VIP inicial apenas quando a organização ainda não tem fluxos", async () => {
    const { db, call } = setup()

    expect((await call("/starter", "POST"))?.status).toBe(201)
    expect((await call("/starter", "POST"))?.status).toBe(200)
    expect(
      db.prepare("SELECT COUNT(*) count FROM workflows WHERE organization_id='org'").get(),
    ).toMatchObject({ count: 1 })

    const row = db
      .prepare("SELECT name,draft_json FROM workflows WHERE organization_id='org'")
      .get() as { name: string; draft_json: string }
    expect(row.name).toBe("VIP Routing")
    expect(JSON.parse(row.draft_json)).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "vip-condition", kind: "is_priority" }),
        expect.objectContaining({ id: "vip-note", kind: "private_note" }),
        expect.objectContaining({ id: "standard-ai", kind: "reply_with_ai" }),
      ]),
    })
    db.close()
  })

  it("cria, publica, simula sem efeitos e mantém isolamento por organização", async () => {
    const { db, call } = setup()
    const created = await call("", "POST", {
      name: "Primeiro atendimento",
      definition: DEFAULT_WORKFLOW,
    })
    expect(created?.status).toBe(201)
    const { id } = (await created!.json()) as { id: string }

    const published = await call(`/${id}/publish`, "POST")
    expect(published?.status).toBe(200)
    expect(
      db.prepare("SELECT status,version FROM workflows WHERE id=?").get(id),
    ).toMatchObject({ status: "active", version: 1 })

    const simulated = await call(`/${id}/test`, "POST", { message: "oi" })
    expect(await simulated?.json()).toMatchObject({
      mode: "simulation",
      sideEffects: false,
      matched: true,
    })
    const vipPreview = await call(`/${id}/test`, "POST", {
      message: "oi",
      priority: true,
    })
    expect((await vipPreview?.json()).steps.map((step: { id: string }) => step.id)).toEqual([
      "trigger-message",
      "vip-condition",
      "vip-note",
    ])
    const standardPreview = await call(`/${id}/test`, "POST", {
      message: "oi",
      priority: false,
    })
    expect((await standardPreview?.json()).steps.map((step: { id: string }) => step.id)).toEqual([
      "trigger-message",
      "vip-condition",
      "standard-ai",
    ])
    expect(db.prepare("SELECT COUNT(*) count FROM workflow_runs").get()).toMatchObject({ count: 0 })

    const other: Session = { userId: "admin", organizationId: "other", role: "admin" }
    expect((await call(`/${id}`, "GET", undefined, other))?.status).toBe(404)
    db.close()
  })
})

describe("execução de fluxos", () => {
  it("envia uma mensagem aceita uma única vez para a mesma mensagem de entrada", async () => {
    const { db, env } = setup()
    const definition = {
      nodes: [
        { id: "trigger", type: "trigger", kind: "message_received", config: {} },
        { id: "reply", type: "action", kind: "send_message", config: { text: "Olá {{contact.name}}" } },
      ],
      edges: [{ id: "edge", source: "trigger", target: "reply" }],
    }
    db.prepare(
      `INSERT INTO workflows(
        id,organization_id,name,status,draft_json,published_json,version
      ) VALUES('workflow','org','Teste','active',?,?,1)`,
    ).run(JSON.stringify(definition), JSON.stringify(definition))
    let sendCount = 0
    const hooks = {
      async sendMessage(text: string, key: string) {
        expect(text).toBe("Olá Cliente")
        expect(key).toContain("workflow:")
        sendCount += 1
      },
    }

    expect(
      await executeInboundWorkflows(env, "org", "conversation", "inbound-1", hooks),
    ).toMatchObject({ matched: true, sentMessage: true })
    await executeInboundWorkflows(env, "org", "conversation", "inbound-1", hooks)
    expect(sendCount).toBe(1)
    expect(db.prepare("SELECT status FROM workflow_runs").get()).toMatchObject({ status: "completed" })
    expect(db.prepare("SELECT status FROM workflow_run_steps WHERE node_id='reply'").get()).toMatchObject({ status: "completed" })
    db.close()
  })
})
