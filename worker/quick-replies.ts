import type { Env, Session } from "./index"

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } })

export async function quickReplyRoutes(request: Request, env: Env, url: URL, auth: Session): Promise<Response | null> {
  const match = url.pathname.match(/^\/api\/quick-replies(?:\/([\w-]+))?$/)
  if (!match) return null
  const id = match[1]
  const org = auth.organizationId
  if (!id && request.method === "GET") {
    const rows = await env.DB.prepare(
      "SELECT id,title,body FROM quick_replies WHERE organization_id=? ORDER BY title COLLATE NOCASE,id",
    ).bind(org).all()
    return json({ results: rows.results })
  }
  if ((!id && request.method === "POST") || (id && request.method === "PUT")) {
    let data: { title?: unknown; body?: unknown }
    try { data = await request.json() } catch { return json({ error: "Dados inválidos." }, 400) }
    if (!data || typeof data.title !== "string" || !data.title.trim() || data.title.trim().length > 80 ||
      typeof data.body !== "string" || !data.body.trim() || data.body.trim().length > 4096)
      return json({ error: "Informe um título de até 80 caracteres e uma mensagem de até 4096 caracteres." }, 400)
    if (id) {
      const result = await env.DB.prepare(
        "UPDATE quick_replies SET title=?,body=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      ).bind(data.title.trim(), data.body.trim(), id, org).run()
      if (!result.meta.changes) return json({ error: "Mensagem rápida não encontrada." }, 404)
      return json({ ok: true })
    }
    const newId = crypto.randomUUID()
    await env.DB.prepare("INSERT INTO quick_replies(id,organization_id,title,body,created_by) VALUES(?,?,?,?,?)")
      .bind(newId, org, data.title.trim(), data.body.trim(), auth.userId).run()
    return json({ id: newId }, 201)
  }
  if (id && request.method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM quick_replies WHERE id=? AND organization_id=?").bind(id, org).run()
    if (!result.meta.changes) return json({ error: "Mensagem rápida não encontrada." }, 404)
    return json({ ok: true })
  }
  return json({ error: "Método não permitido." }, 405)
}
