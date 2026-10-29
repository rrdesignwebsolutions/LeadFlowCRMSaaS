/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  SESSION_SECRET: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
}

type Session = { userId: string; organizationId: string; role: string };
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const id = () => crypto.randomUUID();
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
export const sha256 = async (value: string) => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
export const constantTimeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 210000 }, key, 256));
}

function cookie(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function session(request: Request, env: Env): Promise<Session | null> {
  const token = cookie(request, "__Host-avflow_session");
  if (!token) return null;
  const row = await env.DB.prepare(`
    SELECT s.user_id userId, s.organization_id organizationId, m.role
    FROM sessions s JOIN organization_members m ON m.user_id=s.user_id AND m.organization_id=s.organization_id
    WHERE s.token_hash=? AND s.expires_at > CURRENT_TIMESTAMP AND m.status='active'
  `).bind(await sha256(token)).first<Session>();
  return row ?? null;
}

async function audit(env: Env, auth: Session, action: string, resourceType: string, resourceId?: string) {
  await env.DB.prepare("INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type,resource_id) VALUES(?,?,?,?,?,?)")
    .bind(id(), auth.organizationId, auth.userId, action, resourceType, resourceId ?? null).run();
}

async function authRoutes(request: Request, env: Env, path: string) {
  if (path === "/api/auth/register" && request.method === "POST") {
    const body = await request.json<{ company?: string; name?: string; email?: string; password?: string }>();
    if (!body.company?.trim() || !body.name?.trim() || !body.email?.includes("@") || (body.password?.length ?? 0) < 12)
      return json({ error: "Dados inválidos. A senha deve ter pelo menos 12 caracteres." }, 400);
    const userId = id(), orgId = id(), salt = id(), email = body.email.toLowerCase().trim();
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)").bind(orgId, body.company.trim(), `${body.company.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${orgId.slice(0, 6)}`),
        env.DB.prepare("INSERT INTO users(id,email,name,password_hash,password_salt) VALUES(?,?,?,?,?)").bind(userId, email, body.name.trim(), await passwordHash(body.password!, salt), salt),
        env.DB.prepare("INSERT INTO organization_members(organization_id,user_id,role) VALUES(?,?,'admin')").bind(orgId, userId),
        env.DB.prepare("INSERT INTO subscriptions(id,organization_id) VALUES(?,?)").bind(id(), orgId),
      ]);
      return await createSession(env, userId, orgId, 201);
    } catch {
      return json({ error: "Não foi possível criar a conta. Verifique se o e-mail já existe." }, 409);
    }
  }
  if (path === "/api/auth/login" && request.method === "POST") {
    const body = await request.json<{ email?: string; password?: string }>();
    const user = await env.DB.prepare("SELECT id,password_hash,password_salt,failed_login_count,locked_until FROM users WHERE email=? COLLATE NOCASE")
      .bind(body.email?.trim() ?? "").first<{ id:string; password_hash:string; password_salt:string; failed_login_count:number; locked_until:string|null }>();
    if (!user || (user.locked_until && new Date(user.locked_until) > new Date())) return json({ error: "Credenciais inválidas ou acesso temporariamente bloqueado." }, 401);
    const valid = constantTimeEqual(await passwordHash(body.password ?? "", user.password_salt), user.password_hash);
    if (!valid) {
      const attempts = user.failed_login_count + 1;
      await env.DB.prepare("UPDATE users SET failed_login_count=?,locked_until=CASE WHEN ?>=5 THEN datetime('now','+15 minutes') ELSE NULL END WHERE id=?").bind(attempts, attempts, user.id).run();
      return json({ error: "Credenciais inválidas." }, 401);
    }
    const member = await env.DB.prepare("SELECT organization_id FROM organization_members WHERE user_id=? AND status='active' LIMIT 1").bind(user.id).first<{ organization_id:string }>();
    if (!member) return json({ error: "Usuário sem organização ativa." }, 403);
    await env.DB.prepare("UPDATE users SET failed_login_count=0,locked_until=NULL WHERE id=?").bind(user.id).run();
    return createSession(env, user.id, member.organization_id);
  }
  return null;
}

async function createSession(env: Env, userId: string, orgId: string, status = 200) {
  const token = `${id()}${id()}`;
  await env.DB.prepare("INSERT INTO sessions(id,token_hash,user_id,organization_id,expires_at) VALUES(?,?,?,?,datetime('now','+7 days'))")
    .bind(id(), await sha256(token), userId, orgId).run();
  return json({ ok: true }, status, { "set-cookie": `__Host-avflow_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800` });
}

export async function verifyMetaSignature(request: Request, secret: string, raw: string) {
  const provided = request.headers.get("x-hub-signature-256");
  if (!provided?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = `sha256=${hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))}`;
  return constantTimeEqual(provided, expected);
}

async function webhook(request: Request, env: Env, url: URL) {
  if (request.method === "GET") {
    const valid = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === env.META_VERIFY_TOKEN;
    return valid ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
  }
  if (!env.META_APP_SECRET) return json({ error: "Webhook não configurado." }, 503);
  const raw = await request.text();
  if (!(await verifyMetaSignature(request, env.META_APP_SECRET, raw))) return json({ error: "Assinatura inválida." }, 401);
  const payload = JSON.parse(raw) as { entry?: Array<{ id?:string; changes?: Array<{ value?: { metadata?:{ phone_number_id?:string }; messages?:Array<{id?:string}>; statuses?:Array<{id?:string;status?:string}> } }> }> };
  for (const entry of payload.entry ?? []) for (const change of entry.changes ?? []) {
    const value = change.value, phone = value?.metadata?.phone_number_id;
    const integration = phone ? await env.DB.prepare(
      "SELECT organization_id FROM integrations WHERE provider='meta_whatsapp' AND phone_number_id=? AND status='connected'"
    ).bind(phone).first<{ organization_id:string }>() : null;
    for (const item of [...(value?.messages ?? []), ...(value?.statuses ?? [])]) {
      const externalId = `${item.id}:${"status" in item ? item.status : "message"}`;
      await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events(id,provider,external_event_id,phone_number_id,organization_id,payload_hash,status)
        VALUES(?,'meta_whatsapp',?,?,?,?,?)`).bind(
          id(), externalId, phone ?? null, integration?.organization_id ?? null, await sha256(raw), integration ? "received" : "ignored"
        ).run();
    }
  }
  return json({ received: true });
}

async function api(request: Request, env: Env, url: URL) {
  const authResult = await authRoutes(request, env, url.pathname);
  if (authResult) return authResult;
  if (url.pathname === "/api/webhooks/meta") return webhook(request, env, url);
  if (url.pathname === "/api/health") return json({ status: "ok", database: "configured" });
  const auth = await session(request, env);
  if (!auth) return json({ error: "Não autenticado." }, 401);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = cookie(request, "__Host-avflow_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": "__Host-avflow_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }
  if (url.pathname === "/api/me") {
    const data = await env.DB.prepare(`SELECT u.name,u.email,o.name organization,m.role FROM users u
      JOIN organization_members m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
      WHERE u.id=? AND o.id=?`).bind(auth.userId, auth.organizationId).first();
    return json(data);
  }
  if (url.pathname === "/api/dashboard") {
    const metrics = await env.DB.prepare(`SELECT COUNT(*) leads,
      SUM(CASE WHEN status='qualified' THEN 1 ELSE 0 END) qualified,
      SUM(CASE WHEN status='hot' THEN 1 ELSE 0 END) hot,
      SUM(CASE WHEN status='sold' THEN 1 ELSE 0 END) sold FROM leads WHERE organization_id=?`).bind(auth.organizationId).first();
    return json(metrics);
  }
  if (url.pathname === "/api/leads" && request.method === "GET") {
    return json(await env.DB.prepare(`SELECT l.id,l.status,l.product_interest,l.updated_at,c.name,c.phone_e164
      FROM leads l JOIN contacts c ON c.id=l.contact_id WHERE l.organization_id=? ORDER BY l.updated_at DESC LIMIT 100`)
      .bind(auth.organizationId).all());
  }
  if (url.pathname.startsWith("/api/leads/") && request.method === "PATCH") {
    const leadId = url.pathname.split("/").pop()!, body = await request.json<{ status?:string }>();
    const allowed = ["new","not_contacted","in_service","hot","qualified","negotiating","follow_up","cold","lost","sold"];
    if (!body.status || !allowed.includes(body.status)) return json({ error: "Status inválido." }, 400);
    const lead = await env.DB.prepare("SELECT status FROM leads WHERE id=? AND organization_id=?").bind(leadId, auth.organizationId).first<{status:string}>();
    if (!lead) return json({ error: "Lead não encontrado." }, 404);
    if (body.status === "sold") return json({ error: "Venda exige confirmação de valor e data no endpoint de vendas." }, 422);
    await env.DB.batch([
      env.DB.prepare("UPDATE leads SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").bind(body.status, leadId, auth.organizationId),
      env.DB.prepare("INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,?,?,?)").bind(id(), auth.organizationId, leadId, lead.status, body.status, auth.userId)
    ]);
    await audit(env, auth, "lead.status_changed", "lead", leadId);
    return json({ ok: true });
  }
  return json({ error: "Rota não encontrada." }, 404);
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        const isWebhook = url.pathname === "/api/webhooks/meta";
        const origin = request.headers.get("origin");
        if (isMutation && !isWebhook && origin && origin !== env.APP_ORIGIN) return json({ error: "Origem não permitida." }, 403);
        const response = await api(request, env, url);
        const headers = new Headers(response.headers);
        headers.set("x-content-type-options", "nosniff");
        headers.set("x-frame-options", "DENY");
        headers.set("referrer-policy", "strict-origin-when-cross-origin");
        headers.set("content-security-policy", "default-src 'self'; frame-ancestors 'none'; base-uri 'self'");
        return new Response(response.body, { status: response.status, headers });
      }
      catch (error) { console.error("request_failed", error instanceof Error ? error.message : "unknown"); return json({ error: "Erro interno." }, 500); }
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
