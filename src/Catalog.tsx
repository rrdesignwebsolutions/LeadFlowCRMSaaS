import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { Boxes, Pencil, Star, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "./api";

type Spec = { label: string; value: string };
type Product = {
  id: string; name: string; model: string; version: string | null; brand: string | null; category: string | null;
  description: string | null; specs: Spec[]; priceText: string | null; salePriceText: string | null; status: "draft" | "approved" | "rejected";
  authorized: boolean; availability: "unknown" | "in_stock" | "out_of_stock"; availabilityAt: string | null;
  stockConfirmed: boolean; images: Array<{ id: string; isPrimary: boolean }>;
};

const statusText = { draft: "Rascunho", approved: "Aprovado", rejected: "Rejeitado" };
const specsToText = (specs: Spec[]) => specs.map((s) => `${s.label}: ${s.value}`).join("\n");
const textToSpecs = (text: string): Spec[] =>
  text.split("\n").map((line) => {
    const i = line.indexOf(":");
    return i > 0 ? { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : { label: "", value: "" };
  }).filter((s) => s.label && s.value);

function ProductForm({ product, busy, onSubmit, onCancel }: {
  product?: Product; busy: boolean; onSubmit: (body: Record<string, unknown>, files: File[]) => void; onCancel?: () => void;
}) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const f = new FormData(form);
    const files = f.getAll("photos").filter((x): x is File => x instanceof File && x.size > 0);
    onSubmit({
      name: f.get("name"), model: f.get("model"), version: f.get("version"), brand: f.get("brand"),
      category: f.get("category"), priceText: f.get("priceText"), salePriceText: f.get("salePriceText"), description: f.get("description"),
      specs: textToSpecs(String(f.get("specs") ?? "")),
    }, files);
    if (!product) form.reset();
  }

  return (
    <form className="form" onSubmit={submit}>
      <label>Nome<input name="name" required maxLength={120} defaultValue={product?.name} /></label>
      <label>Modelo<input name="model" required maxLength={80} defaultValue={product?.model} placeholder="Ex.: TERA" /></label>
      <label>Versão<input name="version" maxLength={80} defaultValue={product?.version ?? ""} /></label>
      <label>Marca<input name="brand" maxLength={80} defaultValue={product?.brand ?? ""} /></label>
      <label>Categoria<input name="category" maxLength={80} defaultValue={product?.category ?? ""} /></label>
      <label>Preço normal (opcional)<input name="priceText" maxLength={80} defaultValue={product?.priceText ?? ""} placeholder="Ex.: R$ 12.990" /></label>
      <label>Preço de oferta (opcional, preencha quando houver promoção)<input name="salePriceText" maxLength={80} defaultValue={product?.salePriceText ?? ""} placeholder="Ex.: R$ 11.490" /></label>
      <label>Descrição<textarea name="description" rows={3} maxLength={2000} defaultValue={product?.description ?? ""} /></label>
      <label>Especificações (uma por linha, no formato "Item: valor")
        <textarea name="specs" rows={6} defaultValue={specsToText(product?.specs ?? [])} placeholder={"Motor: 800W\nAutonomia: 60 km\nBateria: Chumbo-ácido 60V"} />
      </label>
      {!product && (
        <label>Fotos da moto (JPG ou PNG, até 5 MB cada, a primeira será a principal)
          <input type="file" name="photos" accept="image/jpeg,image/png" multiple />
        </label>
      )}
      <div className="catalog-actions">
        <button className="button" disabled={busy}>{product ? "Salvar" : "Cadastrar produto"}</button>
        {onCancel && <button type="button" className="button secondary" onClick={onCancel}>Cancelar</button>}
      </div>
    </form>
  );
}

export default function Catalog() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [storageReady, setStorageReady] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api<{ products: Product[]; canEdit: boolean; storageReady: boolean }>("/api/catalog/products");
      setProducts(data.products); setCanEdit(data.canEdit); setStorageReady(data.storageReady);
    } catch (e) { setError(errorMessage(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); await load(); } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }

  const update = (id: string, body: Record<string, unknown>) =>
    run(() => api(`/api/catalog/products/${id}`, { method: "PUT", body }));

  const sendImage = async (id: string, file: File) => {
    const body = new FormData();
    body.set("file", file);
    const response = await fetch(`/api/catalog/products/${id}/images`, { method: "POST", body, credentials: "same-origin" });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new Error(data.error ?? `Falha ao enviar a foto ${file.name}.`);
  };

  async function create(body: Record<string, unknown>, files: File[]) {
    await run(async () => {
      const { id } = await api<{ id: string }>("/api/catalog/products", { method: "POST", body });
      for (const file of files.slice(0, 10)) await sendImage(id, file);
    });
  }

  async function upload(id: string, event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    await run(() => sendImage(id, file));
    input.value = "";
  }

  if (!products) return error ? <p className="auth-error" role="alert">{error}</p> : null;

  return (
    <>
      <div className="page-heading"><div><h1>Catálogo</h1><p>A IA só envia fotos e informações de produtos aprovados e autorizados para venda.</p></div></div>
      {!storageReady && <p className="auth-error" role="alert">O armazenamento de fotos (R2) ainda não está configurado neste ambiente.</p>}
      {error && <p className="auth-error" role="alert">{error}</p>}

      {canEdit && (
        <section className="panel spaced">
          <div className="panel-title"><div><h2><Boxes size={18} /> Novo produto</h2><p>Novos produtos já ficam aprovados e autorizados; desative aqui se não quiser que a IA ofereça.</p></div></div>
          <ProductForm busy={busy} onSubmit={(body, files) => void create(body, files)} />
        </section>
      )}

      {products.length === 0 && <p className="muted">Nenhum produto cadastrado.</p>}

      {products.map((p) => (
        <section className="panel spaced catalog-card" key={p.id}>
          <div className="panel-title">
            <div>
              <h2>{p.name} <small>{p.model}{p.version ? ` · ${p.version}` : ""}</small></h2>
              <p>{[p.brand, p.category, p.salePriceText ? `${p.priceText ?? ""} → ${p.salePriceText}` : p.priceText].filter(Boolean).join(" · ") || "Sem detalhes comerciais"}</p>
            </div>
            <div className="catalog-tags">
              <span className={p.status === "approved" ? "tag" : "tag warning"}>{statusText[p.status]}</span>
              <span className={p.authorized ? "tag" : "tag warning"}>{p.authorized ? "Autorizado" : "Não autorizado"}</span>
              <span className={p.stockConfirmed ? "tag" : "tag warning"}>{p.stockConfirmed ? "Em estoque" : "Estoque não confirmado"}</span>
            </div>
          </div>

          <div className="catalog-gallery">
            {p.images.map((image) => (
              <figure key={image.id} className={image.isPrimary ? "primary" : ""}>
                <img src={`/api/catalog/images/${image.id}`} alt={`${p.name}`} loading="lazy" />
                {canEdit && (
                  <figcaption>
                    <button className="icon-button" title="Definir como principal" aria-label="Definir como principal" onClick={() => void run(() => api(`/api/catalog/images/${image.id}`, { method: "PUT", body: { primary: true } }))}><Star size={14} /></button>
                    <button className="icon-button" title="Excluir foto" aria-label="Excluir foto" onClick={() => confirm("Excluir esta foto?") && void run(() => api(`/api/catalog/images/${image.id}`, { method: "DELETE" }))}><Trash2 size={14} /></button>
                  </figcaption>
                )}
              </figure>
            ))}
            {canEdit && storageReady && p.images.length < 10 && (
              <label className="catalog-add-photo"><Upload size={16} /> Foto<input type="file" accept="image/jpeg,image/png" hidden disabled={busy} onChange={(e) => void upload(p.id, e)} /></label>
            )}
          </div>

          {editing === p.id ? (
            <ProductForm product={p} busy={busy} onCancel={() => setEditing(null)} onSubmit={(body) => { void update(p.id, body); setEditing(null); }} />
          ) : (
            p.specs.length > 0 && <ul className="catalog-specs">{p.specs.map((s, i) => <li key={i}><b>{s.label}:</b> {s.value}</li>)}</ul>
          )}

          {canEdit && editing !== p.id && (
            <div className="catalog-actions">
              <label>Status
                <select value={p.status} onChange={(e) => void update(p.id, { status: e.target.value })}>
                  <option value="draft">Rascunho</option><option value="approved">Aprovado</option><option value="rejected">Rejeitado</option>
                </select>
              </label>
              <label>Estoque
                <select value={p.availability} onChange={(e) => void update(p.id, { availability: e.target.value })}>
                  <option value="unknown">Não confirmado</option><option value="in_stock">Em estoque</option><option value="out_of_stock">Sem estoque</option>
                </select>
              </label>
              <label><span><input type="checkbox" checked={p.authorized} onChange={(e) => void update(p.id, { authorized: e.target.checked })} /> Autorizado para venda</span></label>
              <button className="button secondary" onClick={() => setEditing(p.id)}><Pencil size={14} /> Editar</button>
              <button className="button secondary" onClick={() => confirm(`Excluir ${p.name}?`) && void run(() => api(`/api/catalog/products/${p.id}`, { method: "DELETE" }))}><Trash2 size={14} /> Excluir</button>
            </div>
          )}
          {p.availabilityAt && <p className="muted">Estoque atualizado em {new Date(p.availabilityAt.replace(" ", "T") + "Z").toLocaleString("pt-BR")}. A IA só confirma estoque atualizado nos últimos 7 dias.</p>}
        </section>
      ))}
    </>
  );
}
