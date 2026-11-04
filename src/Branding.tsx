import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "./api";

export type Branding = {
  displayName: string | null;
  tagline: string | null;
  primaryColor: string | null;
  logo: string | null;
  avatar: string | null;
};

export const DEFAULT_COLOR = "#0d8a57";

const defaultFavicon = "/favicon.svg?v=2";

export function applyBranding(b: Branding | null) {
  const root = document.documentElement.style;
  const color = b?.primaryColor;
  const props = ["--color-brand-600", "--color-brand-500", "--color-brand-100", "--color-brand-50"];
  if (color) {
    root.setProperty("--color-brand-600", color);
    root.setProperty("--color-brand-500", `color-mix(in srgb, ${color} 85%, white)`);
    root.setProperty("--color-brand-100", `color-mix(in srgb, ${color} 18%, white)`);
    root.setProperty("--color-brand-50", `color-mix(in srgb, ${color} 8%, white)`);
  } else props.forEach((p) => root.removeProperty(p));
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link) {
    link.type = b?.logo ? "" : "image/svg+xml";
    link.href = b?.logo ?? defaultFavicon;
  }
  document.title = b?.displayName ? `${b.displayName} · CRM` : "AV Flow CRM";
}

async function toDataUrl(file: File, size: number): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) throw new Error("Use uma imagem PNG, JPG ou WebP.");
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, size / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL("image/webp", 0.85);
  if (data.length > 140_000) throw new Error("A imagem ficou muito grande. Escolha uma menor.");
  return data;
}

function ImagePicker({ label, value, onChange, size, round }: {
  label: string; value: string | null; onChange: (v: string | null) => void; size: number; round?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState("");
  return (
    <div className="branding-picker">
      <span className={round ? "branding-preview round" : "branding-preview"}>
        {value ? <img src={value} alt="" /> : <small>Sem imagem</small>}
      </span>
      <div>
        <b>{label}</b>
        <div className="branding-actions">
          <button type="button" className="button secondary" onClick={() => input.current?.click()}>Enviar imagem</button>
          {value && <button type="button" className="text-button" onClick={() => onChange(null)}>Remover</button>}
        </div>
        {err && <p className="auth-error" role="alert">{err}</p>}
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try { setErr(""); onChange(await toDataUrl(file, size)); } catch (x) { setErr(errorMessage(x)); }
        }} />
      </div>
    </div>
  );
}

export function BrandingSettings({ branding, isAdmin, onSaved, companyName }: {
  branding: Branding | null; isAdmin: boolean; onSaved: (b: Branding) => void; companyName: string;
}) {
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [logo, setLogo] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(branding?.displayName ?? "");
    setTagline(branding?.tagline ?? "");
    setColor(branding?.primaryColor ?? null);
    setLogo(branding?.logo ?? null);
    setAvatar(branding?.avatar ?? null);
  }, [branding]);

  async function run(job: () => Promise<Branding>, ok: string) {
    setBusy(true);
    setMsg("");
    try { onSaved(await job()); setMsg(ok); } catch (e) { setMsg(errorMessage(e)); } finally { setBusy(false); }
  }

  const saveCompany = () => run(() => api<Branding>("/api/branding", {
    method: "PUT",
    body: { displayName: name || null, tagline: tagline || null, primaryColor: color, logo },
  }), "Identidade visual atualizada.");
  const saveAvatar = () => run(() => api<Branding>("/api/profile/avatar", { method: "PUT", body: { avatar } }), "Foto de perfil atualizada.");

  return (
    <>
      <section className="panel spaced">
        <div className="panel-title"><div><h2>Foto de perfil</h2><p>Aparece no menu ao lado do seu nome.</p></div></div>
        <ImagePicker label="Sua foto" value={avatar} onChange={setAvatar} size={256} round />
        <button className="button" disabled={busy || avatar === (branding?.avatar ?? null)} onClick={saveAvatar}>Salvar foto</button>
      </section>
      <section className="panel spaced">
        <div className="panel-title"><div><h2>Personalização da empresa</h2><p>Deixe o app com a identidade da sua loja.</p></div></div>
        <fieldset disabled={!isAdmin || busy} className="branding-form">
          <ImagePicker label="Logo da empresa" value={logo} onChange={setLogo} size={256} />
          <label>Nome exibido<input value={name} maxLength={60} placeholder={companyName} onChange={(e) => setName(e.target.value)} /></label>
          <label>Slogan<input value={tagline} maxLength={40} placeholder="Ex.: Atendimento que vende" onChange={(e) => setTagline(e.target.value)} /></label>
          <label>Cor principal
            <span className="branding-color">
              <input type="color" value={color ?? DEFAULT_COLOR} onChange={(e) => setColor(e.target.value)} />
              <code>{color ?? "Padrão"}</code>
              {color && <button type="button" className="text-button" onClick={() => setColor(null)}>Usar padrão</button>}
            </span>
          </label>
          <div className="branding-live" style={color ? { ["--color-brand-600" as string]: color } : undefined}>
            <span className="branding-preview">{logo ? <img src={logo} alt="" /> : <small>Logo</small>}</span>
            <span><b>{name || companyName}</b><small>{tagline || "Seu slogan aqui"}</small></span>
            <span className="button">Botão</span>
          </div>
        </fieldset>
        {isAdmin
          ? <div className="branding-actions">
              <button className="button" disabled={busy} onClick={saveCompany}>Salvar personalização</button>
              <button className="text-button" disabled={busy} onClick={() => run(() => api<Branding>("/api/branding", { method: "PUT", body: {} }), "Padrão restaurado.")}>Restaurar padrão</button>
            </div>
          : <p className="muted">Somente administradores podem alterar a identidade da empresa.</p>}
        {msg && <p role="status">{msg}</p>}
      </section>
    </>
  );
}
