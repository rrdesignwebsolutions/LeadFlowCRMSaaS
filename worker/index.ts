/// <reference types="@cloudflare/workers-types" />

import { handleMetaPayload, whatsappRoutes } from "./whatsapp";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  SESSION_SECRET?: string;
  META_APP_SECRET?: string;
  META_VERIFY_TOKEN?: string;
  ENCRYPTION_KEY?: string;
  GRAPH_API_BASE?: string;
}

export type Session = { userId: string; organizationId: string; role: string };
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
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256));
}

function cookie(request: Request, name: string) {
  return request.headers.get("cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function session(request: Request, env: Env): Promise<Session | null> {
  const token = cookie(request, "__Host-av_flow_crm_session");
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
    const body = await request.json<{ company?: string; name?: string; email?: string; password?: string; inviteToken?: string }>();
    if (body.inviteToken) return acceptInvite(env, body);
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
    } catch (error) {
      console.error("register_failed", error instanceof Error ? error.message : "unknown");
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

const PLAN_USER_LIMIT = 3;
const ROLES = ["admin", "manager", "agent"];
const LEAD_STATUSES = ["new", "not_contacted", "in_service", "hot", "qualified", "negotiating", "follow_up", "cold", "lost", "sold"];

async function findInvite(env: Env, token: string) {
  return env.DB.prepare(`SELECT i.id,i.organization_id organizationId,i.email,i.role,o.name organization FROM invitations i
    JOIN organizations o ON o.id=i.organization_id
    WHERE i.token_hash=? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP`)
    .bind(await sha256(token)).first<{ id: string; organizationId: string; email: string; role: string; organization: string }>();
}

async function seatsUsed(env: Env, orgId: string) {
  const row = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM organization_members WHERE organization_id=? AND status='active') +
    (SELECT COUNT(*) FROM invitations WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP) n`)
    .bind(orgId, orgId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function acceptInvite(env: Env, body: { name?: string; email?: string; password?: string; inviteToken?: string }) {
  if (!body.name?.trim() || (body.password?.length ?? 0) < 12) return json({ error: "Dados inválidos. A senha deve ter pelo menos 12 caracteres." }, 400);
  const invite = await findInvite(env, body.inviteToken!);
  if (!invite) return json({ error: "Convite inválido ou expirado." }, 400);
  const userId = id(), salt = id();
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(id,email,name,password_hash,password_salt) VALUES(?,?,?,?,?)").bind(userId, invite.email.toLowerCase(), body.name.trim(), await passwordHash(body.password!, salt), salt),
      env.DB.prepare("INSERT INTO organization_members(organization_id,user_id,role) VALUES(?,?,?)").bind(invite.organizationId, userId, invite.role),
      env.DB.prepare("UPDATE invitations SET accepted_at=CURRENT_TIMESTAMP WHERE id=? AND accepted_at IS NULL").bind(invite.id),
    ]);
    return await createSession(env, userId, invite.organizationId, 201);
  } catch (error) {
    console.error("invite_accept_failed", error instanceof Error ? error.message : "unknown");
    return json({ error: "Não foi possível aceitar o convite. Este e-mail já pode ter uma conta." }, 409);
  }
}

function normalizePhone(value: unknown) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  return digits.length >= 12 && digits.length <= 15 ? `+${digits}` : null;
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);

async function createSession(env: Env, userId: string, orgId: string, status = 200) {
  const token = `${id()}${id()}`;
  await env.DB.prepare("INSERT INTO sessions(id,token_hash,user_id,organization_id,expires_at) VALUES(?,?,?,?,datetime('now','+7 days'))")
    .bind(id(), await sha256(token), userId, orgId).run();
  return json({ ok: true }, status, { "set-cookie": `__Host-av_flow_crm_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800` });
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
  let payload: Parameters<typeof handleMetaPayload>[1];
  try { payload = JSON.parse(raw); } catch { return json({ error: "Corpo inválido." }, 400); }
  await handleMetaPayload(env, payload, await sha256(raw));
  return json({ received: true });
}

async function api(request: Request, env: Env, url: URL) {
  const authResult = await authRoutes(request, env, url.pathname);
  if (authResult) return authResult;
  if (url.pathname === "/api/webhooks/meta") return webhook(request, env, url);
  if (url.pathname === "/api/health") {
    await env.DB.prepare("SELECT 1").first();
    return json({ status: "ok", database: "connected" });
  }
  if (url.pathname === "/api/invitations/lookup" && request.method === "GET") {
    const invite = await findInvite(env, url.searchParams.get("token") ?? "");
    return invite ? json({ email: invite.email, organization: invite.organization, role: invite.role }) : json({ error: "Convite inválido ou expirado." }, 404);
  }
  const auth = await session(request, env);
  if (!auth) return json({ error: "Não autenticado." }, 401);
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const token = cookie(request, "__Host-av_flow_crm_session");
    if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return json({ ok: true }, 200, { "set-cookie": "__Host-av_flow_crm_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  }
  if (url.pathname === "/api/me") {
    const data = await env.DB.prepare(`SELECT u.name,u.email,o.name organization,m.role FROM users u
      JOIN organization_members m ON m.user_id=u.id JOIN organizations o ON o.id=m.organization_id
      WHERE u.id=? AND o.id=?`).bind(auth.userId, auth.organizationId).first();
    return json(data);
  }
  if (url.pathname === "/api/dashboard") {
    const metrics = await env.DB.prepare(`SELECT COUNT(*) leads,
      COALESCE(SUM(status='qualified'),0) qualified,
      COALESCE(SUM(status='hot'),0) hot,
      COALESCE(SUM(status='sold'),0) sold,
      COALESCE(SUM(status NOT IN ('sold','lost','cold')),0) active FROM leads WHERE organization_id=?`).bind(auth.organizationId).first();
    const seats = await seatsUsed(env, auth.organizationId);
    return json({ ...metrics, seats, seatLimit: PLAN_USER_LIMIT });
  }
  if (url.pathname === "/api/reports") {
    const byStatus = await env.DB.prepare("SELECT status, COUNT(*) count FROM leads WHERE organization_id=? GROUP BY status").bind(auth.organizationId).all();
    const sales = await env.DB.prepare("SELECT COUNT(*) count, COALESCE(SUM(amount_cents),0) totalCents FROM sales WHERE organization_id=?").bind(auth.organizationId).first();
    return json({ byStatus: byStatus.results, sales });
  }
  if (url.pathname === "/api/leads" && request.method === "GET") {
    return json(await env.DB.prepare(`SELECT l.id,l.status,l.product_interest productInterest,l.notes,l.next_action nextAction,l.follow_up_at followUpAt,
      l.loss_reason lossReason,l.updated_at updatedAt,c.name,c.phone_e164 phone,c.email,
      (SELECT amount_cents FROM sales s WHERE s.lead_id=l.id AND s.organization_id=l.organization_id ORDER BY s.created_at DESC LIMIT 1) saleCents
      FROM leads l JOIN contacts c ON c.id=l.contact_id AND c.organization_id=l.organization_id
      WHERE l.organization_id=? ORDER BY l.updated_at DESC LIMIT 500`).bind(auth.organizationId).all());
  }
  if (url.pathname === "/api/leads" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>();
    const phone = normalizePhone(body.phone), name = text(body.name, 120);
    if (!phone) return json({ error: "Telefone inválido. Informe DDD e número (ex.: 11 91234-5678)." }, 400);
    if (!name) return json({ error: "Informe o nome do contato." }, 400);
    const exists = await env.DB.prepare("SELECT 1 x FROM contacts WHERE organization_id=? AND phone_e164=?").bind(auth.organizationId, phone).first();
    if (exists) return json({ error: "Já existe um contato com esse telefone." }, 409);
    const contactId = id(), leadId = id();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO contacts(id,organization_id,name,phone_e164,email) VALUES(?,?,?,?,?)").bind(contactId, auth.organizationId, name, phone, text(body.email, 160)),
      env.DB.prepare("INSERT INTO leads(id,organization_id,contact_id,status,product_interest,notes,owner_id) VALUES(?,?,?,'new',?,?,?)")
        .bind(leadId, auth.organizationId, contactId, text(body.productInterest, 160), text(body.notes, 2000), auth.userId),
      env.DB.prepare("INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,NULL,'new',?)").bind(id(), auth.organizationId, leadId, auth.userId),
    ]);
    await audit(env, auth, "lead.created", "lead", leadId);
    return json({ ok: true, id: leadId }, 201);
  }
  const saleMatch = url.pathname.match(/^\/api\/leads\/([\w-]+)\/sale$/);
  if (saleMatch && request.method === "POST") {
    const leadId = saleMatch[1]!, body = await request.json<{ amount?: number; soldAt?: string }>();
    const amount = Number(body.amount), soldAt = body.soldAt ? new Date(body.soldAt) : new Date();
    if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) return json({ error: "Valor da venda inválido." }, 400);
    if (Number.isNaN(soldAt.getTime()) || soldAt.getTime() > Date.now() + 864e5) return json({ error: "Data da venda inválida." }, 400);
    const lead = await env.DB.prepare("SELECT status FROM leads WHERE id=? AND organization_id=?").bind(leadId, auth.organizationId).first<{ status: string }>();
    if (!lead) return json({ error: "Lead não encontrado." }, 404);
    if (lead.status === "sold") return json({ error: "Este lead já tem uma venda registrada." }, 409);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO sales(id,organization_id,lead_id,amount_cents,sold_at,confirmed_by) VALUES(?,?,?,?,?,?)")
        .bind(id(), auth.organizationId, leadId, Math.round(amount * 100), soldAt.toISOString(), auth.userId),
      env.DB.prepare("UPDATE leads SET status='sold',updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?").bind(leadId, auth.organizationId),
      env.DB.prepare("INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,?,'sold',?)").bind(id(), auth.organizationId, leadId, lead.status, auth.userId),
    ]);
    await audit(env, auth, "sale.confirmed", "lead", leadId);
    return json({ ok: true }, 201);
  }
  if (url.pathname.startsWith("/api/leads/") && request.method === "PATCH") {
    const leadId = url.pathname.split("/").pop()!, body = await request.json<Record<string, unknown>>();
    const lead = await env.DB.prepare("SELECT status FROM leads WHERE id=? AND organization_id=?").bind(leadId, auth.organizationId).first<{ status: string }>();
    if (!lead) return json({ error: "Lead não encontrado." }, 404);
    const sets: string[] = [], values: unknown[] = [];
    const fields: Array<[string, string, number]> = [["productInterest", "product_interest", 160], ["notes", "notes", 2000], ["nextAction", "next_action", 300], ["lossReason", "loss_reason", 300]];
    for (const [key, column, max] of fields) if (key in body) { sets.push(`${column}=?`); values.push(text(body[key], max)); }
    if ("followUpAt" in body) {
      const date = body.followUpAt ? new Date(String(body.followUpAt)) : null;
      if (date && Number.isNaN(date.getTime())) return json({ error: "Data de follow-up inválida." }, 400);
      sets.push("follow_up_at=?"); values.push(date ? date.toISOString() : null);
    }
    const statements: D1PreparedStatement[] = [];
    if ("status" in body && body.status !== lead.status) {
      if (typeof body.status !== "string" || !LEAD_STATUSES.includes(body.status)) return json({ error: "Status inválido." }, 400);
      if (body.status === "sold") return json({ error: "Use \"Registrar venda\" para informar valor e data." }, 422);
      if (lead.status === "sold") return json({ error: "Leads vendidos não podem mudar de status." }, 422);
      sets.push("status=?"); values.push(body.status);
      statements.push(env.DB.prepare("INSERT INTO lead_status_history(id,organization_id,lead_id,from_status,to_status,changed_by) VALUES(?,?,?,?,?,?)")
        .bind(id(), auth.organizationId, leadId, lead.status, body.status, auth.userId));
    }
    if (!sets.length) return json({ error: "Nada para atualizar." }, 400);
    await env.DB.batch([
      env.DB.prepare(`UPDATE leads SET ${sets.join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`).bind(...values, leadId, auth.organizationId),
      ...statements,
    ]);
    await audit(env, auth, "lead.updated", "lead", leadId);
    return json({ ok: true });
  }
  if (url.pathname === "/api/team" && request.method === "GET") {
    const members = await env.DB.prepare(`SELECT u.id,u.name,u.email,m.role,m.status FROM organization_members m JOIN users u ON u.id=m.user_id
      WHERE m.organization_id=? ORDER BY m.created_at`).bind(auth.organizationId).all();
    const invites = auth.role === "admin" ? await env.DB.prepare(`SELECT id,email,role,expires_at expiresAt FROM invitations
      WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP ORDER BY created_at DESC`).bind(auth.organizationId).all() : { results: [] };
    return json({ members: members.results, invites: invites.results, seats: await seatsUsed(env, auth.organizationId), seatLimit: PLAN_USER_LIMIT });
  }
  if (url.pathname.startsWith("/api/team/")) {
    if (auth.role !== "admin") return json({ error: "Apenas administradores podem gerenciar a equipe." }, 403);
    if (url.pathname === "/api/team/invites" && request.method === "POST") {
      const body = await request.json<{ email?: string; role?: string }>();
      const email = body.email?.trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !body.role || !ROLES.includes(body.role)) return json({ error: "Informe um e-mail válido e um papel." }, 400);
      if (await env.DB.prepare("SELECT 1 x FROM users WHERE email=?").bind(email).first()) return json({ error: "Já existe uma conta com esse e-mail." }, 409);
      if (await seatsUsed(env, auth.organizationId) >= PLAN_USER_LIMIT) return json({ error: `O plano inicial permite até ${PLAN_USER_LIMIT} usuários.` }, 403);
      const token = `${id()}${id()}`, inviteId = id();
      await env.DB.prepare("INSERT INTO invitations(id,organization_id,email,role,token_hash,invited_by,expires_at) VALUES(?,?,?,?,?,?,datetime('now','+7 days'))")
        .bind(inviteId, auth.organizationId, email, body.role, await sha256(token), auth.userId).run();
      await audit(env, auth, "team.invited", "invitation", inviteId);
      return json({ ok: true, link: `${new URL(env.APP_ORIGIN).origin}/?invite=${token}` }, 201);
    }
    const inviteMatch = url.pathname.match(/^\/api\/team\/invites\/([\w-]+)$/);
    if (inviteMatch && request.method === "DELETE") {
      await env.DB.prepare("UPDATE invitations SET revoked_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND accepted_at IS NULL").bind(inviteMatch[1], auth.organizationId).run();
      await audit(env, auth, "team.invite_revoked", "invitation", inviteMatch[1]);
      return json({ ok: true });
    }
    const memberMatch = url.pathname.match(/^\/api\/team\/members\/([\w-]+)$/);
    if (memberMatch && request.method === "PATCH") {
      const body = await request.json<{ role?: string; status?: string }>();
      if (memberMatch[1] === auth.userId) return json({ error: "Você não pode alterar o próprio acesso." }, 422);
      const sets: string[] = [], values: unknown[] = [];
      if (body.role) { if (!ROLES.includes(body.role)) return json({ error: "Papel inválido." }, 400); sets.push("role=?"); values.push(body.role); }
      if (body.status) { if (!["active", "disabled"].includes(body.status)) return json({ error: "Status inválido." }, 400); sets.push("status=?"); values.push(body.status); }
      if (!sets.length) return json({ error: "Nada para atualizar." }, 400);
      if (body.status === "active" && await seatsUsed(env, auth.organizationId) >= PLAN_USER_LIMIT) return json({ error: `O plano inicial permite até ${PLAN_USER_LIMIT} usuários.` }, 403);
      const result = await env.DB.prepare(`UPDATE organization_members SET ${sets.join(",")} WHERE organization_id=? AND user_id=?`).bind(...values, auth.organizationId, memberMatch[1]).run();
      if (!result.meta.changes) return json({ error: "Membro não encontrado." }, 404);
      await audit(env, auth, "team.member_updated", "user", memberMatch[1]);
      return json({ ok: true });
    }
  }
  const whatsapp = await whatsappRoutes(request, env, url, auth);
  if (whatsapp) return whatsapp;
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
