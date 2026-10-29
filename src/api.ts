export type Me = { name: string; email: string; organization: string; role: string };
export type Metrics = { leads: number; qualified: number; hot: number; sold: number; active: number; seats: number; seatLimit: number };
export type Lead = {
  id: string; status: string; productInterest: string | null; notes: string | null; nextAction: string | null;
  followUpAt: string | null; lossReason: string | null; updatedAt: string; name: string | null; phone: string;
  email: string | null; saleCents: number | null;
};
export type Member = { id: string; name: string; email: string; role: string; status: string };
export type Invite = { id: string; email: string; role: string; expiresAt: string };
export type Team = { members: Member[]; invites: Invite[]; seats: number; seatLimit: number };
export type Reports = { byStatus: Array<{ status: string; count: number }>; sales: { count: number; totalCents: number } };

export class ApiError extends Error {
  constructor(public status: number, message: string) {
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
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, (data as { error?: string }).error ?? "Erro inesperado.");
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
