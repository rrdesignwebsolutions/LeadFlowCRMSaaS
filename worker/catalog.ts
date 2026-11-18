import type { Env, Session } from "./index"

import { sendFile } from "./whatsapp"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,

    headers: { "content-type": "application/json; charset=utf-8" },
  })

const uid = () => crypto.randomUUID()

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const MAX_IMAGES_PER_PRODUCT = 10

const MAX_PHOTOS_PER_TURN = 14

const MAX_CATALOG_SEND = 12

const STOCK_FRESH_DAYS = 7

const clip = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null

type Spec = { label: string value: string }

type ProductRow = {
  id: string

  name: string

  model: string

  version: string | null

  brand: string | null

  category: string | null

  description: string | null

  specs: string

  priceText: string | null

  salePriceText: string | null

  cardInstallments: string | null

  cardInstallmentText: string | null

  status: string

  authorized: number

  availability: string

  availabilityAt: string | null

  updatedAt: string
}

const PRODUCT_COLUMNS = `id,name,model,version,brand,category,description,specs,price_text priceText,sale_price_text salePriceText,card_installments cardInstallments,card_installment_text cardInstallmentText,status,authorized_for_sale authorized,availability,availability_updated_at availabilityAt,updated_at updatedAt`

function parseSpecs(raw: unknown): Spec[] {
  let value = raw

  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return []
    }
  }

  if (!Array.isArray(value)) return []

  return value

    .map((item) => ({
      label: clip((item as Spec)?.label, 80) ?? "",

      value: clip((item as Spec)?.value, 300) ?? "",
    }))

    .filter((spec) => spec.label && spec.value)

    .slice(0, 40)
}

// O estoque só vale quando foi confirmado há pouco tempo.

function stockConfirmed(
  row: Pick<ProductRow, "availability" | "availabilityAt">,
) {
  if (row.availability !== "in_stock" || !row.availabilityAt) return false

  const timestamp = /(?:Z|[+-]\d{2}:\d{2})$/i.test(row.availabilityAt)
    ? row.availabilityAt
    : `${row.availabilityAt.replace(" ", "T")}Z`

  const age = Date.now() - new Date(timestamp).getTime()

  return age >= 0 && age < STOCK_FRESH_DAYS * 86_400_000
}

const normalize = (value: string) =>
  value

    .normalize("NFD")

    .replace(/[\u0300-\u036f]/g, "")

    .toLowerCase()

    .replace(/[^a-z0-9]+/g, "")

function imageMime(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg"

  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png"

  return null
}

async function loadProducts(
  env: Env,

  organizationId: string,

  where = "",

  extra: unknown[] = [],
) {
  return (
    await env.DB.prepare(
      `SELECT ${PRODUCT_COLUMNS} FROM catalog_products WHERE organization_id=? ${where} ORDER BY name,model`,
    )

      .bind(organizationId, ...extra)

      .all<ProductRow>()
  ).results
}

export async function catalogRoutes(
  request: Request,

  env: Env,

  url: URL,

  auth: Session,
): Promise<Response | null> {
  const path = url.pathname

  if (!path.startsWith("/api/catalog/")) return null

  const org = auth.organizationId

  const canEdit = auth.role === "admin" || auth.role === "manager"

  if (path === "/api/catalog/send" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>().catch(() => ({}))

    const conversationId =
      typeof body.conversationId === "string" ? body.conversationId : ""

    const productId = Array.isArray(body.productIds)
      ? body.productIds
          .filter(
            (x): x is string => typeof x === "string" && /^[\w-]+$/.test(x),
          )
          .slice(0, MAX_CATALOG_SEND)
      : typeof body.productId === "string"
        ? body.productId
        : null

    if (!/^[\w-]+$/.test(conversationId))
      return json({ error: "Conversa inválida." }, 400)

    if (!env.CATALOG)
      return json(
        { error: "O armazenamento de fotos ainda não foi configurado." },
        503,
      )

    const result = await sendCatalog(env, auth, conversationId, productId)

    if (!result.enviadas)
      return json({ error: result.erro ?? "Nada foi enviado." }, 422)

    return json({ ok: true, enviadas: result.enviadas, aviso: result.erro })
  }

  if (path === "/api/catalog/products" && request.method === "GET") {
    const products = await loadProducts(env, org)

    const images = (
      await env.DB.prepare(
        "SELECT id,product_id productId,is_primary isPrimary FROM catalog_images WHERE organization_id=? ORDER BY is_primary DESC,position,created_at",
      )

        .bind(org)

        .all<{ id: string productId: string isPrimary: number }>()
    ).results

    return json({
      storageReady: !!env.CATALOG,

      canEdit,

      products: products.map((p) => ({
        ...p,

        specs: parseSpecs(p.specs),

        authorized: !!p.authorized,

        stockConfirmed: stockConfirmed(p),

        images: images

          .filter((i) => i.productId === p.id)

          .map((i) => ({ id: i.id, isPrimary: !!i.isPrimary })),
      })),
    })
  }

  const imageMatch = path.match(/^\/api\/catalog\/images\/([\w-]+)$/)

  if (imageMatch && request.method === "GET") {
    if (!env.CATALOG) return json({ error: "Armazenamento indisponível." }, 503)

    const image = await env.DB.prepare(
      "SELECT r2_key key,mime FROM catalog_images WHERE id=? AND organization_id=?",
    )

      .bind(imageMatch[1], org)

      .first<{ key: string mime: string }>()

    const object = image && (await env.CATALOG.get(image.key))

    if (!image || !object) return json({ error: "Imagem não encontrada." }, 404)

    return new Response(object.body, {
      headers: {
        "content-type": image.mime,

        "cache-control": "private, max-age=3600",

        "x-content-type-options": "nosniff",
      },
    })
  }

  if (!canEdit)
    return json({ error: "Apenas administradores e gerentes." }, 403)

  if (path === "/api/catalog/products" && request.method === "POST") {
    const body = await request.json<Record<string, unknown>>().catch(() => ({}))

    const name = clip(body.name, 120)

    const model = clip(body.model, 80)

    if (!name || !model)
      return json({ error: "Informe o nome e o modelo do produto." }, 400)

    const id = uid()

    await env.DB.prepare(
      "INSERT INTO catalog_products(id,organization_id,name,model,version,brand,category,description,specs,price_text,sale_price_text,card_installments,card_installment_text,status,authorized_for_sale,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'approved',1,?)",
    )

      .bind(
        id,

        org,

        name,

        model,

        clip(body.version, 80),

        clip(body.brand, 80),

        clip(body.category, 80),

        clip(body.description, 2000),

        JSON.stringify(parseSpecs(body.specs)),

        clip(body.priceText, 80),

        clip(body.salePriceText, 80),

        clip(body.cardInstallments, 10),

        clip(body.cardInstallmentText, 80),

        auth.userId,
      )

      .run()

    return json({ ok: true, id }, 201)
  }

  const orderMatch = path.match(
    /^\/api\/catalog\/products\/([\w-]+)\/images\/order$/,
  )

  if (orderMatch && request.method === "PUT") {
    const body = await request.json<Record<string, unknown>>().catch(() => ({}))

    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === "string")
      : []

    const owned = (
      await env.DB.prepare(
        "SELECT id FROM catalog_images WHERE product_id=? AND organization_id=?",
      )

        .bind(orderMatch[1], org)

        .all<{ id: string }>()
    ).results.map((r) => r.id)

    if (ids.length !== owned.length || !ids.every((id) => owned.includes(id)))
      return json({ error: "Ordem inválida." }, 400)

    await env.DB.batch(
      ids.map((id, index) =>
        env.DB.prepare(
          "UPDATE catalog_images SET position=?,is_primary=? WHERE id=? AND product_id=? AND organization_id=?",
        ).bind(index, index === 0 ? 1 : 0, id, orderMatch[1], org),
      ),
    )

    return json({ ok: true })
  }

  const productMatch = path.match(/^\/api\/catalog\/products\/([\w-]+)$/)

  if (productMatch && request.method === "PUT") {
    const body = await request.json<Record<string, unknown>>().catch(() => ({}))

    const sets: string[] = []

    const values: unknown[] = []

    const text = (
      key: string,
      column: string,
      max: number,
      required = false,
    ) => {
      if (!(key in body)) return

      const value = clip(body[key], max)

      if (required && !value) throw new Error(`Campo obrigatório: ${key}`)

      sets.push(`${column}=?`)

      values.push(value)
    }

    try {
      text("name", "name", 120, true)

      text("model", "model", 80, true)

      text("version", "version", 80)

      text("brand", "brand", 80)

      text("category", "category", 80)

      text("description", "description", 2000)

      text("priceText", "price_text", 80)

      text("salePriceText", "sale_price_text", 80)

      text("cardInstallments", "card_installments", 10)

      text("cardInstallmentText", "card_installment_text", 80)
    } catch (error) {
      return json({ error: (error as Error).message }, 400)
    }

    if ("specs" in body) {
      sets.push("specs=?")

      values.push(JSON.stringify(parseSpecs(body.specs)))
    }

    if (typeof body.status === "string") {
      if (!["draft", "approved", "rejected"].includes(body.status))
        return json({ error: "Status inválido." }, 400)

      sets.push("status=?")

      values.push(body.status)
    }

    if (typeof body.authorized === "boolean") {
      sets.push("authorized_for_sale=?")

      values.push(body.authorized ? 1 : 0)
    }

    if (typeof body.availability === "string") {
      if (!["unknown", "in_stock", "out_of_stock"].includes(body.availability))
        return json({ error: "Disponibilidade inválida." }, 400)

      sets.push("availability=?", "availability_updated_at=CURRENT_TIMESTAMP")

      values.push(body.availability)
    }

    if (!sets.length) return json({ error: "Nada para atualizar." }, 400)

    const result = await env.DB.prepare(
      `UPDATE catalog_products SET ${sets.join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
    )

      .bind(...values, productMatch[1], org)

      .run()

    return result.meta.changes
      ? json({ ok: true })
      : json({ error: "Produto não encontrado." }, 404)
  }

  if (productMatch && request.method === "DELETE") {
    const keys = (
      await env.DB.prepare(
        "SELECT r2_key key FROM catalog_images WHERE product_id=? AND organization_id=?",
      )

        .bind(productMatch[1], org)

        .all<{ key: string }>()
    ).results

    const result = await env.DB.prepare(
      "DELETE FROM catalog_products WHERE id=? AND organization_id=?",
    )

      .bind(productMatch[1], org)

      .run()

    if (!result.meta.changes)
      return json({ error: "Produto não encontrado." }, 404)

    if (env.CATALOG && keys.length)
      await env.CATALOG.delete(keys.map((k) => k.key))

    return json({ ok: true })
  }

  const uploadMatch = path.match(/^\/api\/catalog\/products\/([\w-]+)\/images$/)

  if (uploadMatch && request.method === "POST") {
    if (!env.CATALOG)
      return json(
        { error: "O armazenamento de fotos (R2) ainda não foi configurado." },

        503,
      )

    const product = await env.DB.prepare(
      "SELECT 1 x FROM catalog_products WHERE id=? AND organization_id=?",
    )

      .bind(uploadMatch[1], org)

      .first()

    if (!product) return json({ error: "Produto não encontrado." }, 404)

    const form = await request.formData().catch(() => null)

    const file = form?.get("file")

    if (!(file instanceof File) || file.size === 0)
      return json({ error: "Selecione uma imagem." }, 400)

    if (file.size > MAX_IMAGE_BYTES)
      return json({ error: "A imagem deve ter no máximo 5 MB." }, 413)

    const bytes = new Uint8Array(await file.arrayBuffer())

    const mime = imageMime(bytes)

    if (!mime)
      return json(
        { error: "Use imagens JPEG ou PNG (formatos aceitos pelo WhatsApp)." },

        415,
      )

    const count = await env.DB.prepare(
      "SELECT COUNT(*) n,COALESCE(MAX(position),-1) last FROM catalog_images WHERE product_id=? AND organization_id=?",
    )

      .bind(uploadMatch[1], org)

      .first<{ n: number last: number }>()

    if ((count?.n ?? 0) >= MAX_IMAGES_PER_PRODUCT)
      return json({ error: "Limite de 10 fotos por produto." }, 409)

    const id = uid()

    const key = `${org}/${uploadMatch[1]}/${id}.${
      mime === "image/png" ? "png" : "jpg"
    }`

    await env.CATALOG.put(key, bytes, { httpMetadata: { contentType: mime } })

    await env.DB.prepare(
      "INSERT INTO catalog_images(id,organization_id,product_id,r2_key,mime,size,position,is_primary) VALUES(?,?,?,?,?,?,?,?)",
    )

      .bind(
        id,

        org,

        uploadMatch[1],

        key,

        mime,

        bytes.length,

        (count?.last ?? -1) + 1,

        count?.n ? 0 : 1,
      )

      .run()

    return json({ ok: true, id }, 201)
  }

  if (imageMatch && request.method === "PUT") {
    const image = await env.DB.prepare(
      "SELECT product_id productId FROM catalog_images WHERE id=? AND organization_id=?",
    )

      .bind(imageMatch[1], org)

      .first<{ productId: string }>()

    if (!image) return json({ error: "Imagem não encontrada." }, 404)

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE catalog_images SET is_primary=0 WHERE product_id=? AND organization_id=?",
      ).bind(image.productId, org),

      env.DB.prepare(
        "UPDATE catalog_images SET is_primary=1 WHERE id=? AND organization_id=?",
      ).bind(imageMatch[1], org),
    ])

    return json({ ok: true })
  }

  if (imageMatch && request.method === "DELETE") {
    const image = await env.DB.prepare(
      "SELECT r2_key key,product_id productId,is_primary isPrimary FROM catalog_images WHERE id=? AND organization_id=?",
    )

      .bind(imageMatch[1], org)

      .first<{ key: string productId: string isPrimary: number }>()

    if (!image) return json({ error: "Imagem não encontrada." }, 404)

    await env.DB.prepare(
      "DELETE FROM catalog_images WHERE id=? AND organization_id=?",
    )

      .bind(imageMatch[1], org)

      .run()

    if (env.CATALOG) await env.CATALOG.delete(image.key)

    if (image.isPrimary)
      await env.DB.prepare(
        "UPDATE catalog_images SET is_primary=1 WHERE id=(SELECT id FROM catalog_images WHERE product_id=? AND organization_id=? ORDER BY position LIMIT 1)",
      )

        .bind(image.productId, org)

        .run()

    return json({ ok: true })
  }

  return json({ error: "Rota não encontrada." }, 404)
}

// ---------------------------------------------------------------------------

// Ferramentas da IA

// ---------------------------------------------------------------------------

export async function catalogEnabled(env: Env, organizationId: string) {
  if (!env.CATALOG) return false

  const row = await env.DB.prepare(
    "SELECT 1 x FROM catalog_products WHERE organization_id=? AND status='approved' LIMIT 1",
  )

    .bind(organizationId)

    .first()

  return !!row
}

const searchParam = (description: string) => ({
  type: "object",

  additionalProperties: false,

  properties: { busca: { type: "string", description } },

  required: ["busca"],
})

export const catalogTools = [
  {
    type: "function",

    name: "listarModelosDisponiveis",

    description:
      "Lista somente modelos autorizados com estoque confirmado nos últimos sete dias. Use antes de oferecer produtos como disponíveis.",

    parameters: {
      type: "object",

      additionalProperties: false,

      properties: {},

      required: [],
    },

    strict: true,
  },

  {
    type: "function",

    name: "consultarProduto",

    description:
      "Busca um produto aprovado por nome, modelo ou versão e retorna as especificações verificadas.",

    parameters: searchParam("Nome ou modelo do produto, ex.: TERA"),

    strict: true,
  },

  {
    type: "function",

    name: "obterFotosProduto",

    description:
      "Informa quantas fotos aprovadas existem para o produto. Não envia nada ao cliente.",

    parameters: searchParam("Nome ou modelo do produto"),

    strict: true,
  },

  {
    type: "function",

    name: "compararProdutos",

    description:
      "Compara especificações verificadas de 2 a 4 produtos aprovados.",

    parameters: {
      type: "object",

      additionalProperties: false,

      properties: {
        modelos: { type: "array", items: { type: "string" } },
      },

      required: ["modelos"],
    },

    strict: true,
  },

  {
    type: "function",

    name: "enviarFotoProduto",

    description:
      "Envia ao cliente, pelo WhatsApp, fotos aprovadas de um produto autorizado (por padrão envie todas). Só diga que enviou se o retorno tiver enviadas > 0.",

    parameters: {
      type: "object",

      additionalProperties: false,

      properties: {
        busca: { type: "string", description: "Nome ou modelo do produto" },

        quantidade: {
          type: "integer",
          description: "Use 10 para enviar todas as fotos cadastradas",
        },
      },

      required: ["busca", "quantidade"],
    },

    strict: true,
  },

  {
    type: "function",

    name: "enviarCatalogoFiltrado",

    description:
      "Envia fotos e fichas resumidas somente dos modelos aprovados, autorizados e com estoque confirmado nos últimos sete dias. Use quando o cliente pedir o catálogo. Só diga que enviou se enviadas > 0 e informe apenas os modelos listados em modelosEnviados.",

    parameters: {
      type: "object",

      additionalProperties: false,

      properties: {},

      required: [],
    },

    strict: true,
  },
]

export type CatalogToolState = {
  sentImages: Set<string>

  attemptedImages: Set<string>

  imageFailures: Map<string, string>

  assignmentRevision?: number

  inboundExternalId?: string
}

async function findProducts(env: Env, organizationId: string, query: string) {
  const wanted = normalize(query)

  if (!wanted) return []

  const rows = await loadProducts(env, organizationId, "AND status='approved'")

  const keys = (p: ProductRow) =>
    [
      p.model,
      p.name,
      `${p.model}${p.version ?? ""}`,
      `${p.name}${p.version ?? ""}`,
    ].map(
      normalize,
    )

  const exact = rows.filter((p) => keys(p).includes(wanted))

  if (exact.length) return exact

  return rows.filter((p) =>
    keys(p).some((k) => k.includes(wanted) || wanted.includes(k)),
  )
}

const FINANCING_NOTE =
  "Financiamos em até 36x pela Sicredi, com ou sem entrada, somente para pessoas com nome limpo, sem restrições."

const cardLine = (p: ProductRow) =>
  p.cardInstallments && p.cardInstallmentText
    ? `${p.cardInstallments}x de ${p.cardInstallmentText} no cartão`
    : p.cardInstallmentText
      ? `No cartão: ${p.cardInstallmentText}`
      : ""

const summarize = (p: ProductRow) => ({
  nome: p.name,

  modelo: p.model,

  versao: p.version,

  marca: p.brand,

  categoria: p.category,

  descricao: p.description,

  especificacoes: parseSpecs(p.specs),

  preco: p.priceText,

  precoOferta: p.salePriceText,

  precoAVista: "Valores à vista são no Pix ou dinheiro.",

  precoCartao: cardLine(p) || null,

  financiamento: FINANCING_NOTE,

  ...(p.salePriceText
    ? {
        instrucaoPreco:
          "Há promoção: informe o preço normal (preco) e o preço de oferta (precoOferta) ao cliente.",
      }
    : {}),

  estoque: stockConfirmed(p)
    ? `disponível (confirmado em ${p.availabilityAt})`
    : "não confirmado: não afirme que há estoque, diga que vai confirmar com a equipe",
})

const NOT_AUTHORIZED = {
  autorizado: false,

  instrucao:
    "Modelo não autorizado para oferta. Não ofereça nem descreva; diga que precisa consultar a equipe comercial (handoff=true).",
}

const CAPTION_SPECS = ["Motor", "Bateria", "Roda", "Cores disponíveis"]

// Legenda com a ficha resumida; não menciona estoque.

function productCaption(p: ProductRow) {
  const specs = parseSpecs(p.specs)

  return [
    `*${p.name}${p.version ? ` ${p.version}` : ""}*`,

    ...CAPTION_SPECS.map((label) =>
      specs.find((s) => s.label === label),
    ).flatMap(
      (s) => (s ? [`${s.label}: ${s.value}`] : []),
    ),

    p.salePriceText && p.priceText
      ? `De ~${p.priceText}~ por *${p.salePriceText}* 🔥 (à vista no Pix ou dinheiro)`
      : p.salePriceText || p.priceText
        ? `Valor: ${p.salePriceText || p.priceText} (à vista no Pix ou dinheiro)`
        : "",

    cardLine(p),

    FINANCING_NOTE,
  ]

    .filter(Boolean)

    .join("\n")
}

// Envia o catálogo completo (modelos aprovados e autorizados) ou um modelo.

export async function sendCatalog(
  env: Env,

  sender: Session,

  conversationId: string,

  productId: string | string[] | null,

  state: CatalogToolState = {
    sentImages: new Set(),

    attemptedImages: new Set(),

    imageFailures: new Map(),
  },

  availableOnly = false,
) {
  const organizationId = sender.organizationId

  const ids = Array.isArray(productId)
    ? productId
    : productId
      ? [productId]
      : []

  const approvedRows = await loadProducts(
    env,

    organizationId,

    `AND status='approved' AND authorized_for_sale=1${
      ids.length ? ` AND id IN (${ids.map(() => "?").join(",")})` : ""
    }`,

    ids,
  )

  const rows = availableOnly
    ? approvedRows.filter(stockConfirmed)
    : approvedRows

  if (!rows.length)
    return {
      enviadas: 0,

      erro: availableOnly
        ? "Nenhum produto aprovado e autorizado tem estoque confirmado recentemente."
        : "Nenhum produto aprovado e autorizado para enviar.",
    }

  let sent = 0

  let error: string | null = null

  const sentModels: string[] = []

  for (const product of rows.slice(0, MAX_CATALOG_SEND)) {
    const result = await sendProductPhotos(
      env,

      organizationId,

      conversationId,

      state,

      product,

      MAX_IMAGES_PER_PRODUCT,

      (index) => (index === 0 ? productCaption(product) : ""),

      sender,
    )

    sent += result.enviadas

    if (result.enviadas > 0)
      sentModels.push(
        `${product.model}${product.version ? ` ${product.version}` : ""}`,
      )

    if (result.erro) {
      error = result.erro

      break
    }
  }

  return {
    enviadas: sent,

    erro: error ?? (sent ? null : "Os produtos não têm foto cadastrada."),

    ...(availableOnly ? { modelosEnviados: sentModels } : {}),
  }
}

async function sendProductPhotos(
  env: Env,

  organizationId: string,

  conversationId: string,

  state: CatalogToolState,

  product: ProductRow,

  limit: number,

  caption: (index: number) => string,

  sender: Session = { userId: "", organizationId, role: "ai" },
) {
  const images = (
    await env.DB.prepare(
      "SELECT id,r2_key key,mime FROM catalog_images WHERE product_id=? AND organization_id=? ORDER BY is_primary DESC,position LIMIT ?",
    )

      .bind(product.id, organizationId, limit)

      .all<{ id: string key: string mime: string }>()
  ).results

  let sent = 0

  let skipped = 0

  let error: string | null = null

  for (const [index, image] of images.entries()) {
    if (state.attemptedImages.has(image.id)) {
      skipped++

      const previousError = state.imageFailures.get(image.id)

      if (previousError) {
        error = previousError

        break
      }

      continue
    }

    if (state.attemptedImages.size >= MAX_PHOTOS_PER_TURN) break

    const object = await env.CATALOG?.get(image.key)

    if (!object) continue

    const file = new File(
      [await object.arrayBuffer()],

      `${product.model}-${index + 1}.${
        image.mime === "image/png" ? "png" : "jpg"
      }`,

      { type: image.mime },
    )

    state.attemptedImages.add(image.id)

    const response = await sendFile(
      env,

      sender,

      conversationId,

      file,

      caption(index),

      state.assignmentRevision,

      state.inboundExternalId
        ? `ai:${state.inboundExternalId}:catalog:${image.id}`
        : undefined,
    )

    if (response.ok) {
      state.sentImages.add(image.id)

      sent++
    } else {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string
      }

      error = data.error ?? `HTTP ${response.status}`

      state.imageFailures.set(image.id, error)

      break
    }
  }

  return { enviadas: sent, jaEnviadasNestaResposta: skipped, erro: error }
}

export async function runCatalogTool(
  env: Env,

  organizationId: string,

  conversationId: string,

  name: string,

  args: Record<string, unknown>,

  state: CatalogToolState,
): Promise<unknown> {
  const search = typeof args.busca === "string" ? args.busca : ""

  if (name === "listarModelosDisponiveis") {
    const rows = await loadProducts(
      env,

      organizationId,

      "AND status='approved' AND authorized_for_sale=1",
    )

    const available = rows.filter(stockConfirmed)

    return {
      modelosDisponiveis: available.map((p) => ({
        nome: p.name,

        modelo: p.model,

        versao: p.version,

        estoque: "confirmado",
      })),

      quantidadeComEstoqueNaoConfirmado: rows.length - available.length,
    }
  }

  if (name === "compararProdutos") {
    const models = Array.isArray(args.modelos) ? args.modelos.slice(0, 4) : []

    const result = []

    for (const model of models) {
      const [product] = await findProducts(env, organizationId, String(model))

      result.push(
        !product
          ? { busca: model, encontrado: false }
          : product.authorized
            ? summarize(product)
            : { busca: model, ...NOT_AUTHORIZED },
      )
    }

    return result
  }

  const matches = await findProducts(env, organizationId, search)

  if (name === "enviarCatalogoFiltrado") {
    const result = await sendCatalog(
      env,

      { userId: "", organizationId, role: "ai" },

      conversationId,

      null,

      state,

      true,
    )

    return {
      ...result,

      instrucao:
        "As legendas das fotos não falam de estoque. Não afirme disponibilidade se não estiver confirmada.",
    }
  }

  if (!matches.length)
    return {
      encontrado: false,
      instrucao: "Produto não está no catálogo aprovado.",
    }

  if (matches.length > 1)
    return {
      encontrado: true,

      ambiguo: true,

      opcoes: matches.map(
        (p) => `${p.model}${p.version ? ` ${p.version}` : ""}`,
      ),

      instrucao: "Pergunte qual das opções o cliente quer.",
    }

  const product = matches[0]!

  if (!product.authorized) return NOT_AUTHORIZED

  if (name === "consultarProduto") return summarize(product)

  if (name === "obterFotosProduto") {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) n FROM catalog_images WHERE product_id=? AND organization_id=?",
    )

      .bind(product.id, organizationId)

      .first<{ n: number }>()

    return { modelo: product.model, fotosAprovadas: row?.n ?? 0 }
  }

  if (name === "enviarFotoProduto") {
    const quantity = Math.max(
      1,

      Math.min(
        MAX_IMAGES_PER_PRODUCT,
        Math.round(Number(args.quantidade) || MAX_IMAGES_PER_PRODUCT),
      ),
    )

    return {
      modelo: product.model,

      ...(await sendProductPhotos(
        env,

        organizationId,

        conversationId,

        state,

        product,

        quantity,

        (index) => (index === 0 ? productCaption(product) : ""),
      )),
    }
  }

  return { erro: "Ferramenta desconhecida." }
}
