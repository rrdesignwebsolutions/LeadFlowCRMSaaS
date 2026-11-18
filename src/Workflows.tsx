import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Activity,
  Ban,
  Bot,
  Code2,
  Copy,
  Crosshair,
  Download,
  Eye,
  Play,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Workflow as WorkflowIcon,
  X,
} from "lucide-react"
import { api, errorMessage } from "./api"

type NodeType = "trigger" | "condition" | "action"
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

const defaultDefinition: Definition = {
  nodes: [
    {
      id: "trigger",
      type: "trigger",
      kind: "message_received",
      config: {},
      position: { x: 80, y: 120 },
    },
  ],
  edges: [],
}

const makeId = () => `node-${crypto.randomUUID().slice(0, 8)}`

function nodeLabel(node: Node) {
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

export default function Workflows({ canEdit }: { canEdit: boolean }) {
  const [items, setItems] = useState<Summary[]>([])
  const [activeId, setActiveId] = useState("")
  const [detail, setDetail] = useState<WorkflowDetail | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const [message, setMessage] = useState("")
  const [simulation, setSimulation] = useState<Simulation | null>(null)
  const [logs, setLogs] = useState<Array<Record<string, unknown>> | null>(null)
  const [heatmap, setHeatmap] = useState<Array<{ nodeId: string; status: string; count: number }> | null>(null)
  const [apiInfo, setApiInfo] = useState<{ endpoint: string; note: string } | null>(null)
  const [showActiveOnly, setShowActiveOnly] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [history, setHistory] = useState<Definition[]>([])
  const [future, setFuture] = useState<Definition[]>([])

  const loadList = useCallback(async () => {
    try {
      const response = await api<{ results: Summary[] }>("/api/workflows")
      setItems(response.results)
      if (!activeId && response.results[0]) setActiveId(response.results[0].id)
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [activeId])

  const loadDetail = useCallback(async (id: string) => {
    if (!id) {
      setDetail(null)
      return
    }
    try {
      const response = await api<WorkflowDetail>(`/api/workflows/${id}`)
      setDetail(response)
      setHistory([])
      setFuture([])
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])

  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => { void loadDetail(activeId) }, [activeId, loadDetail])

  const visibleItems = useMemo(
    () => showActiveOnly ? items.filter((item) => item.status === "active") : items,
    [items, showActiveOnly],
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

  function addNode(type: NodeType) {
    if (!detail) return
    const id = makeId()
    const kind = type === "condition" ? "message_contains" : type === "trigger" ? "message_received" : "send_message"
    const node: Node = {
      id,
      type,
      kind,
      config: defaultConfig(type, kind),
      position: { x: 80 + detail.definition.nodes.length * 40, y: 120 + detail.definition.nodes.length * 24 },
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
          position: { x: node.position!.x + 320, y: node.position!.y - 70 },
        },
        {
          id: falseId,
          type: "action",
          kind: "stop",
          config: {},
          position: { x: node.position!.x + 320, y: node.position!.y + 90 },
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
  }

  function updateConnection(source: string, handle: "true" | "false" | undefined, target: string) {
    if (!detail) return
    const without = detail.definition.edges.filter(
      (edge) => edge.source !== source || edge.sourceHandle !== handle,
    )
    if (target) without.push({ id: makeId(), source, target, ...(handle ? { sourceHandle: handle } : {}) })
    changeDefinition({ ...detail.definition, edges: without })
  }

  function removeNode(nodeId: string) {
    if (!detail || detail.definition.nodes.find((node) => node.id === nodeId)?.type === "trigger") return
    changeDefinition({
      nodes: detail.definition.nodes.filter((node) => node.id !== nodeId),
      edges: detail.definition.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
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

  async function createWorkflow() {
    const name = prompt("Nome do novo fluxo:")
    if (!name?.trim()) return
    setBusy(true); setError(""); setNotice("")
    try {
      const result = await api<{ id: string }>("/api/workflows", {
        method: "POST",
        body: { name: name.trim(), description: "", definition: defaultDefinition },
      })
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
    setBusy(true); setError(""); setNotice("")
    try {
      const response = await api<Simulation>(`/api/workflows/${detail.id}/test`, {
        method: "POST",
        body: { message, leadStatus: "new" },
      })
      setSimulation(response)
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

  return (
    <section className="space-y-4">
      <header className="page-heading">
        <div>
          <h1><WorkflowIcon size={24} /> Construtor de fluxos</h1>
          <p>Automatize conversas do WhatsApp com condições, ações e respostas integradas à IA.</p>
        </div>
        {canEdit && <button className="button" onClick={() => void createWorkflow()} disabled={busy}><Plus size={16} /> Criar fluxo</button>}
      </header>

      <div className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="panel p-4">
          <div className="flex items-center justify-between gap-2">
            <h2>Seus fluxos</h2>
            <button className="button secondary" onClick={() => setShowActiveOnly((value) => !value)}>{showActiveOnly ? "Todos" : "Ativos"}</button>
          </div>
          {visibleItems.length === 0 ? <p className="muted mt-4">Nenhum fluxo encontrado. Crie um rascunho para começar.</p> : (
            <ul className="mt-3 space-y-2">
              {visibleItems.map((item) => (
                <li key={item.id}>
                  <button className={`w-full rounded-lg border p-3 text-left ${activeId === item.id ? "border-blue-500 bg-blue-50" : "border-line"}`} onClick={() => { setActiveId(item.id); setSimulation(null); setLogs(null); setHeatmap(null) }}>
                    <span className="block font-medium">{item.name}</span>
                    <span className="muted text-xs">{statusLabel(item.status)} · v{item.version}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5 border-t border-line pt-4">
            <h3 className="font-semibold">Recursos do fluxo</h3>
            <ul className="mt-2 space-y-1 text-sm text-muted">
              <li>Gatilhos por mensagem ou botão</li>
              <li>Condições por lead e conversa</li>
              <li>Mensagens, notas e atualizações</li>
              <li>Teste sem efeitos reais</li>
            </ul>
          </div>
        </aside>

        {!detail ? (
          <div className="panel grid min-h-72 place-items-center p-8 text-center">
            <div><WorkflowIcon size={34} className="mx-auto text-muted" /><h2 className="mt-3">Selecione ou crie um fluxo</h2><p className="muted mt-1">Cada fluxo publicado é executado para novas mensagens elegíveis.</p></div>
          </div>
        ) : (
          <div className="panel min-w-0 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
              <div className="flex min-w-56 flex-1 items-center gap-3">
                <div className="min-w-0 flex-1">
                  <label className="muted text-xs" htmlFor="workflow-name">Nome do fluxo</label>
                  <input id="workflow-name" className="w-full font-semibold" value={detail.name} disabled={!canEdit} onChange={(event) => setDetail({ ...detail, name: event.target.value })} maxLength={100} />
                </div>
                <span className={`tag ${detail.status === "active" ? "" : "warning"}`}>{statusLabel(detail.status)}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="button secondary" title="Desfazer" onClick={undo} disabled={!history.length}><RotateCcw size={15} /></button>
                <button className="button secondary" title="Refazer" onClick={redo} disabled={!future.length}><RotateCcw size={15} className="scale-x-[-1]" /></button>
                <button className="button secondary" title="Centralizar fluxo" onClick={() => { setZoom(1); document.getElementById("workflow-canvas")?.scrollTo({ left: 0, top: 0, behavior: "smooth" }) }}><Crosshair size={15} /></button>
                <button className="button secondary" title="Reduzir" onClick={() => setZoom((value) => Math.max(.65, value - .1))}>−</button>
                <button className="button secondary" title="Ampliar" onClick={() => setZoom((value) => Math.min(1.25, value + .1))}>+</button>
                <button className="button secondary" onClick={() => void showLogs()}><Activity size={15} /> Logs</button>
                <button className="button secondary" onClick={() => void showHeatmap()}><Eye size={15} /> Heatmap</button>
                <button className="button secondary" onClick={exportWorkflow}><Download size={15} /> Exportar</button>
                <button className="button secondary" onClick={() => void showApi()}><Code2 size={15} /> API</button>
                {canEdit && <>
                  <button className="button secondary" disabled={busy} onClick={() => void runAction("duplicate")}><Copy size={15} /> Duplicar</button>
                  <button className="button secondary" disabled={busy} onClick={() => void save()}><Save size={15} /> Salvar</button>
                  {detail.status === "active" ? (
                    <button className="button secondary" disabled={busy} onClick={() => void runAction("block")}><Ban size={15} /> Bloquear</button>
                  ) : (
                    <button className="button" disabled={busy} onClick={() => void runAction("publish")}><Play size={15} /> Publicar</button>
                  )}
                  <button className="icon-button" aria-label="Excluir fluxo" disabled={busy} onClick={() => void runAction("delete")}><Trash2 size={16} /></button>
                </>}
              </div>
            </div>

            <label className="mt-4 block">Descrição
              <input className="mt-1 w-full" value={detail.description} maxLength={500} disabled={!canEdit} onChange={(event) => setDetail({ ...detail, description: event.target.value })} placeholder="Descreva o objetivo deste fluxo" />
            </label>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                {canEdit && <>
                  <button className="button secondary" onClick={() => addNode("condition")}><Plus size={15} /> Condição</button>
                  <button className="button secondary" onClick={() => addNode("action")}><Plus size={15} /> Ação</button>
                </>}
                <button className="button secondary" onClick={() => void test()} disabled={busy}><Play size={15} /> Testar fluxo</button>
              </div>
              <small className="muted">WhatsApp · gatilho: nova mensagem recebida</small>
            </div>

            <div id="workflow-canvas" className="mt-4 max-h-[60vh] overflow-auto rounded-xl border border-line bg-slate-50 p-4">
              <div className="flex min-w-max items-start gap-4" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}>
                {detail.definition.nodes.map((node, index) => {
                  const outgoing = detail.definition.edges.filter((edge) => edge.source === node.id)
                  const target = outgoing.find((edge) => !edge.sourceHandle)?.target ?? ""
                  const trueTarget = outgoing.find((edge) => edge.sourceHandle === "true")?.target ?? ""
                  const falseTarget = outgoing.find((edge) => edge.sourceHandle === "false")?.target ?? ""
                  const availableTargets = detail.definition.nodes.filter((item) => item.id !== node.id)
                  return (
                    <article key={node.id} className="w-[300px] shrink-0 rounded-xl border border-line bg-white shadow-sm">
                      <div className="flex items-start justify-between gap-2 border-b border-line p-3">
                        <div>
                          <span className="text-xs font-semibold uppercase tracking-wide text-blue-700">{node.type === "trigger" ? "Gatilho" : node.type === "condition" ? "Condição" : "Ação"} · {index + 1}</span>
                          <h3 className="mt-1 font-semibold">{nodeLabel(node)}</h3>
                          {nodeUsage.has(node.id) && <small className="muted">{nodeUsage.get(node.id)} execuções</small>}
                        </div>
                        {canEdit && node.type !== "trigger" && <button className="icon-button" aria-label="Remover etapa" onClick={() => removeNode(node.id)}><X size={15} /></button>}
                      </div>
                      <div className="space-y-3 p-3">
                        {canEdit && (
                          <label>Tipo
                            <select className="mt-1 w-full" value={node.kind} disabled={node.type === "trigger"} onChange={(event) => updateNode(node.id, { kind: event.target.value, config: defaultConfig(node.type, event.target.value) })}>
                              {types[node.type].map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                            </select>
                          </label>
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

            <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]">
              <label>Mensagem de exemplo para testar
                <input className="mt-1 w-full" value={message} maxLength={1000} onChange={(event) => setMessage(event.target.value)} placeholder="Ex.: Quero saber sobre financiamento" />
              </label>
              <div className="flex items-end gap-2">
                <button className="button secondary" onClick={() => void test()} disabled={busy}><Play size={15} /> Executar simulação</button>
              </div>
            </div>
            {simulation && (
              <div className="mt-4 rounded-lg border border-line p-3" role="status">
                <b>{simulation.matched ? "Gatilho acionado" : "Gatilho não acionado"}</b>
                <small className="muted ml-2">Simulação sem efeitos reais</small>
                <ol className="mt-2 list-inside list-decimal">
                  {simulation.steps.map((step) => <li key={step.id}>{step.result}</li>)}
                </ol>
              </div>
            )}
            {logs && (
              <div className="mt-4 rounded-lg border border-line p-3">
                <h3 className="font-semibold">Execuções recentes</h3>
                {logs.length === 0 ? <p className="muted mt-2">Ainda não há execuções.</p> : <ul className="mt-2 space-y-2">{logs.map((run) => <li key={String(run.id)} className="border-t border-line pt-2 text-sm"><b>{String(run.status)}</b> · {String(run.startedAt)}{run.errorSummary ? <span className="auth-error"> · {String(run.errorSummary)}</span> : ""}<small className="muted block">{Array.isArray(run.steps) ? run.steps.length : 0} etapas registradas</small></li>)}</ul>}
              </div>
            )}
            {heatmap && <div className="mt-4 rounded-lg border border-line p-3"><h3 className="font-semibold">Heatmap de execução</h3><p className="muted mt-1">{heatmap.length ? heatmap.map((item) => `${item.nodeId}: ${item.count} ${item.status}`).join(" · ") : "Sem dados para exibir."}</p></div>}
            {notice && <p className="muted mt-3" role="status">{notice}</p>}
            {error && <p className="auth-error mt-3" role="alert">{error}</p>}
          </div>
        )}
      </div>
      {apiInfo && <div className="modal-backdrop" role="presentation" onClick={() => setApiInfo(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="workflow-api-title" onClick={(event) => event.stopPropagation()}><div className="panel-title"><h2 id="workflow-api-title">API do fluxo</h2><button className="icon-button" aria-label="Fechar" onClick={() => setApiInfo(null)}><X size={18} /></button></div><p className="muted">{apiInfo.note}</p><pre className="mt-3 overflow-auto rounded bg-slate-100 p-3 text-sm">{apiInfo.endpoint}</pre><button className="button secondary mt-3" onClick={() => void navigator.clipboard.writeText(apiInfo.endpoint)}>Copiar endpoint</button></section></div>}
    </section>
  )
}
