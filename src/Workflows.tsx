import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react"
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Ban,
  Bot,
  ChevronRight,
  Code2,
  Copy,
  Ellipsis,
  Sparkles,
  Crosshair,
  Download,
  Eye,
  GitBranch,
  MessageSquareText,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react"
import { api, errorMessage } from "./api"
import { DEFAULT_WORKFLOW } from "../worker/workflow-model"

type NodeType = "trigger" | "condition" | "action"
type BlockCategory = "event" | "agent" | "action" | "condition" | "exit"
type Node = {
  id: string
  type: NodeType
  kind: string
  config: Record<string, unknown>
  position?: { x: number; y: number }
}
type Edge = {
  id: string
  source: string
  target: string
  sourceHandle?: "true" | "false"
}
type Definition = { nodes: Node[]; edges: Edge[] }
type Summary = {
  id: string
  name: string
  description: string
  status: "draft" | "active" | "blocked"
  version: number
  updatedAt: string
}
type WorkflowDetail = Summary & {
  definition: Definition
  publishedDefinition: Definition | null
}
type Simulation = {
  mode: string
  sideEffects: boolean
  matched: boolean
  steps: Array<{ id: string; kind: string; result: string }>
}
type TestLine = { id: string; role: "user" | "assistant" | "note" | "system"; text: string }

const types: Record<NodeType, Array<{ value: string; label: string }>> = {
  trigger: [
    { value: "message_received", label: "Nova mensagem recebida" },
    { value: "message_contains", label: "Mensagem contém palavra-chave" },
    { value: "button_reply", label: "Resposta a botão" },
  ],
  condition: [
    { value: "message_contains", label: "Mensagem contém" },
    { value: "lead_status", label: "Status do lead" },
    { value: "is_priority", label: "Conversa prioritária" },
    { value: "human_requested", label: "Cliente pediu atendimento humano" },
    { value: "has_follow_up", label: "Possui follow-up agendado" },
  ],
  action: [
    { value: "send_message", label: "Enviar mensagem" },
    { value: "private_note", label: "Adicionar nota privada" },
    { value: "update_lead", label: "Atualizar lead e follow-up" },
    { value: "set_priority", label: "Definir prioridade" },
    { value: "assign_to_human", label: "Solicitar ou atribuir à equipe" },
    { value: "reply_with_ai", label: "Continuar com resposta da IA" },
    { value: "stop", label: "Encerrar este fluxo" },
  ],
}

const blockCategories: Array<{ id: BlockCategory; label: string }> = [
  { id: "event", label: "Evento" },
  { id: "agent", label: "Agente" },
  { id: "action", label: "Ação" },
  { id: "condition", label: "Condição" },
  { id: "exit", label: "Saída" },
]

const blockTemplates: Array<{
  category: BlockCategory
  type: NodeType
  kind: string
  title: string
  description: string
}> = [
  { category: "event", type: "trigger", kind: "message_received", title: "Nova mensagem recebida", description: "Quando uma nova mensagem chegar à conversa." },
  { category: "event", type: "trigger", kind: "message_contains", title: "Mensagem corresponde", description: "Quando a mensagem incluir um texto definido." },
  { category: "event", type: "trigger", kind: "button_reply", title: "Resposta de botão", description: "Quando o cliente responder a um botão." },
  { category: "agent", type: "action", kind: "reply_with_ai", title: "Responder com IA", description: "Continuar a conversa com o assistente de IA." },
  { category: "agent", type: "action", kind: "assign_to_human", title: "Encaminhar para equipe", description: "Sinalizar que a conversa precisa de atendimento humano." },
  { category: "action", type: "action", kind: "send_message", title: "Enviar mensagem", description: "Adicionar uma mensagem à conversa." },
  { category: "action", type: "action", kind: "private_note", title: "Nota interna", description: "Adicionar uma nota visível apenas para a equipe." },
  { category: "action", type: "action", kind: "update_lead", title: "Atualizar lead e follow-up", description: "Registrar status, interesse e próxima ação." },
  { category: "action", type: "action", kind: "set_priority", title: "Definir prioridade", description: "Marcar ou remover a prioridade da conversa." },
  { category: "condition", type: "condition", kind: "message_contains", title: "Mensagem contém", description: "Separar o fluxo conforme o texto recebido." },
  { category: "condition", type: "condition", kind: "lead_status", title: "Status do lead", description: "Verificar o status atual do lead." },
  { category: "condition", type: "condition", kind: "is_priority", title: "Conversa prioritária", description: "Verificar se a conversa está marcada como prioritária." },
  { category: "condition", type: "condition", kind: "human_requested", title: "Pedido de atendimento humano", description: "Verificar se o cliente pediu uma pessoa." },
  { category: "condition", type: "condition", kind: "has_follow_up", title: "Follow-up agendado", description: "Verificar se a conversa tem follow-up." },
  { category: "exit", type: "action", kind: "stop", title: "Parar fluxo", description: "Encerrar este caminho da automação." },
]

const leadStatuses = [
  ["new", "Novo"],
  ["not_contacted", "Não contatado"],
  ["in_service", "Em atendimento"],
  ["hot", "Quente"],
  ["qualified", "Qualificado"],
  ["negotiating", "Negociando"],
  ["follow_up", "Follow-up"],
  ["cold", "Frio"],
  ["lost", "Perdido"],
  ["sold", "Vendido"],
]

const makeId = () => `node-${crypto.randomUUID().slice(0, 8)}`

function nodeLabel(node: Node) {
  const customLabel = node.config.customLabel
  if (typeof customLabel === "string" && customLabel.trim()) return customLabel.trim()
  return types[node.type].find((item) => item.value === node.kind)?.label ?? node.kind
}

function defaultConfig(type: NodeType, kind: string): Record<string, unknown> {
  if (type === "trigger" && kind === "message_contains") return { text: "" }
  if (type === "condition" && kind === "message_contains") return { text: "" }
  if (type === "condition" && kind === "lead_status") return { status: "hot" }
  if (type === "action" && kind === "send_message")
    return { text: "Olá! Como posso ajudar?" }
  if (type === "action" && kind === "private_note") return { text: "" }
  if (type === "action" && kind === "update_lead")
    return { status: "follow_up", followUpDays: 1 }
  if (type === "action" && kind === "set_priority") return { enabled: true }
  return {}
}

function statusLabel(status: Summary["status"]) {
  return status === "active" ? "Publicado" : status === "blocked" ? "Bloqueado" : "Rascunho"
}

function previewOutputs(
  definition: Definition,
  simulation: Simulation,
  message: string,
  leadStatus: string,
): TestLine[] {
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]))
  const outputs: TestLine[] = []
  for (const step of simulation.steps) {
    const node = nodes.get(step.id)
    if (!node || node.type !== "action") continue
    const id = `${step.id}-${outputs.length}`
    if (node.kind === "send_message") {
      outputs.push({
        id,
        role: "assistant",
        text: String(node.config.text ?? "")
          .replace(/\{\{contact\.name\}\}/g, "Cliente de teste")
          .replace(/\{\{lead\.status\}\}/g, leadStatuses.find(([value]) => value === leadStatus)?.[1] ?? leadStatus)
          .replace(/\{\{message\.text\}\}/g, message),
      })
    } else if (node.kind === "private_note") {
      outputs.push({ id, role: "note", text: String(node.config.text ?? "Nota privada") })
    } else if (node.kind === "reply_with_ai") {
      outputs.push({
        id,
        role: "system",
        text: "Este caminho continuaria com a IA no atendimento real. O teste não chama a IA nem envia mensagens.",
      })
    } else if (node.kind === "stop") {
      outputs.push({ id, role: "system", text: "O fluxo foi encerrado nesta etapa." })
    } else {
      outputs.push({ id, role: "system", text: `Ação simulada: ${nodeLabel(node)}.` })
    }
  }
  if (!outputs.length)
    outputs.push({
      id: `result-${crypto.randomUUID()}`,
      role: "system",
      text: simulation.matched
        ? "O caminho foi executado sem uma mensagem de saída para o cliente."
        : "O gatilho não foi acionado. Confira as condições do fluxo.",
    })
  return outputs
}

type WorkflowCanvasProps = {
  nodes: Node[]
  edges: Edge[]
  selectedNodeId: string
  canEdit: boolean
  zoom: number
  resetVersion: number
  nodeUsage: Map<string, number>
  connectionSource: { nodeId: string; handle?: "true" | "false" } | null
  onSelect: (nodeId: string) => void
  onRemove: (nodeId: string) => void
  onDuplicate: (nodeId: string) => void
  onMove: (nodeId: string, position: { x: number; y: number }) => void
  onStartConnection: (nodeId: string, handle?: "true" | "false") => void
  onConnect: (targetId: string) => void
  onAddNode: (type: NodeType, kind: string, config?: Record<string, unknown>) => void
  onZoom: (amount: number) => void
  onReset: () => void
}

function WorkflowCanvas({
  nodes,
  edges,
  selectedNodeId,
  canEdit,
  zoom,
  resetVersion,
  nodeUsage,
  connectionSource,
  onSelect,
  onRemove,
  onDuplicate,
  onMove,
  onStartConnection,
  onConnect,
  onAddNode,
  onZoom,
  onReset,
}: WorkflowCanvasProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerCategory, setPickerCategory] = useState<BlockCategory | null>(null)
  const [pickerSearch, setPickerSearch] = useState("")
  const [openNodeMenuId, setOpenNodeMenuId] = useState("")
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() =>
    Object.fromEntries(nodes.map((node, index) => [node.id, node.position ?? { x: 100 + index * 340, y: 120 }])),
  )
  const [pan, setPan] = useState({ x: 40, y: 30 })
  const viewportRef = useRef<HTMLDivElement>(null)
  const interaction = useRef<
    | { type: "pan"; start: { x: number; y: number }; origin: { x: number; y: number } }
    | { type: "node"; id: string; start: { x: number; y: number }; origin: { x: number; y: number }; current: { x: number; y: number } }
    | null
  >(null)

  useEffect(() => {
    setPositions(Object.fromEntries(nodes.map((node, index) => [node.id, node.position ?? positions[node.id] ?? { x: 100 + index * 340, y: 120 }])))
  }, [nodes])

  useEffect(() => {
    setPan({ x: 40, y: 30 })
  }, [resetVersion])

  useEffect(() => {
    function move(event: PointerEvent) {
      const current = interaction.current
      if (!current) return
      if (current.type === "pan") {
        setPan({
          x: current.origin.x + event.clientX - current.start.x,
          y: current.origin.y + event.clientY - current.start.y,
        })
        return
      }
      const position = {
        x: Math.max(20, current.origin.x + (event.clientX - current.start.x) / zoom),
        y: Math.max(20, current.origin.y + (event.clientY - current.start.y) / zoom),
      }
      current.current = position
      setPositions((previous) => ({ ...previous, [current.id]: position }))
    }

    function finish() {
      const current = interaction.current
      if (current?.type === "node" && (current.current.x !== current.origin.x || current.current.y !== current.origin.y)) {
        onMove(current.id, current.current)
      }
      interaction.current = null
    }

    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", finish)
    window.addEventListener("pointercancel", finish)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", finish)
      window.removeEventListener("pointercancel", finish)
    }
  }, [onMove, zoom])

  const nodeWidth = 248
  const nodeHeight = (node: Node) => node.type === "condition" ? 116 : node.kind === "reply_with_ai" ? 148 : 104
  const positionOf = (nodeId: string) => positions[nodeId] ?? { x: 100, y: 120 }
  const stageWidth = Math.max(1500, ...nodes.map((node) => positionOf(node.id).x + nodeWidth + 180))
  const stageHeight = Math.max(1000, ...nodes.map((node) => positionOf(node.id).y + nodeHeight(node) + 180))
  const triggerNode = nodes.find((node) => node.type === "trigger")
  const normalizedSearch = pickerSearch.trim().toLowerCase()
  const visibleTemplates = blockTemplates.filter((template) => {
    const categoryMatches = !pickerCategory || template.category === pickerCategory
    const searchMatches = !normalizedSearch || `${template.title} ${template.description} ${template.category}`.toLowerCase().includes(normalizedSearch)
    return categoryMatches && searchMatches
  })

  function chooseTemplate(template: (typeof blockTemplates)[number]) {
    onAddNode(template.type, template.kind)
    setPickerOpen(false)
    setPickerCategory(null)
    setPickerSearch("")
  }

  function centerMiniMap(event: ReactPointerEvent<HTMLButtonElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const viewport = viewportRef.current?.getBoundingClientRect()
    if (!viewport) return
    const x = ((event.clientX - bounds.left) / bounds.width) * stageWidth
    const y = ((event.clientY - bounds.top) / bounds.height) * stageHeight
    setPan({
      x: viewport.width / 2 - x * zoom,
      y: viewport.height / 2 - y * zoom,
    })
  }

  function beginPan(event: ReactPointerEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement
    if (!target.closest(".workflow-canvas-add, .workflow-block-picker")) {
      setPickerOpen(false)
      setPickerCategory(null)
      setPickerSearch("")
    }
    if (!target.closest(".workflow-node-actions")) setOpenNodeMenuId("")
    if (target.closest("button, article")) return
    interaction.current = {
      type: "pan",
      start: { x: event.clientX, y: event.clientY },
      origin: pan,
    }
  }

  function beginNodeDrag(event: ReactPointerEvent<HTMLElement>, node: Node) {
    if (!canEdit || (event.target as HTMLElement).closest("button")) return
    event.preventDefault()
    event.stopPropagation()
    const origin = positionOf(node.id)
    interaction.current = {
      type: "node",
      id: node.id,
      start: { x: event.clientX, y: event.clientY },
      origin,
      current: origin,
    }
  }

  return (
    <div ref={viewportRef} className="workflow-canvas-viewport" onPointerDown={beginPan}>
      <div
        className="workflow-canvas-stage"
        style={{
          width: stageWidth,
          height: stageHeight,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
        }}
      >
        <svg className="workflow-canvas-edges" width={stageWidth} height={stageHeight} aria-hidden="true">
          <defs>
            <marker id="workflow-edge-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#8fa39a" />
            </marker>
          </defs>
          {triggerNode && (
            <path
              d={`M ${positionOf(triggerNode.id).x + nodeWidth / 2} ${positionOf(triggerNode.id).y - 32} L ${positionOf(triggerNode.id).x + nodeWidth / 2} ${positionOf(triggerNode.id).y}`}
              stroke="#b3bdc3"
              strokeWidth="1.5"
              fill="none"
              markerEnd="url(#workflow-edge-arrow)"
            />
          )}
          {edges.map((edge) => {
            const source = nodes.find((node) => node.id === edge.source)
            const target = nodes.find((node) => node.id === edge.target)
            if (!source || !target) return null
            const sourcePosition = positionOf(source.id)
            const targetPosition = positionOf(target.id)
            const x1 = sourcePosition.x + (source.type === "condition"
              ? edge.sourceHandle === "false" ? nodeWidth * .68 : nodeWidth * .32
              : nodeWidth / 2)
            const y1 = sourcePosition.y + nodeHeight(source)
            const x2 = targetPosition.x + nodeWidth / 2
            const y2 = targetPosition.y
            const direction = Math.sign(y2 - y1) || 1
            const curve = Math.max(42, Math.abs(y2 - y1) / 2)
            const labelX = (x1 + x2) / 2
            const labelY = (y1 + y2) / 2
            return (
              <g key={edge.id}>
                <path
                  d={`M ${x1} ${y1} C ${x1} ${y1 + curve * direction}, ${x2} ${y2 - curve * direction}, ${x2} ${y2}`}
                  fill="none"
                  stroke={edge.sourceHandle === "true" ? "#16a36a" : edge.sourceHandle === "false" ? "#d28a24" : "#8fa39a"}
                  strokeWidth="2"
                  markerEnd="url(#workflow-edge-arrow)"
                />
                <circle cx={x2} cy={y2} r="4" fill="#fff" stroke="#8fa39a" strokeWidth="2" />
                {edge.sourceHandle && <text x={labelX} y={labelY} textAnchor="middle" className={`workflow-edge-label ${edge.sourceHandle}`}>
                  {edge.sourceHandle === "true" ? "1" : "2"}
                </text>}
              </g>
            )
          })}
        </svg>
        {nodes.map((node, index) => {
          const position = positionOf(node.id)
          const outgoing = node.type === "action" && node.kind === "stop"
            ? []
            : node.type === "condition" ? ["true", "false"] as const : [undefined]
          return (
            <div key={node.id}>
              {node.type === "trigger" && (
                <div className="workflow-entry-node" style={{ left: position.x + 19, top: position.y - 70 }}>
                  <Download size={15} /><span>Portão de Entrada</span>
                </div>
              )}
              <article
                className={`workflow-node ${node.type} ${node.kind} ${selectedNodeId === node.id ? "selected" : ""}`}
                style={{ left: position.x, top: position.y, width: nodeWidth, height: nodeHeight(node) }}
                onPointerDown={(event) => beginNodeDrag(event, node)}
                onClick={() => onSelect(node.id)}
              >
              <button
                type="button"
                className={`workflow-node-port input ${connectionSource ? "connect-target" : ""}`}
                title={connectionSource ? "Conectar nesta etapa" : "Ponto de entrada"}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation()
                  if (connectionSource && connectionSource.nodeId !== node.id) onConnect(node.id)
                }}
              />
              <div className="workflow-node-head">
                <span className={`workflow-node-icon ${node.type}`}>
                  {node.type === "trigger" ? <MessageSquareText size={16} /> : node.type === "condition" ? <GitBranch size={16} /> : <Sparkles size={16} />}
                </span>
                <span className="workflow-node-meta">
                  <small>{node.type === "trigger" ? "QUANDO" : node.type === "condition" ? "VERIFICAR" : "ENTÃO"} · ETAPA {index + 1}</small>
                <b>{node.kind === "is_priority" ? "Segmentos da conversa?" : nodeLabel(node)}</b>
                </span>
                {nodeUsage.has(node.id) && <span className="workflow-node-count">{nodeUsage.get(node.id)}</span>}
              </div>
              <div className="workflow-node-summary">
                {node.kind === "message_received"
                ? "Origens: Todas"
                : node.kind === "is_priority"
                  ? "Segmento: VIP (conversa prioritária)"
                  : node.kind === "message_contains"
                ? String(node.config.text || "Defina o texto para comparar")
                : node.kind === "send_message"
                  ? String(node.config.text || "Configure a mensagem").slice(0, 68)
                    : node.kind === "lead_status"
                      ? `Status: ${leadStatuses.find(([value]) => value === node.config.status)?.[1] ?? "Quente"}`
                      : node.kind === "private_note"
                        ? String(node.config.text || "Nota interna")
                        : node.kind === "reply_with_ai"
                          ? "O assistente responde com IA"
                          : node.kind === "stop"
                            ? "Fim deste caminho"
                            : "Configure esta etapa no painel"}
              </div>
              {canEdit && (
                <div className="workflow-node-actions" onPointerDown={(event) => event.stopPropagation()}>
                  <button
                    type="button"
                    aria-label={`Editar bloco ${nodeLabel(node)}`}
                    title="Editar bloco"
                    onClick={(event) => { event.stopPropagation(); onSelect(node.id) }}
                  >
                    <Pencil size={14} />
                  </button>
                  {node.type !== "trigger" && (
                    <>
                      <button
                        type="button"
                        aria-label={`Excluir bloco ${nodeLabel(node)}`}
                        title="Excluir bloco"
                        onClick={(event) => { event.stopPropagation(); onRemove(node.id) }}
                      >
                        <Trash2 size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Mais opções para ${nodeLabel(node)}`}
                        title="Mais opções"
                        aria-expanded={openNodeMenuId === node.id}
                        onClick={(event) => {
                          event.stopPropagation()
                          setOpenNodeMenuId((current) => current === node.id ? "" : node.id)
                        }}
                      >
                        <Ellipsis size={15} />
                      </button>
                    </>
                  )}
                  {openNodeMenuId === node.id && (
                    <div className="workflow-node-menu" role="menu" onClick={(event) => event.stopPropagation()}>
                      <button type="button" role="menuitem" onClick={() => { onSelect(node.id); setOpenNodeMenuId("") }}>
                        <Pencil size={14} /> Renomear bloco
                      </button>
                      <button type="button" role="menuitem" onClick={() => { onDuplicate(node.id); setOpenNodeMenuId("") }}>
                        <Copy size={14} /> Duplicar no fluxo
                      </button>
                      <button type="button" role="menuitem" className="danger" onClick={() => { onRemove(node.id); setOpenNodeMenuId("") }}>
                        <Trash2 size={14} /> Excluir bloco
                      </button>
                    </div>
                  )}
                </div>
              )}
              {outgoing.map((handle) => (
                <button
                  key={handle ?? "default"}
                  type="button"
                  className={`workflow-node-port output ${handle ?? ""} ${connectionSource?.nodeId === node.id && connectionSource.handle === handle ? "connecting" : ""}`}
                          style={handle ? { left: handle === "true" ? "32%" : "68%" } : undefined}
                  title={handle === "true" ? "Conectar saída Sim" : handle === "false" ? "Conectar saída Não" : "Conectar próxima etapa"}
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (canEdit) onStartConnection(node.id, handle)
                  }}
                >
                          {handle === "true" ? "1" : handle === "false" ? "2" : ""}
                </button>
              ))}
              </article>
            </div>
          )
        })}
      </div>
      {canEdit && (
        <div className="workflow-canvas-add">
          <button
            type="button"
            className="workflow-canvas-add-main"
            aria-label="Adicionar bloco"
            title="Adicionar bloco"
            aria-expanded={pickerOpen}
            onClick={() => {
              setPickerOpen((open) => !open)
              setPickerCategory(null)
              setPickerSearch("")
            }}
          >
            <Plus size={19} />
          </button>
        </div>
      )}
      {canEdit && pickerOpen && (
        <section
          className="workflow-block-picker"
          role="dialog"
          aria-label="Selecionar bloco para o fluxo"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <header className="workflow-block-picker-header">
            {pickerCategory && (
              <button type="button" aria-label="Voltar às categorias" onClick={() => setPickerCategory(null)}>
                <ArrowLeft size={16} />
              </button>
            )}
            <b>{pickerCategory ? "Selecionar modelo" : "Selecionar tipo de bloco"}</b>
            <button
              type="button"
              aria-label="Fechar seleção de blocos"
              onClick={() => { setPickerOpen(false); setPickerCategory(null); setPickerSearch("") }}
            >
              <X size={16} />
            </button>
          </header>
          <label className="workflow-block-picker-search">
            <Search size={16} />
            <input
              value={pickerSearch}
              onChange={(event) => setPickerSearch(event.target.value)}
              placeholder="Introduza para pesquisar"
              aria-label="Pesquisar blocos"
            />
          </label>
          <div className="workflow-block-picker-list">
            {!pickerCategory && !normalizedSearch ? blockCategories.map((category) => (
              <button
                type="button"
                className="workflow-block-picker-category"
                key={category.id}
                onClick={() => setPickerCategory(category.id)}
              >
                <span>{category.label}</span><ChevronRight size={16} />
              </button>
            )) : visibleTemplates.map((template) => (
              <button
                type="button"
                className="workflow-block-picker-template"
                key={`${template.type}-${template.kind}`}
                onClick={() => chooseTemplate(template)}
              >
                <b>{template.title}</b>
                <small>{template.description}</small>
              </button>
            ))}
            {((pickerCategory || normalizedSearch) && visibleTemplates.length === 0) && (
              <p className="workflow-block-picker-empty">Nenhum bloco encontrado.</p>
            )}
          </div>
        </section>
      )}
      <button type="button" className="workflow-minimap" aria-label="Mapa do fluxo. Clique para navegar." onPointerDown={(event) => event.stopPropagation()} onPointerUp={centerMiniMap}>
        <svg viewBox={`0 0 ${stageWidth} ${stageHeight}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          {edges.map((edge) => {
            const source = nodes.find((node) => node.id === edge.source)
            const target = nodes.find((node) => node.id === edge.target)
            if (!source || !target) return null
            const a = positionOf(source.id)
            const b = positionOf(target.id)
            return <line key={edge.id} x1={a.x + nodeWidth / 2} y1={a.y + nodeHeight(source)} x2={b.x + nodeWidth / 2} y2={b.y} />
          })}
          {nodes.map((node) => {
            const position = positionOf(node.id)
            return <rect key={node.id} x={position.x} y={position.y} width={nodeWidth} height={nodeHeight(node)} rx="8" className={`${node.type} ${node.kind}`} />
          })}
          {viewportRef.current && (
            <rect
              className="workflow-minimap-viewport"
              x={-pan.x / zoom}
              y={-pan.y / zoom}
              width={viewportRef.current.clientWidth / zoom}
              height={viewportRef.current.clientHeight / zoom}
            />
          )}
        </svg>
      </button>
      <div className="workflow-canvas-navigation">
        <button type="button" aria-label="Diminuir zoom" onClick={() => onZoom(-.1)}>−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Aumentar zoom" onClick={() => onZoom(.1)}>+</button>
        <button type="button" aria-label="Centralizar fluxo" title="Centralizar fluxo" onClick={onReset}><Crosshair size={15} /></button>
      </div>
      <div className="workflow-canvas-hint">Arraste blocos para organizar · arraste o fundo para navegar · conecte uma saída a uma entrada</div>
    </div>
  )
}

export default function Workflows({ canEdit, organizationId }: { canEdit: boolean; organizationId: string }) {
  const [items, setItems] = useState<Summary[]>([])
  const [activeId, setActiveId] = useState("")
  const [detail, setDetail] = useState<WorkflowDetail | null>(null)
  const [selectedNodeId, setSelectedNodeId] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [message, setMessage] = useState("")
  const [simulation, setSimulation] = useState<Simulation | null>(null)
  const [testConversation, setTestConversation] = useState<TestLine[]>([])
  const [testOpen, setTestOpen] = useState(false)
  const [testDefinitionsOpen, setTestDefinitionsOpen] = useState(false)
  const [testLeadStatus, setTestLeadStatus] = useState("new")
  const [testPriority, setTestPriority] = useState(false)
  const [testHumanRequested, setTestHumanRequested] = useState(false)
  const [testHasFollowUp, setTestHasFollowUp] = useState(false)
  const [logs, setLogs] = useState<Array<Record<string, unknown>> | null>(null)
  const [heatmap, setHeatmap] = useState<Array<{ nodeId: string; status: string; count: number }> | null>(null)
  const [apiInfo, setApiInfo] = useState<{ endpoint: string; note: string } | null>(null)
  const [showActiveOnly, setShowActiveOnly] = useState(false)
  const [search, setSearch] = useState("")
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("VIP Routing")
  const [newDescription, setNewDescription] = useState("Roteia conversas VIP para a equipe e direciona as demais à IA.")
  const [zoom, setZoom] = useState(1)
  const [canvasResetVersion, setCanvasResetVersion] = useState(0)
  const [connectionSource, setConnectionSource] = useState<{ nodeId: string; handle?: "true" | "false" } | null>(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [moreActionsOpen, setMoreActionsOpen] = useState(false)
  const [history, setHistory] = useState<Definition[]>([])
  const [future, setFuture] = useState<Definition[]>([])
  const starterRequest = useRef(false)

  const loadList = useCallback(async () => {
    try {
      const response = await api<{ results: Summary[] }>("/api/workflows")
      let results = response.results
      const markerKey = `av-flow-workflow-starter:${organizationId}`
      if (results.length) localStorage.setItem(markerKey, "1")
      if (
        results.length === 0 &&
        canEdit &&
        !starterRequest.current &&
        localStorage.getItem(markerKey) !== "1"
      ) {
        starterRequest.current = true
        await api("/api/workflows/starter", { method: "POST" })
        results = (await api<{ results: Summary[] }>("/api/workflows")).results
        localStorage.setItem(markerKey, "1")
      }
      setItems(results)
      if (!activeId && results[0]) setActiveId(results[0].id)
    } catch (e) {
      setError(errorMessage(e))
      starterRequest.current = false
    }
  }, [activeId, canEdit, organizationId])

  const loadDetail = useCallback(async (id: string) => {
    if (!id) {
      setDetail(null)
      return
    }
    try {
      const response = await api<WorkflowDetail>(`/api/workflows/${id}`)
      setDetail(response)
      setSelectedNodeId(response.definition.nodes[0]?.id ?? "")
      setInspectorOpen(false)
      setTestConversation([])
      setSimulation(null)
      setHistory([])
      setFuture([])
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { void loadDetail(activeId) }, [activeId, loadDetail])

  const visibleItems = useMemo(
    () => items.filter((item) => {
      const activeMatches = !showActiveOnly || item.status === "active"
      const searchMatches = `${item.name} ${item.description}`.toLowerCase().includes(search.trim().toLowerCase())
      return activeMatches && searchMatches
    }),
    [items, search, showActiveOnly],
  )

  function changeDefinition(next: Definition) {
    if (!detail) return
    setHistory((previous) => [...previous.slice(-19), detail.definition])
    setFuture([])
    setDetail({ ...detail, definition: next })
    setSimulation(null)
    setLogs(null)
    setHeatmap(null)
  }

  function updateNode(nodeId: string, update: Partial<Node>) {
    if (!detail) return
    changeDefinition({
      ...detail.definition,
      nodes: detail.definition.nodes.map((node) =>
        node.id === nodeId ? { ...node, ...update } : node,
      ),
    })
  }

  function updateConfig(node: Node, field: string, value: unknown) {
    updateNode(node.id, { config: { ...node.config, [field]: value } })
  }

  function addNode(type: NodeType, kind: string, configOverride?: Record<string, unknown>) {
    if (!detail) return
    if (type === "trigger") {
      const trigger = detail.definition.nodes.find((node) => node.type === "trigger")
      if (!trigger) return
      updateNode(trigger.id, {
        kind,
        config: { ...defaultConfig(type, kind), ...configOverride, customLabel: trigger.config.customLabel },
      })
      setSelectedNodeId(trigger.id)
      setInspectorOpen(true)
      return
    }
    const id = makeId()
    const tail = detail.definition.nodes.at(-1)
    const basePosition = tail?.position ?? { x: 80, y: 120 }
    const node: Node = {
      id,
      type,
      kind,
      config: { ...defaultConfig(type, kind), ...configOverride },
      position: {
        x: basePosition.x + 340,
        y: basePosition.y + (type === "condition" ? 0 : 35),
      },
    }
    const nodes = [...detail.definition.nodes, node]
    let edges = [...detail.definition.edges]
    if (type === "condition") {
      const trueId = makeId()
      const falseId = makeId()
      nodes.push(
        {
          id: trueId,
          type: "action",
          kind: "stop",
          config: {},
          position: { x: node.position!.x + 340, y: node.position!.y - 145 },
        },
        {
          id: falseId,
          type: "action",
          kind: "stop",
          config: {},
          position: { x: node.position!.x + 340, y: node.position!.y + 145 },
        },
      )
      edges.push(
        { id: makeId(), source: id, target: trueId, sourceHandle: "true" },
        { id: makeId(), source: id, target: falseId, sourceHandle: "false" },
      )
    }
    const previousTail = detail.definition.nodes
      .filter((existing) => !edges.some((edge) => edge.source === existing.id))
      .filter((existing) => !(existing.type === "action" && existing.kind === "stop"))
      .at(-1)
    if (previousTail) edges.push({ id: makeId(), source: previousTail.id, target: id })
    changeDefinition({ nodes, edges })
    setSelectedNodeId(id)
    setInspectorOpen(true)
  }

  function updateConnection(source: string, handle: "true" | "false" | undefined, target: string) {
    if (!detail) return
    const without = detail.definition.edges.filter(
      (edge) => edge.source !== source || edge.sourceHandle !== handle,
    )
    if (target) without.push({ id: makeId(), source, target, ...(handle ? { sourceHandle: handle } : {}) })
    changeDefinition({ ...detail.definition, edges: without })
  }

  function moveNodePosition(nodeId: string, position: { x: number; y: number }) {
    if (!detail) return
    changeDefinition({
      ...detail.definition,
      nodes: detail.definition.nodes.map((node) => node.id === nodeId ? { ...node, position } : node),
    })
  }

  function startConnection(nodeId: string, handle?: "true" | "false") {
    setConnectionSource((current) =>
      current?.nodeId === nodeId && current.handle === handle ? null : { nodeId, handle },
    )
  }

  function connectNode(targetId: string) {
    if (!connectionSource || connectionSource.nodeId === targetId) return
    updateConnection(connectionSource.nodeId, connectionSource.handle, targetId)
    setConnectionSource(null)
  }

  function removeNode(nodeId: string) {
    if (!detail) return
    const node = detail.definition.nodes.find((item) => item.id === nodeId)
    if (!node || node.type === "trigger") return
    const incoming = detail.definition.edges.filter((edge) => edge.target === nodeId)
    const outgoing = detail.definition.edges.filter((edge) => edge.source === nodeId)
    const nextSelected = incoming[0]?.source ?? detail.definition.nodes.find((item) => item.id !== nodeId)?.id ?? ""
    const nextEdges = detail.definition.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
    if (node.type !== "condition" && incoming.length === 1 && outgoing.length === 1) {
      const [previous] = incoming
      const [next] = outgoing
      if (previous && next && previous.source !== next.target) {
        nextEdges.push({
          id: makeId(),
          source: previous.source,
          target: next.target,
          ...(previous.sourceHandle ? { sourceHandle: previous.sourceHandle } : {}),
        })
      }
    }
    changeDefinition({
      nodes: detail.definition.nodes.filter((node) => node.id !== nodeId),
      edges: nextEdges,
    })
    setSelectedNodeId(nextSelected)
  }

  function duplicateNode(nodeId: string) {
    const node = detail?.definition.nodes.find((item) => item.id === nodeId)
    if (!node || node.type === "trigger") return
    addNode(node.type, node.kind, {
      ...node.config,
      customLabel: `${nodeLabel(node).slice(0, 50)} (cópia)`,
    })
  }

  function undo() {
    if (!detail || history.length === 0) return
    const previous = history[history.length - 1]!
    setFuture((items) => [...items, detail.definition])
    setHistory((items) => items.slice(0, -1))
    setDetail({ ...detail, definition: previous })
  }

  function redo() {
    if (!detail || future.length === 0) return
    const next = future[future.length - 1]!
    setHistory((items) => [...items, detail.definition])
    setFuture((items) => items.slice(0, -1))
    setDetail({ ...detail, definition: next })
  }

  async function createWorkflow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!newName.trim()) return
    setBusy(true); setError(""); setNotice("")
    try {
      const result = await api<{ id: string }>("/api/workflows", {
        method: "POST",
        body: {
          name: newName.trim(),
          description: newDescription.trim(),
          definition: DEFAULT_WORKFLOW,
        },
      })
      setCreateOpen(false)
      setNewName("VIP Routing")
      setNewDescription("Roteia conversas VIP para a equipe e direciona as demais à IA.")
      await loadList()
      setActiveId(result.id)
      setNotice("Rascunho criado.")
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function save() {
    if (!detail) return
    setBusy(true); setError(""); setNotice("")
    try {
      await api(`/api/workflows/${detail.id}`, {
        method: "PATCH",
        body: { name: detail.name, description: detail.description, definition: detail.definition },
      })
      setNotice("Rascunho salvo.")
      await loadList()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function runAction(action: "publish" | "block" | "duplicate" | "delete") {
    if (!detail) return
    if (action === "delete" && !confirm("Excluir este fluxo e seu histórico de execução?")) return
    setBusy(true); setError(""); setNotice("")
    try {
      if (action === "delete") {
        await api(`/api/workflows/${detail.id}`, { method: "DELETE" })
        setActiveId("")
        setDetail(null)
      } else {
        const result = await api<{ id?: string }>(`/api/workflows/${detail.id}/${action}`, { method: "POST" })
        if (result.id) setActiveId(result.id)
        else await loadDetail(detail.id)
        setNotice(action === "publish" ? "Fluxo publicado." : action === "block" ? "Fluxo bloqueado." : "Cópia criada como rascunho.")
      }
      await loadList()
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function test() {
    if (!detail) return
    const testMessage = message.trim()
    if (!testMessage) {
      setError("Digite uma mensagem para testar o fluxo.")
      return
    }
    setBusy(true); setError(""); setNotice("")
    try {
      const response = await api<Simulation>(`/api/workflows/${detail.id}/test`, {
        method: "POST",
        body: {
          message: testMessage,
          leadStatus: testLeadStatus,
          priority: testPriority,
          humanRequested: testHumanRequested,
          hasFollowUp: testHasFollowUp,
        },
      })
      setSimulation(response)
      const output = previewOutputs(detail.definition, response, testMessage, testLeadStatus)
      const newLines: TestLine[] = [
        { id: `user-${crypto.randomUUID()}`, role: "user", text: testMessage },
        ...output,
      ]
      setTestConversation((previous) => [...previous, ...newLines].slice(-60))
      setMessage("")
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function showLogs() {
    if (!detail) return
    setBusy(true); setError("")
    try {
      const result = await api<{ runs: Array<Record<string, unknown>> }>(`/api/workflows/${detail.id}/logs`)
      setLogs(result.runs)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function showHeatmap() {
    if (!detail) return
    setBusy(true); setError("")
    try {
      const result = await api<{ results: Array<{ nodeId: string; status: string; count: number }> }>(`/api/workflows/${detail.id}/heatmap`)
      setHeatmap(result.results)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }

  async function showApi() {
    if (!detail) return
    try {
      setApiInfo(await api(`/api/workflows/${detail.id}/api`))
    } catch (e) { setError(errorMessage(e)) }
  }

  function exportWorkflow() {
    if (!detail) return
    const blob = new Blob([JSON.stringify({
      name: detail.name,
      description: detail.description,
      definition: detail.definition,
    }, null, 2)], { type: "application/json" })
    const href = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = href
    link.download = `${detail.name.replace(/[^\w-]+/g, "-").toLowerCase() || "fluxo"}.json`
    link.click()
    URL.revokeObjectURL(href)
  }

  const nodeUsage = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of heatmap ?? []) counts.set(item.nodeId, (counts.get(item.nodeId) ?? 0) + item.count)
    return counts
  }, [heatmap])
  const selectedNode = detail?.definition.nodes.find((node) => node.id === selectedNodeId) ?? null

  return (
    <section className={`workflow-page ${detail ? "workflow-page-editing" : ""}`}>
      <header className="workflow-heading">
        <div>
          <div className="workflow-eyebrow"><span>AV FLOW AUTOMATIONS</span><span>WHATSAPP + IA</span></div>
          <h1>Fluxos de IA</h1>
          <p>Crie automações visuais para conduzir cada conversa com inteligência.</p>
        </div>
        {canEdit && <button className="button workflow-create-button" onClick={() => setCreateOpen(true)} disabled={busy}><Plus size={17} /> Novo fluxo</button>}
      </header>

      {(error || notice) && (
        <div className={error ? "workflow-feedback error" : "workflow-feedback"} role={error ? "alert" : "status"}>
          {error || notice}
          <button className="icon-button" aria-label="Fechar aviso" onClick={() => { setError(""); setNotice("") }}><X size={15} /></button>
        </div>
      )}

      <div className="workflow-layout">
        <aside className="workflow-sidebar">
          <div className="workflow-sidebar-head">
            <div><h2>Seus fluxos</h2><p>{items.length} {items.length === 1 ? "automação" : "automações"}</p></div>
            {canEdit && <button className="workflow-icon-button" aria-label="Criar fluxo" title="Criar fluxo" onClick={() => setCreateOpen(true)}><Plus size={17} /></button>}
          </div>
          <label className="workflow-search">
            <Search size={16} />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar fluxo" aria-label="Buscar fluxo" />
          </label>
          <button className={`workflow-filter ${!showActiveOnly ? "selected" : ""}`} onClick={() => setShowActiveOnly(false)}>
            <span>Todos os fluxos</span><span>{items.length}</span>
          </button>
          <button className={`workflow-filter ${showActiveOnly ? "selected" : ""}`} onClick={() => setShowActiveOnly(true)}>
            <span><span className="workflow-status-dot active" /> Publicados</span>
            <span>{items.filter((item) => item.status === "active").length}</span>
          </button>
          <div className="workflow-list">
            {visibleItems.map((item) => (
              <button key={item.id} className={`workflow-list-item ${activeId === item.id ? "selected" : ""}`} onClick={() => { setActiveId(item.id); setSimulation(null); setLogs(null); setHeatmap(null); setError(""); setNotice("") }}>
                <span className={`workflow-list-icon ${item.status}`}><WorkflowIcon size={17} /></span>
                <span className="workflow-list-copy">
                  <b>{item.name}</b>
                  <small>{item.description || `Versão ${item.version}`}</small>
                </span>
                <span className={`workflow-status-dot ${item.status}`} title={statusLabel(item.status)} />
              </button>
            ))}
            {visibleItems.length === 0 && (
              <div className="workflow-list-empty">
                <WorkflowIcon size={19} />
                <p>{items.length ? "Nenhum fluxo corresponde à busca." : "Seus fluxos criados aparecem aqui."}</p>
              </div>
            )}
          </div>
          <div className="workflow-sidebar-footer">
            <span className="workflow-footer-icon"><Bot size={16} /></span>
            <span><b>Integrado à IA</b><small>Use o assistente nas etapas do fluxo.</small></span>
          </div>
        </aside>

        {!detail ? (
          <main className="workflow-empty">
            <div className="workflow-empty-grid" aria-hidden="true" />
            <div className="workflow-empty-content">
              <div className="workflow-preview">
                <div className="workflow-preview-node trigger"><MessageSquareText size={17} /><span><small>QUANDO</small>Nova mensagem recebida</span><span className="workflow-preview-port" /></div>
                <div className="workflow-preview-link"><i /><ArrowRight size={15} /></div>
                <div className="workflow-preview-node condition"><GitBranch size={17} /><span><small>VERIFICAR</small>Intenção do lead</span><span className="workflow-preview-port" /></div>
                <div className="workflow-preview-branch"><span><i /> Interessado</span><span><i /> Precisa de ajuda</span></div>
                <div className="workflow-preview-node action"><Sparkles size={17} /><span><small>ENTÃO</small>Responder com IA</span></div>
              </div>
              <span className="workflow-pill"><Sparkles size={13} /> AUTOMAÇÃO SEM CÓDIGO</span>
              <h2>{items.length ? "Escolha um fluxo para editar" : "Faça cada conversa avançar"}</h2>
              <p>{items.length ? "Selecione uma automação na lista ou crie um novo fluxo." : "Conecte mensagens, condições e ações em um fluxo simples — com seu assistente de IA sempre à mão."}</p>
              {canEdit && <button className="button workflow-create-button" onClick={() => setCreateOpen(true)}><Plus size={17} /> Criar meu primeiro fluxo</button>}
              <div className="workflow-capabilities">
                <span><MessageSquareText size={15} /> Gatilhos</span>
                <span><GitBranch size={15} /> Condições</span>
                <span><Bot size={15} /> Ações com IA</span>
              </div>
            </div>
          </main>
        ) : (
          <main className="workflow-editor">
            <div className="workflow-editor-toolbar">
              <button className="button secondary workflow-back" onClick={() => { setActiveId(""); setDetail(null); setSelectedNodeId(""); setInspectorOpen(false) }}>
                <ArrowLeft size={15} /> Voltar
              </button>
              <div className="workflow-toolbar-history">
                <button className="icon-button" title="Desfazer" aria-label="Desfazer" onClick={undo} disabled={!history.length}><RotateCcw size={15} /></button>
                <button className="icon-button" title="Refazer" aria-label="Refazer" onClick={redo} disabled={!future.length}><RotateCcw size={15} className="scale-x-[-1]" /></button>
              </div>
              <div className="workflow-toolbar-title">
                <input id="workflow-name" aria-label="Nome do fluxo" value={detail.name} disabled={!canEdit} onChange={(event) => setDetail({ ...detail, name: event.target.value })} maxLength={100} />
                <span className={`workflow-editor-status ${detail.status}`}>{detail.status === "active" ? "Ativo" : statusLabel(detail.status)}</span>
              </div>
              <div className="workflow-toolbar-actions">
                <button className="button secondary" onClick={() => { setInspectorOpen((value) => !value); if (!selectedNodeId) setSelectedNodeId(detail.definition.nodes[0]?.id ?? "") }}>
                  <Settings2 size={15} /> Configuração
                </button>
                <button className="button workflow-test-button" onClick={() => { setTestOpen(true); setTestDefinitionsOpen(false) }}>
                  <Play size={15} /> Testar Workflow
                </button>
                {canEdit && <>
                  <button className="icon-button" title="Salvar rascunho" aria-label="Salvar rascunho" disabled={busy} onClick={() => void save()}><Save size={16} /></button>
                  {detail.status === "active" ? (
                    <button className="button secondary" disabled={busy} onClick={() => void runAction("block")}><Ban size={15} /> Bloquear</button>
                  ) : (
                    <button className="button workflow-publish-button" disabled={busy} onClick={() => void runAction("publish")}><Play size={15} /> Publicar</button>
                  )}
                  <div className="workflow-more-menu">
                    <button className="icon-button" aria-label="Mais opções" aria-expanded={moreActionsOpen} onClick={() => setMoreActionsOpen((value) => !value)}><Ellipsis size={18} /></button>
                    {moreActionsOpen && (
                      <div className="workflow-more-popover">
                        <button onClick={() => { void runAction("duplicate"); setMoreActionsOpen(false) }}><Copy size={14} /> Duplicar</button>
                        <button onClick={() => { void showLogs(); setMoreActionsOpen(false) }}><Activity size={14} /> Logs</button>
                        <button onClick={() => { void showHeatmap(); setMoreActionsOpen(false) }}><Eye size={14} /> Heatmap</button>
                        <button onClick={() => { exportWorkflow(); setMoreActionsOpen(false) }}><Download size={14} /> Exportar</button>
                        <button onClick={() => { void showApi(); setMoreActionsOpen(false) }}><Code2 size={14} /> API</button>
                        <button className="danger" disabled={busy} onClick={() => { setMoreActionsOpen(false); void runAction("delete") }}><Trash2 size={14} /> Excluir fluxo</button>
                      </div>
                    )}
                  </div>
                </>}
              </div>
            </div>

            <label className="workflow-description">Descrição
              <input className="mt-1 w-full" value={detail.description} maxLength={500} disabled={!canEdit} onChange={(event) => setDetail({ ...detail, description: event.target.value })} placeholder="Descreva o objetivo deste fluxo" />
            </label>

            <div className={`workflow-editor-workspace ${inspectorOpen ? "inspector-open" : ""}`}>
              <WorkflowCanvas
                nodes={detail.definition.nodes}
                edges={detail.definition.edges}
                selectedNodeId={selectedNodeId}
                canEdit={canEdit}
                zoom={zoom}
                resetVersion={canvasResetVersion}
                nodeUsage={nodeUsage}
                connectionSource={connectionSource}
                onSelect={(nodeId) => { setSelectedNodeId(nodeId); setInspectorOpen(true) }}
                onMove={moveNodePosition}
                onStartConnection={startConnection}
                onConnect={connectNode}
                onAddNode={addNode}
                onRemove={removeNode}
                onDuplicate={duplicateNode}
                onZoom={(amount) => setZoom((value) => Math.min(1.5, Math.max(.5, value + amount)))}
                onReset={() => { setZoom(1); setCanvasResetVersion((value) => value + 1) }}
              />
              <aside className="workflow-inspector">
                <div className="workflow-inspector-heading">
                  <span><Sparkles size={16} /></span>
                  <div><b>Configuração da etapa</b><small>{selectedNode ? nodeLabel(selectedNode) : "Selecione um bloco no canvas"}</small></div>
                  <button type="button" className="icon-button" aria-label="Fechar configuração" onClick={() => setInspectorOpen(false)}><X size={15} /></button>
                </div>
                <div className="workflow-inspector-content">
              <div className="workflow-inspector-node">
                {detail.definition.nodes.filter((node) => node.id === selectedNodeId).map((node, index) => {
                  const outgoing = detail.definition.edges.filter((edge) => edge.source === node.id)
                  const target = outgoing.find((edge) => !edge.sourceHandle)?.target ?? ""
                  const trueTarget = outgoing.find((edge) => edge.sourceHandle === "true")?.target ?? ""
                  const falseTarget = outgoing.find((edge) => edge.sourceHandle === "false")?.target ?? ""
                  const availableTargets = detail.definition.nodes.filter((item) => item.id !== node.id)
                  return (
                    <article key={node.id} className="workflow-inspector-card">
                      <div className="flex items-start justify-between gap-2 border-b border-line p-3">
                        <div>
                          <span className="text-xs font-semibold uppercase tracking-wide text-blue-700">{node.type === "trigger" ? "Gatilho" : node.type === "condition" ? "Condição" : "Ação"} · {index + 1}</span>
                          <h3 className="mt-1 font-semibold">{nodeLabel(node)}</h3>
                          {nodeUsage.has(node.id) && <small className="muted">{nodeUsage.get(node.id)} execuções</small>}
                        </div>
                        {canEdit && node.type !== "trigger" && <button className="icon-button" aria-label={`Excluir bloco ${nodeLabel(node)}`} title="Excluir bloco" onClick={() => removeNode(node.id)}><Trash2 size={15} /></button>}
                      </div>
                      <div className="workflow-inspector-fields">
                        {canEdit && (
                          <>
                            <label>Nome do bloco (opcional)
                              <input className="mt-1 w-full" value={String(node.config.customLabel ?? "")} maxLength={60} placeholder={types[node.type].find((option) => option.value === node.kind)?.label ?? node.kind} onChange={(event) => updateConfig(node, "customLabel", event.target.value)} />
                            </label>
                            <label>Tipo
                              <select className="mt-1 w-full" value={node.kind} disabled={node.type === "trigger"} onChange={(event) => updateNode(node.id, { kind: event.target.value, config: { ...defaultConfig(node.type, event.target.value), customLabel: node.config.customLabel } })}>
                                {types[node.type].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                              </select>
                            </label>
                          </>
                        )}
                        {node.kind === "message_contains" && (
                          <label>Texto a procurar
                            <input className="mt-1 w-full" value={String(node.config.text ?? "")} maxLength={200} disabled={!canEdit} onChange={(event) => updateConfig(node, "text", event.target.value)} />
                          </label>
                        )}
                        {node.type === "condition" && node.kind === "lead_status" && (
                          <label>Status do lead
                            <select className="mt-1 w-full" value={String(node.config.status ?? "hot")} disabled={!canEdit} onChange={(event) => updateConfig(node, "status", event.target.value)}>
                              {leadStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                          </label>
                        )}
                        {node.kind === "send_message" && (
                          <label>Mensagem
                            <textarea className="mt-1 w-full" rows={4} maxLength={4096} value={String(node.config.text ?? "")} disabled={!canEdit} onChange={(event) => updateConfig(node, "text", event.target.value)} />
                            <small className="muted">Use {"{{contact.name}}"}, {"{{lead.status}}"} ou {"{{message.text}}"}.</small>
                          </label>
                        )}
                        {node.kind === "private_note" && (
                          <label>Nota para a equipe
                            <textarea className="mt-1 w-full" rows={3} maxLength={2000} value={String(node.config.text ?? "")} disabled={!canEdit} onChange={(event) => updateConfig(node, "text", event.target.value)} />
                          </label>
                        )}
                        {node.kind === "update_lead" && (
                          <>
                            <label>Novo status (opcional)
                              <select className="mt-1 w-full" value={String(node.config.status ?? "")} disabled={!canEdit} onChange={(event) => updateConfig(node, "status", event.target.value || undefined)}>
                                <option value="">Não alterar</option>
                                {leadStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                              </select>
                            </label>
                            <label>Produto de interesse<input className="mt-1 w-full" value={String(node.config.productInterest ?? "")} maxLength={160} disabled={!canEdit} onChange={(event) => updateConfig(node, "productInterest", event.target.value)} /></label>
                            <label>Próxima ação<input className="mt-1 w-full" value={String(node.config.nextAction ?? "")} maxLength={300} disabled={!canEdit} onChange={(event) => updateConfig(node, "nextAction", event.target.value)} /></label>
                            <label>Agendar follow-up em dias<input className="mt-1 w-full" type="number" min={0} max={365} value={Number(node.config.followUpDays ?? 0)} disabled={!canEdit} onChange={(event) => updateConfig(node, "followUpDays", Number(event.target.value))} /></label>
                          </>
                        )}
                        {node.kind === "set_priority" && (
                          <label><span><input type="checkbox" checked={node.config.enabled !== false} disabled={!canEdit} onChange={(event) => updateConfig(node, "enabled", event.target.checked)} /> Marcar conversa como prioritária</span></label>
                        )}
                        {node.kind === "assign_to_human" && (
                          <label>ID do membro responsável (opcional)
                            <input className="mt-1 w-full" value={String(node.config.assigneeId ?? "")} maxLength={80} disabled={!canEdit} onChange={(event) => updateConfig(node, "assigneeId", event.target.value)} />
                            <small className="muted">Sem ID, apenas sinaliza o pedido de atendimento humano.</small>
                          </label>
                        )}
                        {node.kind === "reply_with_ai" && <p className="muted"><Bot size={15} className="mr-1 inline" />A IA usa o perfil, as instruções e a base de conhecimento.</p>}
                        {node.type === "condition" && (
                          <div className="space-y-2 border-t border-line pt-3">
                            <label>Se verdadeiro →<select className="mt-1 w-full" value={trueTarget} disabled={!canEdit} onChange={(event) => updateConnection(node.id, "true", event.target.value)}>
                              <option value="">Selecionar etapa</option>{availableTargets.map((item) => <option key={item.id} value={item.id}>{nodeLabel(item)} · {item.id.slice(0, 8)}</option>)}
                            </select></label>
                            <label>Se falso →<select className="mt-1 w-full" value={falseTarget} disabled={!canEdit} onChange={(event) => updateConnection(node.id, "false", event.target.value)}>
                              <option value="">Selecionar etapa</option>{availableTargets.map((item) => <option key={item.id} value={item.id}>{nodeLabel(item)} · {item.id.slice(0, 8)}</option>)}
                            </select></label>
                          </div>
                        )}
                        {node.type !== "condition" && (
                          <label className="border-t border-line pt-3">Próxima etapa
                            <select className="mt-1 w-full" value={target} disabled={!canEdit || (node.type === "action" && node.kind === "stop")} onChange={(event) => updateConnection(node.id, undefined, event.target.value)}>
                              <option value="">Encerrar / sem conexão</option>{availableTargets.map((item) => <option key={item.id} value={item.id}>{nodeLabel(item)} · {item.id.slice(0, 8)}</option>)}
                            </select>
                          </label>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
                </div>
              </aside>
            </div>

            {logs && (
              <div className="mt-4 rounded-lg border border-line p-3">
                <h3 className="font-semibold">Execuções recentes</h3>
                {logs.length === 0 ? <p className="muted mt-2">Ainda não há execuções.</p> : <ul className="mt-2 space-y-2">{logs.map((run) => <li key={String(run.id)} className="border-t border-line pt-2 text-sm"><b>{String(run.status)}</b> · {String(run.startedAt)}{run.errorSummary ? <span className="auth-error"> · {String(run.errorSummary)}</span> : ""}<small className="muted block">{Array.isArray(run.steps) ? run.steps.length : 0} etapas registradas</small></li>)}</ul>}
              </div>
            )}
            {heatmap && <div className="mt-4 rounded-lg border border-line p-3"><h3 className="font-semibold">Heatmap de execução</h3><p className="muted mt-1">{heatmap.length ? heatmap.map((item) => `${item.nodeId}: ${item.count} ${item.status}`).join(" · ") : "Sem dados para exibir."}</p></div>}
            {notice && <p className="muted mt-3" role="status">{notice}</p>}
            {error && <p className="auth-error mt-3" role="alert">{error}</p>}
          </main>
        )}
      </div>
      {testOpen && detail && (
        <div className="workflow-test-backdrop" role="presentation" onClick={() => setTestOpen(false)}>
          <section className="workflow-test-panel" role="dialog" aria-modal="true" aria-labelledby="workflow-test-dialog-title" onClick={(event) => event.stopPropagation()}>
            <header className="workflow-test-header">
              <div className="workflow-test-tabs" role="tablist" aria-label="Testador do fluxo">
                <button type="button" role="tab" aria-selected={!testDefinitionsOpen} className={!testDefinitionsOpen ? "selected" : ""} onClick={() => setTestDefinitionsOpen(false)}>Testador de fluxo</button>
                <button type="button" role="tab" aria-selected={testDefinitionsOpen} className={testDefinitionsOpen ? "selected" : ""} onClick={() => setTestDefinitionsOpen(true)}><Settings2 size={14} /> Definições</button>
              </div>
              <button type="button" className="icon-button" aria-label="Fechar testador" onClick={() => setTestOpen(false)}><X size={17} /></button>
            </header>
            <div className="workflow-test-widget">
              <div className="workflow-test-widget-head">
                <div className="workflow-test-brand"><span><Bot size={18} /></span><div><b id="workflow-test-dialog-title">{detail.name}</b><small>Prévia do workflow · sem efeitos reais</small></div></div>
                <span className="workflow-test-online"><i /> Teste</span>
              </div>
              {testDefinitionsOpen ? (
                <div className="workflow-test-definitions" role="tabpanel">
                  <h2 id="workflow-test-title">Definições do teste</h2>
                  <p>Escolha os dados de exemplo usados para avaliar as condições do fluxo.</p>
                  <label>Status do lead
                    <select value={testLeadStatus} onChange={(event) => setTestLeadStatus(event.target.value)}>
                      {leadStatuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <label className="workflow-test-check"><input type="checkbox" checked={testPriority} onChange={(event) => setTestPriority(event.target.checked)} /> Conversa prioritária (VIP)</label>
                  <label className="workflow-test-check"><input type="checkbox" checked={testHumanRequested} onChange={(event) => setTestHumanRequested(event.target.checked)} /> Cliente pediu atendimento humano</label>
                  <label className="workflow-test-check"><input type="checkbox" checked={testHasFollowUp} onChange={(event) => setTestHasFollowUp(event.target.checked)} /> Possui follow-up agendado</label>
                  <div className="workflow-test-disclaimer">As mensagens e ações são simuladas. Nenhum contato será notificado e nenhum dado comercial será alterado.</div>
                  {simulation && (
                    <div className="workflow-test-trace">
                      <b>{simulation.matched ? "Gatilho acionado" : "Gatilho não acionado"}</b>
                      <ol>{simulation.steps.map((step) => <li key={step.id}>{step.result}</li>)}</ol>
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="workflow-test-chat" role="log" aria-live="polite">
                    <div className="workflow-test-welcome"><span><Bot size={20} /></span><b>Teste: {detail.name}</b><small>Envie uma mensagem para acompanhar o caminho percorrido no fluxo.</small></div>
                    {testConversation.length === 0 && <div className="workflow-test-line assistant">Olá! Esta é uma simulação segura do seu fluxo. Escreva uma mensagem para começar.</div>}
                    {testConversation.map((line) => <div key={line.id} className={`workflow-test-line ${line.role}`}>{line.text}</div>)}
                    {simulation && <div className={`workflow-test-result ${simulation.matched ? "matched" : ""}`} role="status">{simulation.matched ? "Fluxo executado" : "Gatilho não acionado"} · {simulation.steps.length} etapas avaliadas</div>}
                  </div>
                  <form className="workflow-test-composer" onSubmit={(event) => { event.preventDefault(); void test() }}>
                    <textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault()
                          void test()
                        }
                      }}
                      maxLength={1000}
                      placeholder="Escreva sua mensagem..."
                      aria-label="Mensagem para testar o fluxo"
                    />
                    <div className="workflow-test-composer-footer">
                      <small>{testPriority ? "Contato VIP" : `Lead ${leadStatuses.find(([value]) => value === testLeadStatus)?.[1]}`}</small>
                      <button type="submit" disabled={busy || !message.trim()} aria-label="Enviar mensagem de teste" title="Enviar teste">
                        {busy ? <span className="workflow-test-spinner" /> : <Send size={17} />}
                      </button>
                    </div>
                  </form>
                  <div className="workflow-test-powered">Simulação local do AV Flow · nenhum envio real</div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {createOpen && (
        <div className="modal-backdrop" role="presentation" onClick={() => setCreateOpen(false)}>
          <section className="modal workflow-create-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-create-title" onClick={(event) => event.stopPropagation()}>
            <div className="panel-title">
              <div><h2 id="workflow-create-title">Novo fluxo</h2><p>Comece com um rascunho e organize as etapas no canvas.</p></div>
              <button className="icon-button" aria-label="Fechar" onClick={() => setCreateOpen(false)}><X size={17} /></button>
            </div>
            <form className="workflow-create-form" onSubmit={(event) => void createWorkflow(event)}>
              <label>Nome do fluxo
                <input autoFocus value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={100} placeholder="Ex.: Qualificação de novos leads" required />
              </label>
              <label>Descrição (opcional)
                <textarea value={newDescription} onChange={(event) => setNewDescription(event.target.value)} maxLength={500} placeholder="O que este fluxo deve fazer?" />
              </label>
              <div className="workflow-create-actions">
                <button className="button secondary" type="button" onClick={() => setCreateOpen(false)}>Cancelar</button>
                <button className="button" type="submit" disabled={busy || !newName.trim()}><Plus size={15} /> Criar rascunho</button>
              </div>
            </form>
          </section>
        </div>
      )}
      {apiInfo && <div className="modal-backdrop" role="presentation" onClick={() => setApiInfo(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="workflow-api-title" onClick={(event) => event.stopPropagation()}><div className="panel-title"><h2 id="workflow-api-title">API do fluxo</h2><button className="icon-button" aria-label="Fechar" onClick={() => setApiInfo(null)}><X size={18} /></button></div><p className="muted">{apiInfo.note}</p><pre className="mt-3 overflow-auto rounded bg-slate-100 p-3 text-sm">{apiInfo.endpoint}</pre><button className="button secondary mt-3" onClick={() => void navigator.clipboard.writeText(apiInfo.endpoint)}>Copiar endpoint</button></section></div>}
    </section>
  )
}
