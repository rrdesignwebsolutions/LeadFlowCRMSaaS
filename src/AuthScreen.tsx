import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "./api";

export default function AuthScreen({ onDone }: { onDone: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("invite") ?? "";
  const verifyToken = params.get("verify") ?? "";
  const [mode, setMode] = useState<"login" | "register">(inviteToken ? "register" : "login");
  const [invite, setInvite] = useState<{ email: string; organization: string } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");

  const verifying = useRef(false);

  useEffect(() => {
    if (!verifyToken || verifying.current) return;
    verifying.current = true;
    setBusy(true);
    api("/api/auth/verify", { method: "POST", body: { token: verifyToken } })
      .then(() => { window.history.replaceState(null, "", "/"); onDone(); })
      .catch((e) => { window.history.replaceState(null, "", "/"); setError(e instanceof Error ? e.message : "Link inválido."); })
      .finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verifyToken]);

  useEffect(() => {
    if (!inviteToken) return;
    api<{ email: string; organization: string }>(`/api/invitations/lookup?token=${encodeURIComponent(inviteToken)}`)
      .then(setInvite)
      .catch((e) => setError(e instanceof Error ? e.message : "Convite inválido."));
  }, [inviteToken]);

  async function resend(email: string) {
    setError("");
    setNotice("");
    await api("/api/auth/resend", { method: "POST", body: { email } }).catch(() => undefined);
    setNotice("Se houver uma conta pendente para este e-mail, enviamos um novo link.");
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    if (invite) form.inviteToken = inviteToken;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ verify?: boolean; email?: string }>(mode === "login" ? "/api/auth/login" : "/api/auth/register", { method: "POST", body: form });
      if (result.verify) { setPendingEmail(result.email ?? form.email ?? ""); return; }
      if (inviteToken) window.history.replaceState(null, "", "/");
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === "email_not_verified") setPendingEmail(form.email ?? "");
      else setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  const register = mode === "register";

  if (pendingEmail)
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="brand">
            <img className="brand-mark" src="/app-icon.png" alt="" />
            <span>AV Flow <b>CRM</b><small>Acelera Vendas</small></span>
          </div>
          <h1>Confirme seu e-mail</h1>
          <p>Enviamos um link de confirmação para <b>{pendingEmail}</b>. Abra o e-mail e clique no botão para ativar sua conta. O link vale por 24 horas.</p>
          <p className="muted">Não encontrou? Verifique a caixa de spam.</p>
          {notice && <p role="status">{notice}</p>}
          <button className="button" onClick={() => void resend(pendingEmail)}>Reenviar e-mail</button>
          <button type="button" className="text-button" onClick={() => { setPendingEmail(""); setNotice(""); setMode("login"); }}>Voltar para o login</button>
        </div>
      </div>
    );

  if (verifyToken && busy) return <div className="auth-page">Confirmando seu e-mail...</div>;

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <img className="brand-mark" src="/app-icon.png" alt="" />
          <span>AV Flow <b>CRM</b><small>Acelera Vendas</small></span>
        </div>
        <h1>{invite ? `Entrar em ${invite.organization}` : register ? "Criar conta" : "Entrar"}</h1>
        {register && !inviteToken && <label>Empresa<input name="company" required autoComplete="organization" /></label>}
        {register && <label>Seu nome<input name="name" required autoComplete="name" /></label>}
        <label>E-mail<input name="email" type="email" required autoComplete="email" defaultValue={invite?.email} key={invite?.email} readOnly={!!invite} /></label>
        <label>Senha{register && <small> (mínimo 12 caracteres)</small>}
          <input name="password" type="password" required minLength={register ? 12 : undefined} autoComplete={register ? "new-password" : "current-password"} />
        </label>
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="button" disabled={busy || (!!inviteToken && !invite)}>{busy ? "Aguarde..." : register ? (invite ? "Aceitar convite" : "Criar conta") : "Entrar"}</button>
        {!inviteToken && <button type="button" className="text-button" onClick={() => { setMode(register ? "login" : "register"); setError(""); }}>
          {register ? "Já tenho conta" : "Criar uma conta"}
        </button>}
        <a className="text-button" href="/privacy.html" target="_blank" rel="noreferrer">Política de Privacidade</a>
      </form>
    </div>
  );
}
