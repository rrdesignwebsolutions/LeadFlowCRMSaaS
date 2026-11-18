import type { Env, Session } from "./index"
import {
  DEFAULT_WORKFLOW,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
  validateWorkflowDefinition,
} from "./workflow-model"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })

const uid = () => crypto.randomUUID()
const canEdit = (auth: Session) =>
  auth.role === "admin" || auth.role === "manager"

type WorkflowRecord = {
  id: string
  name: string
  description: string
  status: "draft" | "active" | "blocked"
  draft_json: string
  published_json: string | null
  version: number
  updated_at: string
}

type RuntimeContext = {
  message: string
  messageType: string
  leadStatus: string
  priority: boolean
  humanRequested: boolean
  hasFollowUp: boolean
  contactName: string | null
}

export type WorkflowHooks = {
  sendMessage: (text: string, idempotencyKey: string) => Promise<void>
}

const parse = (value: string): WorkflowDefinition | null => {
  try {
    const result = validateWorkflowDefinition(JSON.parse(value))
    return result.definition ?? null
  } catch {
    return null
  }
}

const asText = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : ""

function interpolate(template: string, context: RuntimeContext) {
  return template
    .replaceAll("{{contact.name}}", context.contactName ?? "Olá")
    .replaceAll("{{lead.status}}", context.leadStatus)
    .replaceAll("{{message.text}}", context.message)
}

function triggerMatches(node: WorkflowNode, context: RuntimeContext) {
  if (node.kind === "message_received") return true
  if (node.kind === "button_reply")
    return context.messageType === "button" || context.messageType === "interactive"
  const phrase = asText(node.config.text, 200).toLocaleLowerCase("pt-BR")
  return !!phrase && context.message.toLocaleLowerCase("pt-BR").includes(phrase)
}

function conditionMatches(node: WorkflowNode, context: RuntimeContext) {
  if (node.kind === "message_contains") {
    const phrase = asText(node.config.text, 200).toLocaleLowerCase("pt-BR")
    return !!phrase && context.message.toLocaleLowerCase("pt-BR").includes(phrase)
  }
  if (node.kind === "lead_status") return context.leadStatus === node.config.status
  if (node.kind === "is_priority") return context.priority
  if (node.kind === "human_requested") return context.humanRequested
  if (node.kind === "has_follow_up") return context.hasFollowUp
  return false
}

function nextEdge(
  node: WorkflowNode,
  edges: WorkflowEdge[],
  condition?: boolean,
) {
  const outgoing = edges.filter((edge) => edge.source === node.id)
  if (node.type !== "condition") return outgoing[0]
  return outgoing.find((edge) => edge.sourceHandle === (condition ? "true" : "false"))
}

async function loadRuntimeContext(
  env: Env,
  organizationId: string,
  conversationId: string,
  inboundExternalId: string,
): Promise<RuntimeContext | null> {
  const row = await env.DB.prepare(
    `SELECT m.body message,m.type messageType,l.status leadStatus,c.priority,
       c.human_requested_at humanRequestedAt,l.follow_up_at followUpAt,ct.name contactName
     FROM messages m
     JOIN conversations c ON c.id=m.conversation_id AND c.organization_id=m.organization_id
     JOIN contacts ct ON ct.id=c.contact_id AND ct.organization_id=c.organization_id
     JOIN leads l ON l.contact_id=c.contact_id AND l.organization_id=c.organization_id
     WHERE m.organization_id=? AND m.conversation_id=? AND m.external_id=?
       AND m.direction='inbound'`,
  )
    .bind(organizationId, conversationId, inboundExternalId)
    .first<{
      message: string | null
      messageType: string
      leadStatus: string
      priority: number
      humanRequestedAt: string | null
      followUpAt: string | null
      contactName: string | null
    }>()
  if (!row) return null
  return {
    message: row.message ?? "",
    messageType: row.messageType,
    leadStatus: row.leadStatus,
    priority: row.priority === 1,
    humanRequested: !!row.humanRequestedAt,
    hasFollowUp: !!row.followUpAt,
    contactName: row.contactName,
  }
}

async function writeStep(
  env: Env,
  organizationId: string,
  runId: string,
  node: WorkflowNode,
  status: "running" | "completed" | "failed" | "skipped",
  details: unknown = null,
  error?: string,
) {
  await env.DB.prepare(
    `INSERT INTO workflow_run_steps(
       id,organization_id,run_id,node_id,node_type,status,details_json,error_summary
     ) VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(run_id,node_id) DO UPDATE SET
       status=excluded.status,details_json=excluded.details_json,
       error_summary=excluded.error_summary,updated_at=CURRENT_TIMESTAMP`,
  )
    .bind(
      `${runId}:${node.id}`,
      organizationId,
      runId,
      node.id,
      node.type,
      status,
      details === null ? null : JSON.stringify(details).slice(0, 5000),
      error?.slice(0, 500) ?? null,
    )
    .run()
}

async function runWorkflow(
  env: Env,
  organizationId: string,
  conversationId: string,
  inboundExternalId: string,
  workflow: WorkflowRecord,
  definition: WorkflowDefinition,
  context: RuntimeContext,
  hooks: WorkflowHooks,
) {
  const root = definition.nodes.find((node) => node.type === "trigger")
  if (!root || !triggerMatches(root, context)) return null

  const runId = uid()
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO workflow_runs(
       id,organization_id,workflow_id,conversation_id,inbound_external_id,status
     ) VALUES(?,?,?,?,?,'running')`,
  )
    .bind(
      runId,
      organizationId,
      workflow.id,
      conversationId,
      inboundExternalId,
    )
    .run()

  if (!inserted.meta.changes) {
    const prior = await env.DB.prepare(
      `SELECT id,status FROM workflow_runs
       WHERE organization_id=? AND workflow_id=? AND inbound_external_id=?`,
    )
      .bind(organizationId, workflow.id, inboundExternalId)
      .first<{ id: string; status: string }>()
    if (!prior || prior.status === "completed" || prior.status === "running")
      return null
    await env.DB.prepare(
      `UPDATE workflow_runs SET status='running',error_summary=NULL,
       started_at=CURRENT_TIMESTAMP,completed_at=NULL WHERE id=? AND organization_id=?`,
    )
      .bind(prior.id, organizationId)
      .run()
    return executeWorkflow(
      env,
      organizationId,
      conversationId,
      workflow,
      definition,
      context,
      hooks,
      prior.id,
      root,
    )
  }

  return executeWorkflow(
    env,
    organizationId,
    conversationId,
    workflow,
    definition,
    context,
    hooks,
    runId,
    root,
  )
}

async function executeWorkflow(
  env: Env,
  organizationId: string,
  conversationId: string,
  workflow: WorkflowRecord,
  definition: WorkflowDefinition,
  context: RuntimeContext,
  hooks: WorkflowHooks,
  runId: string,
  root: WorkflowNode,
) {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]))
  let node: WorkflowNode | undefined = root
  let sentMessage = false
  let assignedHuman = false
  let reachedAI = false
  let count = 0

  try {
    while (node && count++ < 40) {
      const prior = await env.DB.prepare(
        `SELECT status FROM workflow_run_steps
         WHERE organization_id=? AND run_id=? AND node_id=?`,
      )
        .bind(organizationId, runId, node.id)
        .first<{ status: string }>()
      if (prior?.status === "completed") {
        const condition = node.type === "condition"
          ? await env.DB.prepare(
              `SELECT details_json FROM workflow_run_steps
               WHERE organization_id=? AND run_id=? AND node_id=?`,
            )
              .bind(organizationId, runId, node.id)
              .first<{ details_json: string | null }>()
              .then((result) => {
                try {
                  return !!JSON.parse(result?.details_json ?? "{}").matched
                } catch {
                  return false
                }
              })
          : undefined
        node = byId.get(nextEdge(node, definition.edges, condition)?.target ?? "")
        continue
      }

      await writeStep(env, organizationId, runId, node, "running")
      if (node.type === "condition") {
        const matched = conditionMatches(node, context)
        await writeStep(env, organizationId, runId, node, "completed", { matched })
        node = byId.get(nextEdge(node, definition.edges, matched)?.target ?? "")
        continue
      }
      if (node.type === "trigger") {
        await writeStep(env, organizationId, runId, node, "completed", {
          matched: true,
        })
      } else if (node.kind === "send_message") {
        const text = interpolate(asText(node.config.text, 4096), context)
        await hooks.sendMessage(text, `workflow:${runId}:${node.id}`)
        sentMessage = true
        await writeStep(env, organizationId, runId, node, "completed", {
          accepted: true,
        })
      } else if (node.kind === "private_note") {
        const body = interpolate(asText(node.config.text, 2000), context)
        await env.DB.prepare(
          `INSERT OR IGNORE INTO workflow_notes(
             id,organization_id,conversation_id,workflow_id,run_id,node_id,body
           ) VALUES(?,?,?,?,?,?,?)`,
        )
          .bind(
            `${runId}:${node.id}`,
            organizationId,
            conversationId,
            workflow.id,
            runId,
            node.id,
            body,
          )
          .run()
        await writeStep(env, organizationId, runId, node, "completed", {
          note: body,
        })
      } else if (node.kind === "update_lead") {
        const lead = await env.DB.prepare(
          `SELECT l.id FROM leads l
           JOIN conversations c ON c.contact_id=l.contact_id AND c.organization_id=l.organization_id
           WHERE c.id=? AND c.organization_id=?`,
        )
          .bind(conversationId, organizationId)
          .first<{ id: string }>()
        if (!lead) throw new Error("O lead da conversa não foi encontrado.")
        await env.DB.prepare(
          `UPDATE leads SET
             status=COALESCE(?,status),
             product_interest=COALESCE(?,product_interest),
             next_action=COALESCE(?,next_action),
             follow_up_at=CASE WHEN ? IS NULL THEN follow_up_at
               ELSE datetime('now','+'||?||' days') END,
             updated_at=CURRENT_TIMESTAMP
           WHERE id=? AND organization_id=?`,
        )
          .bind(
            typeof node.config.status === "string" ? node.config.status : null,
            asText(node.config.productInterest, 160) || null,
            asText(node.config.nextAction, 300) || null,
            typeof node.config.followUpDays === "number"
              ? node.config.followUpDays
              : null,
            typeof node.config.followUpDays === "number"
              ? node.config.followUpDays
              : null,
            lead.id,
            organizationId,
          )
          .run()
        await writeStep(env, organizationId, runId, node, "completed", {
          leadUpdated: true,
        })
      } else if (node.kind === "set_priority") {
        const priority = node.config.enabled !== false
        await env.DB.prepare(
          "UPDATE conversations SET priority=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
        )
          .bind(priority ? 1 : 0, conversationId, organizationId)
          .run()
        await writeStep(env, organizationId, runId, node, "completed", {
          priority,
        })
      } else if (node.kind === "assign_to_human") {
        const assigneeId = asText(node.config.assigneeId, 80)
        if (assigneeId) {
          const member = await env.DB.prepare(
            `SELECT 1 FROM organization_members
             WHERE organization_id=? AND user_id=? AND status='active'`,
          )
            .bind(organizationId, assigneeId)
            .first()
          if (!member)
            throw new Error("O responsável não pertence a esta empresa ou está inativo.")
          await env.DB.prepare(
            `UPDATE conversations SET assigned_to=?,ai_state='HUMANO',
             assignment_revision=assignment_revision+1,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND organization_id=?`,
          )
            .bind(assigneeId, conversationId, organizationId)
            .run()
          assignedHuman = true
        } else {
          await env.DB.prepare(
            `UPDATE conversations SET human_requested_at=COALESCE(human_requested_at,CURRENT_TIMESTAMP),
             updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
          )
            .bind(conversationId, organizationId)
            .run()
        }
        await writeStep(env, organizationId, runId, node, "completed", {
          assigned: !!assigneeId,
        })
      } else if (node.kind === "reply_with_ai") {
        reachedAI = true
        await writeStep(env, organizationId, runId, node, "completed", {
          delegatedToAI: true,
        })
      } else if (node.kind === "stop") {
        await writeStep(env, organizationId, runId, node, "completed", {
          stopped: true,
        })
        break
      }
      node = byId.get(nextEdge(node, definition.edges)?.target ?? "")
    }

    if (count > 40) throw new Error("O fluxo excedeu o limite de etapas.")
    await env.DB.prepare(
      `UPDATE workflow_runs SET status='completed',completed_at=CURRENT_TIMESTAMP,
       error_summary=NULL WHERE id=? AND organization_id=?`,
    )
      .bind(runId, organizationId)
      .run()
    return {
      sentMessage,
      assignedHuman,
      reachedAI,
    }
  } catch (error) {
    const summary =
      error instanceof Error ? error.message.slice(0, 300) : "Erro desconhecido"
    await env.DB.prepare(
      `UPDATE workflow_runs SET status='failed',error_summary=?,
       completed_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
    )
      .bind(summary, runId, organizationId)
      .run()
    console.error("workflow_execution_failed", {
      organizationId,
      workflowId: workflow.id,
      runId,
      error: summary,
    })
    throw error
  }
}

export async function executeInboundWorkflows(
  env: Env,
  organizationId: string,
  conversationId: string,
  inboundExternalId: string,
  hooks: WorkflowHooks,
) {
  const context = await loadRuntimeContext(
    env,
    organizationId,
    conversationId,
    inboundExternalId,
  )
  if (!context) return { matched: false, sentMessage: false, assignedHuman: false }

  const workflows = await env.DB.prepare(
    `SELECT id,name,description,status,draft_json,published_json,version,updated_at
     FROM workflows WHERE organization_id=? AND status='active'
     ORDER BY created_at,id LIMIT 50`,
  )
    .bind(organizationId)
    .all<WorkflowRecord>()

  let matched = false
  let sentMessage = false
  let assignedHuman = false
  for (const workflow of workflows.results) {
    const definition = workflow.published_json
      ? parse(workflow.published_json)
      : null
    if (!definition) {
      console.error("workflow_published_definition_invalid", {
        organizationId,
        workflowId: workflow.id,
      })
      continue
    }
    const result = await runWorkflow(
      env,
      organizationId,
      conversationId,
      inboundExternalId,
      workflow,
      definition,
      context,
      hooks,
    )
    if (!result) continue
    matched = true
    sentMessage ||= result.sentMessage
    assignedHuman ||= result.assignedHuman
  }
  return { matched, sentMessage, assignedHuman }
}

function simulate(
  definition: WorkflowDefinition,
  testMessage: string,
  leadStatus: string,
) {
  const context: RuntimeContext = {
    message: testMessage,
    messageType: "text",
    leadStatus,
    priority: false,
    humanRequested: false,
    hasFollowUp: false,
    contactName: "Cliente de teste",
  }
  const root = definition.nodes.find((node) => node.type === "trigger")
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const steps: Array<{ id: string; kind: string; result: string }> = []
  if (!root || !triggerMatches(root, context))
    return { matched: false, steps }
  let node: WorkflowNode | undefined = root
  let count = 0
  while (node && count++ < 40) {
    let matched: boolean | undefined
    let result = node.kind
    if (node.type === "condition") {
      matched = conditionMatches(node, context)
      result = matched ? "ramo verdadeiro" : "ramo falso"
    } else if (node.type === "action") {
      result = `ação simulada: ${node.kind}`
    }
    steps.push({ id: node.id, kind: node.kind, result })
    if (node.kind === "stop") break
    node = nodes.get(nextEdge(node, definition.edges, matched)?.target ?? "")
  }
  return { matched: true, steps }
}

export async function workflowRoutes(
  request: Request,
  env: Env,
  url: URL,
  auth: Session,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/workflows")) return null
  const base = "/api/workflows"
  const path = url.pathname.slice(base.length).replace(/\/+$/, "")
  const org = auth.organizationId

  if (path === "" && request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT id,name,description,status,version,created_at createdAt,updated_at updatedAt
       FROM workflows WHERE organization_id=?
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END,
       updated_at DESC`,
    )
      .bind(org)
      .all()
    return json(result)
  }
  if (!canEdit(auth) && request.method !== "GET")
    return json({ error: "Apenas administradores e gerentes podem alterar fluxos." }, 403)

  if (path === "" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>()
    const name = asText(body.name, 100)
    if (!name) return json({ error: "Informe o nome do fluxo." }, 400)
    const result = validateWorkflowDefinition(body.definition ?? DEFAULT_WORKFLOW)
    if (!result.definition) return json({ error: result.error }, 400)
    const id = uid()
    await env.DB.prepare(
      `INSERT INTO workflows(id,organization_id,name,description,draft_json,created_by)
       VALUES(?,?,?,?,?,?)`,
    )
      .bind(
        id,
        org,
        name,
        asText(body.description, 500),
        JSON.stringify(result.definition),
        auth.userId,
      )
      .run()
    return json({ ok: true, id }, 201)
  }

  const match = path.match(/^\/([\w-]+)(?:\/(publish|block|duplicate|test|logs|heatmap|export|api))?$/)
  if (!match) return json({ error: "Rota de fluxo inválida." }, 404)
  const workflowId = match[1]!
  const action = match[2] ?? ""
  const workflow = await env.DB.prepare(
    `SELECT id,name,description,status,draft_json,published_json,version,updated_at
     FROM workflows WHERE id=? AND organization_id=?`,
  )
    .bind(workflowId, org)
    .first<WorkflowRecord>()
  if (!workflow) return json({ error: "Fluxo não encontrado." }, 404)

  if (!action && request.method === "GET")
    return json({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      version: workflow.version,
      definition: parse(workflow.draft_json),
      publishedDefinition: workflow.published_json
        ? parse(workflow.published_json)
        : null,
    })

  if (action === "logs" && request.method === "GET") {
    const runs = await env.DB.prepare(
      `SELECT id,status,error_summary errorSummary,started_at startedAt,
       completed_at completedAt,conversation_id conversationId,inbound_external_id inboundExternalId
       FROM workflow_runs WHERE organization_id=? AND workflow_id=?
       ORDER BY started_at DESC LIMIT 25`,
    )
      .bind(org, workflowId)
      .all<{
        id: string
        status: string
        errorSummary: string | null
        startedAt: string
        completedAt: string | null
        conversationId: string
        inboundExternalId: string
      }>()
    const runIds = runs.results.map((run) => run.id)
    if (!runIds.length) return json({ runs: [] })
    const placeholders = runIds.map(() => "?").join(",")
    const steps = await env.DB.prepare(
      `SELECT run_id runId,node_id nodeId,node_type nodeType,status,
       details_json detailsJson,error_summary errorSummary
       FROM workflow_run_steps WHERE organization_id=? AND run_id IN (${placeholders})
       ORDER BY created_at`,
    )
      .bind(org, ...runIds)
      .all()
    return json({
      runs: runs.results.map((run) => ({
        ...run,
        steps: steps.results.filter(
          (step) => (step as { runId: string }).runId === run.id,
        ),
      })),
    })
  }

  if (action === "heatmap" && request.method === "GET") {
    const result = await env.DB.prepare(
      `SELECT s.node_id nodeId,s.status,COUNT(*) count
       FROM workflow_run_steps s JOIN workflow_runs r
         ON r.id=s.run_id AND r.organization_id=s.organization_id
       WHERE s.organization_id=? AND r.workflow_id=?
       GROUP BY s.node_id,s.status`,
    )
      .bind(org, workflowId)
      .all()
    return json(result)
  }

  if (action === "export" && request.method === "GET")
    return json({
      name: workflow.name,
      description: workflow.description,
      status: workflow.status,
      version: workflow.version,
      definition: parse(workflow.draft_json),
    })

  if (action === "api" && request.method === "GET")
    return json({
      workflowId,
      endpoint: `/api/workflows/${workflowId}`,
      note: "Este endpoint exige uma sessão autenticada da empresa. Para disparos de sistemas externos, use o webhook de integração configurado em Canais.",
    })

  if (!action && request.method === "PATCH") {
    const body = await request.json<Record<string, unknown>>()
    const result = validateWorkflowDefinition(body.definition)
    const name = asText(body.name, 100)
    if (!name) return json({ error: "Informe o nome do fluxo." }, 400)
    if (!result.definition) return json({ error: result.error }, 400)
    await env.DB.prepare(
      `UPDATE workflows SET name=?,description=?,draft_json=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=?`,
    )
      .bind(
        name,
        asText(body.description, 500),
        JSON.stringify(result.definition),
        workflowId,
        org,
      )
      .run()
    return json({ ok: true })
  }

  if (action === "publish" && request.method === "POST") {
    const result = validateWorkflowDefinition(JSON.parse(workflow.draft_json))
    if (!result.definition) return json({ error: result.error }, 400)
    await env.DB.prepare(
      `UPDATE workflows SET status='active',published_json=?,version=version+1,
       updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
    )
      .bind(JSON.stringify(result.definition), workflowId, org)
      .run()
    return json({ ok: true, version: workflow.version + 1 })
  }

  if (action === "block" && request.method === "POST") {
    await env.DB.prepare(
      "UPDATE workflows SET status='blocked',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(workflowId, org)
      .run()
    return json({ ok: true })
  }

  if (action === "duplicate" && request.method === "POST") {
    const id = uid()
    await env.DB.prepare(
      `INSERT INTO workflows(id,organization_id,name,description,status,draft_json,created_by)
       VALUES(?,?,? || ' (cópia)',?,'draft',?,?)`,
    )
      .bind(
        id,
        org,
        workflow.name,
        workflow.description,
        workflow.draft_json,
        auth.userId,
      )
      .run()
    return json({ ok: true, id }, 201)
  }

  if (action === "test" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>()
    const message = asText(body.message, 1000)
    const definition = parse(workflow.draft_json)
    if (!definition) return json({ error: "O rascunho do fluxo é inválido." }, 400)
    return json({
      mode: "simulation",
      sideEffects: false,
      ...simulate(
        definition,
        message,
        asText(body.leadStatus, 40) || "new",
      ),
    })
  }

  if (!action && request.method === "DELETE") {
    await env.DB.prepare(
      "DELETE FROM workflows WHERE id=? AND organization_id=?",
    )
      .bind(workflowId, org)
      .run()
    return json({ ok: true })
  }

  return json({ error: "Método ou ação não suportada." }, 405)
}
