import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Copy } from "lucide-react";
import { api, errorMessage } from "./api";

type Status = {
  integration: { status: string; phoneNumberId: string; displayPhoneNumber: string | null; errorSummary: string | null; connectedAt: string | null } | null;
  webhookUrl: string;
  serverReady: { appSecret: boolean; verifyToken: boolean; encryptionKey: boolean };
};

const copy = (value: string) => void navigator.clipboard.writeText(value);

export default function WhatsAppSettings({ isAdmin, onChanged }: { isAdmin: boolean; onChanged: () => void }) {
  const [data, setData] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setData(await api<Status>("/api/integrations/whatsapp")); } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setError(""); setNote("");
    try {
      const r = await api<{ displayPhoneNumber: string; subscribed: boolean; subscribeError?: string }>("/api/integrations/whatsapp", { method: "POST", body: Object.fromEntries(new FormData(event.currentTarget)) });
      setNote(r.subscribed ? `Número ${r.displayPhoneNumber} conectado.` : `Número ${r.displayPhoneNumber} conectado, mas a assinatura de mensagens falhou: ${r.subscribeError ?? "erro desconhecido"}. Verifique o webhook no painel da Meta.`);
      await load(); onChanged();
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  async function disconnect() {
    if (!confirm("Desconectar o WhatsApp? O token salvo será apagado e as mensagens deixarão de chegar.")) return;
    setError(""); setNote("");
    try { await api("/api/integrations/whatsapp", { method: "DELETE" }); await load(); onChanged(); } catch (e) { setError(errorMessage(e)); }
  }

  const i = data?.integration;
  const ready = data?.serverReady;
  const label = !i ? "Não conectado" : i.status === "connected" ? "Conectado" : "Com erro";

  return (
    <section className="panel spaced">
      <div className="panel-title"><div><h2>WhatsApp Business Platform</h2><p>Integração oficial da Meta (Cloud API)</p></div><span className={`tag ${i?.status === "connected" ? "ok" : "warning"}`}>{label}</span></div>
      {error && <p className="auth-error" role="alert">{error}</p>}
      {note && <p className="callout-text">{note}</p>}
      {i && <p className="muted">Número: <b>{i.displayPhoneNumber ?? i.phoneNumberId}</b>{i.errorSummary ? ` · ${i.errorSummary}` : ""}</p>}
      {i && isAdmin && <button className="button secondary" onClick={() => void disconnect()}>Desconectar</button>}

      {!i && isAdmin && <>
        <div className="steps-help">
          <p><b>1.</b> No Meta for Developers, abra seu app e vá em <b>WhatsApp → Configuração da API</b>.</p>
          <p><b>2.</b> Em <b>WhatsApp → Configuração</b> (webhook), informe:</p>
          <div className="callout-text"><span className="break">URL de callback: {data?.webhookUrl}</span><button className="text-button" onClick={() => data && copy(data.webhookUrl)}><Copy size={14} /> Copiar</button></div>
          <p className="muted">Token de verificação: o valor de <code>META_VERIFY_TOKEN</code> configurado no servidor. Assine o campo <b>messages</b>.</p>
          <p><b>3.</b> Crie um <b>usuário do sistema</b> no Business Manager, gere um token permanente com as permissões <code>whatsapp_business_messaging</code> e <code>whatsapp_business_management</code> e cole abaixo.</p>
        </div>
        {ready && !(ready.appSecret && ready.verifyToken && ready.encryptionKey) && (
          <p className="auth-error" role="alert">Servidor incompleto — faltam: {[!ready.appSecret && "META_APP_SECRET", !ready.verifyToken && "META_VERIFY_TOKEN", !ready.encryptionKey && "ENCRYPTION_KEY"].filter(Boolean).join(", ")}.</p>
        )}
        <form className="form" onSubmit={connect}>
          <label>Phone Number ID<input name="phoneNumberId" required inputMode="numeric" /></label>
          <label>WABA ID (ID da conta do WhatsApp Business)<input name="wabaId" required inputMode="numeric" /></label>
          <label>Token de acesso permanente<input name="accessToken" type="password" required autoComplete="off" /></label>
          <div className="modal-actions"><button className="button" disabled={busy}>{busy ? "Verificando…" : "Conectar"}</button></div>
        </form>
      </>}
      {!i && !isAdmin && <p className="muted">Peça a um administrador para conectar o número.</p>}
      <p className="muted">Nenhum QR Code ou automação do WhatsApp Web é usado. O token é guardado criptografado e nunca é exibido.</p>
    </section>
  );
}
