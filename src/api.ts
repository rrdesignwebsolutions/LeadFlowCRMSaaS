export type Subscription = { status: "trialing" | "active" | "expired"; plan: string; endsAt: string | null; daysLeft: number };
export type Me = { name: string; email: string; organization: string; organizationId: string; role: string; subscription: Subscription };
export type Metrics = { leads: number; qualified: number; hot: number; sold: number; active: number; seats: number; seatLimit: number };
export type Lead = {
  id: string; status: string; productInterest: string | null; notes: string | null; nextAction: string | null;
  followUpAt: string | null; lossReason: string | null; updatedAt: string; name: string | null; phone: string;
  email: string | null; saleCents: number | null; aiScore: number | null; aiSummary: string | null;
};
export type Member = { id: string; name: string; email: string; role: string; status: string };
export type Invite = { id: string; email: string; role: string; expiresAt: string };
export type Team = { members: Member[]; invites: Invite[]; seats: number; seatLimit: number };
export type Reports = { byStatus: Array<{ status: string; count: number }>; sales: { count: number; totalCents: number } };

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body ? { "content-type": "application/json" } : undefined,
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    if (!response.ok) throw new ApiError(response.status, "Erro inesperado.");
    throw new ApiError(
      502,
      "A API do AV Flow não respondeu em JSON. Verifique se o Worker está ativo.",
    );
  }
  if (!response.ok) {
    const body = data && typeof data === "object" ? data as Record<string, unknown> : {};
    throw new ApiError(
      response.status,
      typeof body.error === "string" ? body.error : "Erro inesperado.",
      typeof body.code === "string" ? body.code : undefined,
    );
  }
  return data as T;
}

export const statusLabels: Record<string, string> = {
  new: "Novo",
  not_contacted: "Não contatado",
  in_service: "Em atendimento",
  hot: "Quente",
  qualified: "Qualificado",
  negotiating: "Negociando",
  follow_up: "Follow-up",
  financial_pending: "Pendência financeira",
  cold: "Frio",
  lost: "Perdido",
  sold: "Vendido",
};
export const editableStatuses = Object.keys(statusLabels).filter((s) => s !== "sold");
export const roleLabels: Record<string, string> = { admin: "Administrador", manager: "Gerente", agent: "Atendente" };

export const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : "Erro inesperado.");
export const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
