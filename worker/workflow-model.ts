export type WorkflowNodeType = "trigger" | "condition" | "action"
export type WorkflowNode = {
  id: string
  type: WorkflowNodeType
  kind: string
  config: Record<string, unknown>
  position?: { x: number; y: number }
}
export type WorkflowEdge = {
  id: string
  source: string
  target: string
  sourceHandle?: "true" | "false"
}
export type WorkflowDefinition = {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

const kinds: Record<WorkflowNodeType, Set<string>> = {
  trigger: new Set(["message_received", "message_contains", "button_reply"]),
  condition: new Set([
    "message_contains",
    "lead_status",
    "is_priority",
    "human_requested",
    "has_follow_up",
  ]),
  action: new Set([
    "send_message",
    "private_note",
    "update_lead",
    "set_priority",
    "assign_to_human",
    "reply_with_ai",
    "stop",
  ]),
}

const leadStatuses = new Set([
  "new",
  "not_contacted",
  "in_service",
  "hot",
  "qualified",
  "negotiating",
  "follow_up",
  "cold",
  "lost",
  "sold",
])

export function validateWorkflowDefinition(
  value: unknown,
): { definition?: WorkflowDefinition; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "O fluxo precisa ser um objeto válido." }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges))
    return { error: "O fluxo precisa conter nós e conexões." }
  if (raw.nodes.length < 1 || raw.nodes.length > 40 || raw.edges.length > 80)
    return { error: "O fluxo deve ter até 40 nós e 80 conexões." }

  const nodes: WorkflowNode[] = []
  const ids = new Set<string>()
  for (const rawNode of raw.nodes) {
    if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode))
      return { error: "Há um nó inválido no fluxo." }
    const node = rawNode as Record<string, unknown>
    const id = typeof node.id === "string" ? node.id : ""
    const type = node.type as WorkflowNodeType
    const kind = typeof node.kind === "string" ? node.kind : ""
    const config =
      node.config && typeof node.config === "object" && !Array.isArray(node.config)
        ? (node.config as Record<string, unknown>)
        : {}
    if (!/^[\w-]{1,60}$/.test(id) || ids.has(id))
      return { error: "Os identificadores dos nós devem ser únicos e válidos." }
    if (!kinds[type] || !kinds[type].has(kind))
      return { error: `Tipo de nó não suportado: ${kind || "desconhecido"}.` }
    if (JSON.stringify(config).length > 5000)
      return { error: "A configuração de um nó excede o limite permitido." }
    if (type === "action" && kind === "update_lead") {
      if (
        config.status !== undefined &&
        (typeof config.status !== "string" || !leadStatuses.has(config.status))
      )
        return { error: "O fluxo contém um status de lead inválido." }
      if (
        config.followUpDays !== undefined &&
        (typeof config.followUpDays !== "number" ||
          !Number.isInteger(config.followUpDays) ||
          config.followUpDays < 0 ||
          config.followUpDays > 365)
      )
        return { error: "O prazo de follow-up deve estar entre 0 e 365 dias." }
    }
    if (
      type === "action" &&
      (kind === "send_message" || kind === "private_note") &&
      (typeof config.text !== "string" ||
        config.text.trim().length === 0 ||
        config.text.length > (kind === "send_message" ? 4096 : 2000))
    )
      return { error: "Preencha o texto da ação dentro do limite permitido." }
    if (
      type === "condition" &&
      kind === "lead_status" &&
      (typeof config.status !== "string" || !leadStatuses.has(config.status))
    )
      return { error: "Escolha um status de lead válido para a condição." }
    ids.add(id)
    nodes.push({
      id,
      type,
      kind,
      config,
      ...(node.position &&
      typeof node.position === "object" &&
      Number.isFinite((node.position as Record<string, unknown>).x) &&
      Number.isFinite((node.position as Record<string, unknown>).y)
        ? {
            position: {
              x: Number((node.position as Record<string, unknown>).x),
              y: Number((node.position as Record<string, unknown>).y),
            },
          }
        : {}),
    })
  }

  const triggers = nodes.filter((node) => node.type === "trigger")
  if (triggers.length !== 1)
    return { error: "Cada fluxo precisa ter exatamente um gatilho." }
  const edges: WorkflowEdge[] = []
  const edgeIds = new Set<string>()
  for (const rawEdge of raw.edges) {
    if (!rawEdge || typeof rawEdge !== "object" || Array.isArray(rawEdge))
      return { error: "Há uma conexão inválida no fluxo." }
    const edge = rawEdge as Record<string, unknown>
    const id = typeof edge.id === "string" ? edge.id : ""
    const source = typeof edge.source === "string" ? edge.source : ""
    const target = typeof edge.target === "string" ? edge.target : ""
    const sourceHandle = edge.sourceHandle
    if (
      !/^[\w-]{1,60}$/.test(id) ||
      edgeIds.has(id) ||
      !ids.has(source) ||
      !ids.has(target) ||
      source === target ||
      (sourceHandle !== undefined &&
        sourceHandle !== "true" &&
        sourceHandle !== "false")
    )
      return { error: "Há uma conexão inválida ou duplicada no fluxo." }
    edgeIds.add(id)
    edges.push({
      id,
      source,
      target,
      ...(sourceHandle ? { sourceHandle } : {}),
    })
  }

  const outgoing = new Map<string, WorkflowEdge[]>()
  for (const edge of edges)
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge])
  for (const node of nodes) {
    if (node.type !== "condition") continue
    const handles = new Set(
      (outgoing.get(node.id) ?? []).map((edge) => edge.sourceHandle),
    )
    if (!handles.has("true") || !handles.has("false"))
      return { error: "Cada condição precisa ter caminhos verdadeiro e falso." }
  }

  const root = triggers[0]!
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (nodeId: string): boolean => {
    if (visiting.has(nodeId)) return false
    if (visited.has(nodeId)) return true
    visiting.add(nodeId)
    for (const edge of outgoing.get(nodeId) ?? [])
      if (!visit(edge.target)) return false
    visiting.delete(nodeId)
    visited.add(nodeId)
    return true
  }
  if (!visit(root.id)) return { error: "O fluxo não pode conter ciclos." }
  if (visited.size !== nodes.length)
    return { error: "Todos os nós precisam estar conectados ao gatilho." }

  const definition = { nodes, edges }
  if (JSON.stringify(definition).length > 32000)
    return { error: "O fluxo excede o tamanho máximo permitido." }
  return { definition }
}

export const DEFAULT_WORKFLOW: WorkflowDefinition = {
  nodes: [
    {
      id: "trigger-message",
      type: "trigger",
      kind: "message_received",
      config: {},
      position: { x: 560, y: 100 },
    },
    {
      id: "vip-condition",
      type: "condition",
      kind: "is_priority",
      config: {},
      position: { x: 560, y: 285 },
    },
    {
      id: "vip-note",
      type: "action",
      kind: "private_note",
      config: {
        text: "⭐ Lead VIP detectado! Priorize esta conversa e faça o atendimento pessoalmente.",
      },
      position: { x: 220, y: 520 },
    },
    {
      id: "standard-ai",
      type: "action",
      kind: "reply_with_ai",
      config: {},
      position: { x: 900, y: 520 },
    },
  ],
  edges: [
    { id: "edge-trigger-condition", source: "trigger-message", target: "vip-condition" },
    {
      id: "edge-vip-note",
      source: "vip-condition",
      target: "vip-note",
      sourceHandle: "true",
    },
    {
      id: "edge-standard-ai",
      source: "vip-condition",
      target: "standard-ai",
      sourceHandle: "false",
    },
  ],
}
