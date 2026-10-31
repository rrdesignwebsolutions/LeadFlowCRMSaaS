import { useEffect, useState, type FormEvent } from "react";
import { MessageCircleMore } from "lucide-react";
import { api } from "./api";

export default function AuthScreen({ onDone }: { onDone: () => void }) {
  const inviteToken = new URLSearchParams(window.location.search).get("invite") ?? "";
  const [mode, setMode] = useState<"login" | "register">(inviteToken ? "register" : "login");
  const [invite, setInvite] = useState<{ email: string; organization: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inviteToken) return;
    api<{ email: string; organization: string }>(`/api/invitations/lookup?token=${encodeURIComponent(inviteToken)}`)
      .then(setInvite)
      .catch((e) => setError(e instanceof Error ? e.message : "Convite inválido."));
  }, [inviteToken]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
    if (invite) form.inviteToken = inviteToken;
    setBusy(true);
    setError("");
    try {
      await api(mode === "login" ? "/api/auth/login" : "/api/auth/register", { method: "POST", body: form });
      if (inviteToken) window.history.replaceState(null, "", "/");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  const register = mode === "register";
  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark"><MessageCircleMore size={21} /></span>
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
