import type { Env, Session } from "./index"

import { createCatalogPdf } from "./catalog-pdf"
import { sendFile } from "./whatsapp"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,

    headers: { "content-type": "application/json; charset=utf-8" },
  })

const uid = () => crypto.randomUUID()

const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const MAX_IMAGES_PER_PRODUCT = 10

const CATALOG_BATCH_MAX_PRODUCTS = 4

const CATALOG_BATCH_MAX_SOURCE_BYTES = 16 * 1024 * 1024

const MAX_CATALOG_PDF_BYTES = 24 * 1024 * 1024

const CATALOG_JOB_MAX_ATTEMPTS = 5

const CATALOG_JOB_RETRY_SECONDS = [60, 300, 900, 3600]

const STOCK_FRESH_DAYS = 7

const clip = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null

type Spec = { label: string; value: string }

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

type CatalogDeliveryJob = {
  id: string
  organizationId: string
  conversationId: string
  inboundExternalId: string
  status: string
  attempts: number
  totalApproved: number
  totalSelected: number
  totalIncluded: number
  totalBatches: number
  errorSummary?: string | null
}

type CatalogDeliveryBatch = {
  id: string
  deliveryJobId: string
  batchIndex: number
  productIds: string
  status: string
  attempts: number
  messageId: string | null
}

class CatalogPdfTooLargeError extends Error {
  constructor() {
    super("O PDF textual do catálogo excedeu o limite de envio da Meta.")
    this.name = "CatalogPdfTooLargeError"
  }
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
      `SELECT ${PRODUCT_COLUMNS} FROM catalog_products WHERE organization_id=? ${where} ORDER BY name COLLATE NOCASE,model COLLATE NOCASE,COALESCE(version,''),id`,
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
      : typeof body.productId === "string"
        ? body.productId
        : null

    if (!/^[\w-]+$/.test(conversationId))
      return json({ error: "Conversa inválida." }, 400)

    const result = await sendCatalog(env, auth, conversationId, productId)

    if (result.status !== "ENVIADO")
      return json(
        {
          ok: false,
          enviadas: result.enviadas,
          totalProdutos: result.totalSelecionados ?? 0,
          aviso: result.erro ?? "O envio do catálogo ficou incompleto.",
          idsFaltantes: result.idsFaltantes ?? [],
        },
        result.enviadas ? 502 : 422,
      )

    return json({
      ok: true,
      enviadas: result.enviadas,
      totalProdutos: result.totalSelecionados ?? 0,
      aviso: null,
    })
  }

  if (path === "/api/catalog/products" && request.method === "GET") {
    const products = await loadProducts(env, org)

    const images = (
      await env.DB.prepare(
        "SELECT id,product_id productId,is_primary isPrimary FROM catalog_images WHERE organization_id=? ORDER BY is_primary DESC,position,created_at",
      )

        .bind(org)

        .all<{ id: string; productId: string; isPrimary: number }>()
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

      .first<{ key: string; mime: string }>()

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

      .first<{ n: number; last: number }>()

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

      .first<{ key: string; productId: string; isPrimary: number }>()

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

    name: "enviarCatalogoCompleto",

    description:
      "Envia todos os modelos aprovados e autorizados, independentemente do estoque e da quantidade cadastrada. Envia as fotos disponíveis e, se um modelo não tiver foto, envia sua ficha em texto. Use quando o cliente pedir o catálogo. Só diga que enviou se enviadas > 0 e informe apenas os modelos listados em modelosEnviados.",

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
  "Financiamento pela Sicredi em até 36 parcelas, sujeito à análise e aprovação do banco. É necessário nome limpo, sem restrições e bom score."

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

function uniqueProducts(rows: ProductRow[]) {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.id)) return false
    seen.add(row.id)
    return true
  })
}

function splitIntoBatches<T>(items: T[], sizes: number[]) {
  const batches: T[][] = []
  let batch: T[] = []
  let bytes = 0

  for (const [index, item] of items.entries()) {
    const itemBytes = sizes[index] ?? 0
    if (
      batch.length &&
      (batch.length >= CATALOG_BATCH_MAX_PRODUCTS ||
        bytes + itemBytes > CATALOG_BATCH_MAX_SOURCE_BYTES)
    ) {
      batches.push(batch)
      batch = []
      bytes = 0
    }

    batch.push(item)
    bytes += itemBytes
  }

  if (batch.length) batches.push(batch)
  return batches
}

async function primaryImageSizes(
  env: Env,
  organizationId: string,
  products: ProductRow[],
) {
  if (!products.length) return []

  const rows = (
    await env.DB.prepare(
      `SELECT product_id productId,SUM(size) size FROM catalog_images
       WHERE organization_id=? AND product_id IN (${products.map(() => "?").join(",")})
       GROUP BY product_id`,
    )
      .bind(organizationId, ...products.map((product) => product.id))
      .all<{ productId: string; size: number }>()
  ).results
  const sizes = new Map<string, number>()
  for (const row of rows)
    if (!sizes.has(row.productId)) sizes.set(row.productId, row.size)
  return products.map((product) => sizes.get(product.id) ?? 0)
}

async function catalogBatches(
  env: Env,
  organizationId: string,
  products: ProductRow[],
) {
  return splitIntoBatches(
    products,
    await primaryImageSizes(env, organizationId, products),
  )
}

async function createProductBatchPdf(
  env: Env,
  organizationId: string,
  products: ProductRow[],
) {
  const imageRows = products.length
    ? (
        await env.DB.prepare(
          `SELECT product_id productId,r2_key key,mime FROM catalog_images
           WHERE organization_id=? AND product_id IN (${products.map(() => "?").join(",")})
           ORDER BY product_id,is_primary DESC,position,created_at,id`,
        )
          .bind(organizationId, ...products.map((product) => product.id))
          .all<{ productId: string; key: string; mime: string }>()
      ).results
    : []
  const images = new Map<
    string,
    Array<{ mime: string; bytes: Uint8Array }>
  >()

  for (const image of imageRows) {
    const object = await env.CATALOG?.get(image.key)
    if (!object) {
      console.warn("catalog_pdf_image_missing", {
        organizationId,
        productId: image.productId,
      })
      continue
    }
    const productImages = images.get(image.productId) ?? []
    productImages.push({
      mime: image.mime,
      bytes: new Uint8Array(await object.arrayBuffer()),
    })
    images.set(image.productId, productImages)
  }

  const pdfProducts = products.map((product) => ({
      id: product.id,
      name: product.name,
      model: product.model,
      version: product.version,
      brand: product.brand,
      category: product.category,
      description: product.description,
      specs: parseSpecs(product.specs),
      priceText: product.priceText,
      salePriceText: product.salePriceText,
      cardInstallments: product.cardInstallments,
      cardInstallmentText: product.cardInstallmentText,
    }))
  let pdf = await createCatalogPdf(pdfProducts, images, FINANCING_NOTE)
  if (pdf.byteLength > MAX_CATALOG_PDF_BYTES) {
    console.warn("catalog_pdf_images_omitted_for_meta_limit", {
      organizationId,
      productIds: products.map((product) => product.id),
      sizeBytes: pdf.byteLength,
    })
    pdf = await createCatalogPdf(pdfProducts, new Map(), FINANCING_NOTE)
  }
  if (pdf.byteLength > MAX_CATALOG_PDF_BYTES)
    throw new CatalogPdfTooLargeError()
  return pdf
}

async function selectApprovedProducts(
  env: Env,
  organizationId: string,
  productIds: string[] = [],
) {
  const approvedInDatabase = uniqueProducts(
    await loadProducts(env, organizationId, "AND status='approved'"),
  )
  const approved = approvedInDatabase.filter(
    (product) => product.authorized === 1,
  )
  const requested = productIds.length ? new Set(productIds) : null
  const selected = requested
    ? approved.filter((product) => requested.has(product.id))
    : approved

  return {
    approved,
    approvedInDatabase,
    selected,
    excludedProductIds: approvedInDatabase
      .filter((product) => product.authorized !== 1)
      .map((product) => product.id),
  }
}

function productLabel(product: ProductRow) {
  return `${product.model}${product.version ? ` ${product.version}` : ""}`
}

function productIdBatches(batches: ProductRow[][]) {
  return batches.map((batch) => batch.map((product) => product.id))
}

async function deterministicCatalogJobId(
  organizationId: string,
  conversationId: string,
  inboundExternalId: string,
) {
  const data = new TextEncoder().encode(
    `${organizationId}\u0000${conversationId}\u0000${inboundExternalId}`,
  )
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data))
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `catalog-${hex}`
}

export async function queueCatalogDelivery(
  env: Env,
  organizationId: string,
  conversationId: string,
  inboundExternalId: string,
) {
  const { approved, approvedInDatabase, selected, excludedProductIds } =
    await selectApprovedProducts(env, organizationId)
  const batches = await catalogBatches(env, organizationId, selected)
  const includedIds = productIdBatches(batches).flat()
  const selectedIds = selected.map((product) => product.id)
  const included = new Set(includedIds)
  const missingIds = selectedIds.filter((id) => !included.has(id))

  console.info("whatsapp_catalog_selection", {
    organizationId,
    conversationId,
    TOTAL_APROVADOS: approved.length,
    TOTAL_APROVADOS_NO_BANCO: approvedInDatabase.length,
    TOTAL_SELECIONADOS: selectedIds.length,
    TOTAL_INCLUIDOS_NO_CATALOGO: includedIds.length,
    excludedByAuthorization: excludedProductIds,
    missingIds,
  })

  if (missingIds.length || selectedIds.length !== includedIds.length) {
    console.error("whatsapp_catalog_selection_incomplete", {
      organizationId,
      conversationId,
      missingIds,
    })
    return {
      enviadas: 0,
      erro: "A seleção do catálogo ficou incompleta e não será enviada.",
      status: "FALHOU",
      totalAprovados: approved.length,
      totalSelecionados: selectedIds.length,
      totalIncluidos: includedIds.length,
      idsFaltantes: missingIds,
    }
  }

  if (!selected.length) {
    await env.DB.prepare(
      "UPDATE conversations SET ai_catalog_status='FALHOU',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    )
      .bind(conversationId, organizationId)
      .run()
    return {
      enviadas: 0,
      erro: "Não há produtos aprovados e autorizados para enviar.",
      status: "FALHOU",
      totalAprovados: approved.length,
      totalSelecionados: 0,
      totalIncluidos: 0,
      idsFaltantes: [],
    }
  }

  const jobId = await deterministicCatalogJobId(
    organizationId,
    conversationId,
    inboundExternalId,
  )
  const batchIds = productIdBatches(batches)
  const statements = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO catalog_delivery_jobs(
        id,organization_id,conversation_id,inbound_external_id,total_approved,
        total_selected,total_included,total_batches,excluded_product_ids
      ) VALUES(?,?,?,?,?,?,?,?,?)`,
    ).bind(
      jobId,
      organizationId,
      conversationId,
      inboundExternalId,
      approved.length,
      selectedIds.length,
      includedIds.length,
      batches.length,
      JSON.stringify(excludedProductIds),
    ),
    ...batchIds.map((ids, batchIndex) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO catalog_delivery_batches(
          id,delivery_job_id,batch_index,product_ids
        ) VALUES(?,?,?,?)`,
      ).bind(
        `${jobId}:${batchIndex}`,
        jobId,
        batchIndex,
        JSON.stringify(ids),
      ),
    ),
    env.DB.prepare(
      `UPDATE conversations SET ai_catalog_status=CASE
         WHEN (SELECT status FROM catalog_delivery_jobs WHERE id=?)='completed' THEN 'ENVIADO'
         WHEN (SELECT status FROM catalog_delivery_jobs WHERE id=?) IN ('failed','needs_review') THEN 'FALHOU'
         ELSE 'ENVIANDO' END,
         ai_catalog_source_external_id=?,ai_catalog_updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND organization_id=?`,
    ).bind(jobId, jobId, inboundExternalId, conversationId, organizationId),
  ]
  await env.DB.batch(statements)

  const job = await env.DB.prepare(
    "SELECT id,status,delivery_status deliveryStatus,total_approved totalApproved,total_selected totalSelected,total_included totalIncluded,total_batches totalBatches,error_summary errorSummary FROM catalog_delivery_jobs WHERE id=? AND organization_id=?",
  )
    .bind(jobId, organizationId)
    .first<{
      id: string
      status: string
      deliveryStatus: string
      totalApproved: number
      totalSelected: number
      totalIncluded: number
      totalBatches: number
      errorSummary: string | null
    }>()

  if (!job) throw new Error("O job de envio do catálogo não foi persistido.")

  return {
    enviadas: 0,
    status:
      job.status === "completed"
        ? "ENVIADO"
        : job.status === "failed" || job.status === "needs_review"
          ? "FALHOU"
          : "ENVIANDO",
    erro:
      job.status === "failed" || job.status === "needs_review"
        ? job.errorSummary ?? "O envio do catálogo requer revisão."
        : null,
    jobId: job.id,
    statusEntrega: job.deliveryStatus,
    totalAprovados: job.totalApproved,
    totalSelecionados: job.totalSelected,
    totalIncluidos: job.totalIncluded,
    totalLotes: job.totalBatches,
    modelosEnviados: [],
    modelosEnfileirados: selected.map(productLabel),
  }
}

async function sendCatalogNow(
  env: Env,
  sender: Session,
  conversationId: string,
  productIds: string[],
) {
  const organizationId = sender.organizationId
  const { approved, approvedInDatabase, selected, excludedProductIds } =
    await selectApprovedProducts(env, organizationId, productIds)
  const batches = await catalogBatches(env, organizationId, selected)
  const includedIds = productIdBatches(batches).flat()
  const sentModels: string[] = []
  const selectedIds = selected.map((product) => product.id)
  const includedSet = new Set(includedIds)
  const missingBeforeSend = selectedIds.filter((id) => !includedSet.has(id))
  let sent = 0
  let error: string | null = null

  console.info("whatsapp_catalog_selection", {
    organizationId,
    conversationId,
    TOTAL_APROVADOS: approved.length,
    TOTAL_APROVADOS_NO_BANCO: approvedInDatabase.length,
    TOTAL_SELECIONADOS: selected.length,
    TOTAL_INCLUIDOS_NO_CATALOGO: includedIds.length,
    excludedByAuthorization: excludedProductIds,
    missingIds: missingBeforeSend,
  })

  if (
    missingBeforeSend.length ||
    includedIds.length !== selectedIds.length ||
    new Set(includedIds).size !== includedIds.length
  ) {
    console.error("whatsapp_catalog_selection_incomplete", {
      organizationId,
      conversationId,
      missingIds: missingBeforeSend,
    })
    return {
      enviadas: 0,
      erro: "A seleção do catálogo ficou incompleta e não será enviada.",
      status: "FALHOU",
      totalAprovados: approved.length,
      totalSelecionados: selected.length,
      totalIncluidos: includedIds.length,
      totalLotes: batches.length,
      idsFaltantes: missingBeforeSend,
      modelosEnviados: [],
    }
  }

  for (const [batchIndex, batch] of batches.entries()) {
    try {
      const file = new File(
        [await createProductBatchPdf(env, organizationId, batch)],
        `catalogo-${batchIndex + 1}-de-${batches.length}.pdf`,
        { type: "application/pdf" },
      )
      const response = await sendFile(
        env,
        sender,
        conversationId,
        file,
        `Catálogo completo - parte ${batchIndex + 1} de ${batches.length}`,
      )
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as {
          error?: string
        }
        error = data.error ?? `HTTP ${response.status}`
        break
      }
      sent++
      sentModels.push(...batch.map(productLabel))
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Falha inesperada no PDF."
      console.error("whatsapp_catalog_manual_batch_failed", {
        organizationId,
        conversationId,
        batchIndex,
        productIds: batch.map((product) => product.id),
        error,
      })
      break
    }
  }

  const acceptedIds = batches
    .slice(0, sent)
    .flatMap((batch) => batch.map((product) => product.id))
  const acceptedSet = new Set(acceptedIds)
  const missingIds = selectedIds.filter((id) => !acceptedSet.has(id))
  const status =
    selectedIds.length > 0 &&
    !error &&
    !missingIds.length &&
    acceptedSet.size === selectedIds.length
      ? "ENVIADO"
      : "FALHOU"
  if (missingIds.length)
    console.error("whatsapp_catalog_manual_delivery_incomplete", {
      organizationId,
      conversationId,
      TOTAL_APROVADOS: approved.length,
      TOTAL_SELECIONADOS: selected.length,
      TOTAL_INCLUIDOS_NO_CATALOGO: includedIds.length,
      TOTAL_ACEITOS_PELA_API: acceptedIds.length,
      missingIds,
      error,
    })

  return {
    enviadas: sent,
    erro: error ?? (sent ? null : "Nenhum produto aprovado e autorizado para enviar."),
    status,
    modelosEnviados: sentModels,
    totalAprovados: approved.length,
    totalSelecionados: selected.length,
    totalIncluidos: includedIds.length,
    totalLotes: batches.length,
    totalAceitos: acceptedIds.length,
    idsFaltantes: missingIds,
  }
}

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
) {
  if (sender.role === "ai") {
    if (!state.inboundExternalId)
      return {
        enviadas: 0,
        erro: "Não foi possível vincular o envio do catálogo à mensagem recebida.",
        status: "FALHOU",
      }
    return queueCatalogDelivery(
      env,
      sender.organizationId,
      conversationId,
      state.inboundExternalId,
    )
  }

  const ids = Array.isArray(productId)
    ? productId
    : productId
      ? [productId]
      : []
  return sendCatalogNow(env, sender, conversationId, ids)
}

function parseProductIds(value: string) {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string"))
    throw new Error("A lista de produtos do lote do catálogo está inválida.")
  return parsed
}

async function updateCatalogDeliveryFailure(
  env: Env,
  job: CatalogDeliveryJob,
  batch: CatalogDeliveryBatch,
  status: "failed" | "needs_review",
  message: string,
) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE catalog_delivery_batches SET status=?,error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND delivery_job_id=?",
    ).bind(status, message.slice(0, 1000), batch.id, job.id),
    env.DB.prepare(
      "UPDATE catalog_delivery_jobs SET status=?,locked_until=NULL,error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(status, message.slice(0, 1000), job.id, job.organizationId),
    env.DB.prepare(
      "UPDATE conversations SET ai_catalog_status='FALHOU',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
    ).bind(job.conversationId, job.organizationId),
  ])
  console.error("whatsapp_catalog_delivery_incomplete", {
    organizationId: job.organizationId,
    conversationId: job.conversationId,
    jobId: job.id,
    batchIndex: batch.batchIndex,
    productIds: parseProductIds(batch.productIds),
    status,
    error: message,
  })
}

async function processCatalogDeliveryJob(env: Env, jobId: string) {
  const claimed = await env.DB.prepare(
    `UPDATE catalog_delivery_jobs
     SET status='processing',attempts=attempts+1,
       locked_until=datetime('now','+10 minutes'),updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND (
       (status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP) OR
       (status='processing' AND locked_until<=CURRENT_TIMESTAMP)
     )`,
  )
    .bind(jobId)
    .run()
  if (!claimed.meta.changes) return

  const job = await env.DB.prepare(
    `SELECT id,organization_id organizationId,conversation_id conversationId,
       inbound_external_id inboundExternalId,status,attempts,
       total_approved totalApproved,total_selected totalSelected,
       total_included totalIncluded,total_batches totalBatches
     FROM catalog_delivery_jobs WHERE id=? AND status='processing'`,
  )
    .bind(jobId)
    .first<CatalogDeliveryJob>()
  if (!job) throw new Error("O job de envio do catálogo não foi encontrado.")

  try {
    const batches = (
      await env.DB.prepare(
        `SELECT id,delivery_job_id deliveryJobId,batch_index batchIndex,
           product_ids productIds,status,attempts,message_id messageId
         FROM catalog_delivery_batches
         WHERE delivery_job_id=? ORDER BY batch_index`,
      )
        .bind(job.id)
        .all<CatalogDeliveryBatch>()
    ).results
    const selectedIds = batches.flatMap((batch) =>
      parseProductIds(batch.productIds),
    )

    if (
      batches.length !== job.totalBatches ||
      selectedIds.length !== job.totalSelected ||
      new Set(selectedIds).size !== selectedIds.length
    ) {
      await env.DB.prepare(
        "UPDATE catalog_delivery_jobs SET status='needs_review',locked_until=NULL,error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      )
        .bind(
          "A lista de produtos dos lotes diverge da seleção aprovada.",
          job.id,
          job.organizationId,
        )
        .run()
      await env.DB.prepare(
        "UPDATE conversations SET ai_catalog_status='FALHOU',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      )
        .bind(job.conversationId, job.organizationId)
        .run()
      console.error("whatsapp_catalog_batch_manifest_mismatch", {
        organizationId: job.organizationId,
        conversationId: job.conversationId,
        jobId: job.id,
        selectedIds,
        totalSelected: job.totalSelected,
        totalBatches: job.totalBatches,
        actualBatches: batches.length,
      })
      return
    }

    for (const batch of batches) {
      if (batch.status === "accepted") continue
      if (batch.status === "failed" || batch.status === "needs_review") {
        await env.DB.prepare(
          "UPDATE catalog_delivery_jobs SET status=?,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
        )
          .bind(batch.status, job.id, job.organizationId)
          .run()
        return
      }

      const productIds = parseProductIds(batch.productIds)
      const placeholders = productIds.map(() => "?").join(",")
      const matchingProducts = uniqueProducts(
        await loadProducts(
          env,
          job.organizationId,
          `AND status='approved' AND authorized_for_sale=1 AND id IN (${placeholders})`,
          productIds,
        ),
      )
      const productById = new Map(
        matchingProducts.map((product) => [product.id, product]),
      )
      const products = productIds
        .map((id) => productById.get(id))
        .filter((product): product is ProductRow => !!product)
      const missingIds = productIds.filter((id) => !productById.has(id))

      if (missingIds.length) {
        await updateCatalogDeliveryFailure(
          env,
          job,
          batch,
          "needs_review",
          `Produtos aprovados removidos ou sem autorização antes do envio: ${missingIds.join(", ")}`,
        )
        return
      }

      const prefix = `ai:${job.inboundExternalId}:catalog:${job.id}:batch:${batch.batchIndex}:attempt:`
      const priorAttempts = (
        await env.DB.prepare(
          `SELECT id,status,error_code errorCode,ai_reply_key aiReplyKey
           FROM messages WHERE organization_id=? AND is_ai=1
             AND substr(ai_reply_key,1,?)=?
           ORDER BY rowid`,
        )
          .bind(job.organizationId, prefix.length, prefix)
          .all<{
            id: string
            status: string
            errorCode: string | null
            aiReplyKey: string
          }>()
      ).results
      const accepted = priorAttempts.find((message) =>
        ["accepted", "sent", "delivered", "read"].includes(message.status),
      )

      if (accepted) {
        await env.DB.prepare(
          `UPDATE catalog_delivery_batches SET status='accepted',
             delivery_status=?,message_id=?,error_summary=NULL,
             updated_at=CURRENT_TIMESTAMP WHERE id=? AND delivery_job_id=?`,
        )
          .bind(accepted.status, accepted.id, batch.id, job.id)
          .run()
        continue
      }

      const latestAttempt = priorAttempts.at(-1)
      if (
        latestAttempt?.status === "failed" &&
        (latestAttempt.errorCode === "network" ||
          latestAttempt.errorCode === "assignment_changed")
      ) {
        await updateCatalogDeliveryFailure(
          env,
          job,
          batch,
          "needs_review",
          `Não é seguro repetir automaticamente o lote após erro ${latestAttempt.errorCode}.`,
        )
        return
      }

      const previousAttemptNumber = latestAttempt
        ? Number(latestAttempt.aiReplyKey.slice(prefix.length))
        : 0
      const attemptNumber = latestAttempt
        ? previousAttemptNumber + 1
        : Math.max(1, batch.attempts)
      await env.DB.prepare(
        `UPDATE catalog_delivery_batches SET status='processing',attempts=?,
           updated_at=CURRENT_TIMESTAMP WHERE id=? AND delivery_job_id=?`,
      )
        .bind(attemptNumber, batch.id, job.id)
        .run()

      const pdf = await createProductBatchPdf(env, job.organizationId, products)
      const file = new File(
        [pdf],
        `catalogo-${batch.batchIndex + 1}-de-${batches.length}.pdf`,
        { type: "application/pdf" },
      )
      const messageKey = `${prefix}${attemptNumber}`
      const response = await sendFile(
        env,
        { userId: "", organizationId: job.organizationId, role: "ai" },
        job.conversationId,
        file,
        `Catálogo completo - parte ${batch.batchIndex + 1} de ${batches.length}`,
        undefined,
        messageKey,
      )
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
        messageId?: string
      }

      if (response.ok) {
        if (!body.messageId)
          throw new Error(
            `A Meta aceitou o lote ${batch.batchIndex + 1}, mas o registro da mensagem não retornou ID.`,
          )
        const message = await env.DB.prepare(
          "SELECT status FROM messages WHERE id=? AND organization_id=?",
        )
          .bind(body.messageId, job.organizationId)
          .first<{ status: string }>()
        const deliveryStatus = [
          "accepted",
          "sent",
          "delivered",
          "read",
        ].includes(message?.status ?? "")
          ? message!.status
          : "accepted"
        await env.DB.prepare(
          `UPDATE catalog_delivery_batches SET status='accepted',
             delivery_status=?,message_id=?,error_summary=NULL,
             updated_at=CURRENT_TIMESTAMP WHERE id=? AND delivery_job_id=?`,
        )
          .bind(deliveryStatus, body.messageId, batch.id, job.id)
          .run()
        console.info("whatsapp_catalog_batch_accepted", {
          organizationId: job.organizationId,
          conversationId: job.conversationId,
          jobId: job.id,
          batchIndex: batch.batchIndex,
          productIds,
          messageId: body.messageId,
        })
        continue
      }

      const message = body.messageId
        ? await env.DB.prepare(
            "SELECT error_code errorCode FROM messages WHERE id=? AND organization_id=?",
          )
            .bind(body.messageId, job.organizationId)
            .first<{ errorCode: string | null }>()
        : null
      const retryable = !!message?.errorCode && /^\d+$/.test(message.errorCode)
      const retryExhausted = attemptNumber >= CATALOG_JOB_MAX_ATTEMPTS
      const retryStatus = retryable && !retryExhausted ? "pending" : "failed"
      const delay =
        CATALOG_JOB_RETRY_SECONDS[
          Math.min(attemptNumber - 1, CATALOG_JOB_RETRY_SECONDS.length - 1)
        ] ?? 3600
      const error = body.error ?? `HTTP ${response.status}`

      if (retryStatus === "pending") {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE catalog_delivery_batches SET status='pending',message_id=?,
               error_summary=?,updated_at=CURRENT_TIMESTAMP
             WHERE id=? AND delivery_job_id=?`,
          ).bind(body.messageId ?? null, error.slice(0, 1000), batch.id, job.id),
          env.DB.prepare(
            `UPDATE catalog_delivery_jobs SET status='pending',locked_until=NULL,
               next_attempt_at=datetime('now',?),error_summary=?,
               updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?`,
          ).bind(`+${delay} seconds`, error.slice(0, 1000), job.id, job.organizationId),
          env.DB.prepare(
            "UPDATE conversations SET ai_catalog_status='ENVIANDO',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
          ).bind(job.conversationId, job.organizationId),
        ])
        console.warn("whatsapp_catalog_batch_retry_scheduled", {
          organizationId: job.organizationId,
          conversationId: job.conversationId,
          jobId: job.id,
          batchIndex: batch.batchIndex,
          productIds,
          attempt: attemptNumber,
          retryAfterSeconds: delay,
          error,
        })
        return
      }

      await updateCatalogDeliveryFailure(
        env,
        job,
        batch,
        retryable || message?.errorCode
          ? "failed"
          : "needs_review",
        error,
      )
      return
    }

    const updatedBatches = (
      await env.DB.prepare(
        `SELECT id,delivery_job_id deliveryJobId,batch_index batchIndex,
           product_ids productIds,status,attempts,message_id messageId
         FROM catalog_delivery_batches
         WHERE delivery_job_id=? ORDER BY batch_index`,
      )
        .bind(job.id)
        .all<CatalogDeliveryBatch>()
    ).results
    const acceptedIds = updatedBatches
      .filter((batch) => batch.status === "accepted")
      .flatMap((batch) => parseProductIds(batch.productIds))
    const acceptedSet = new Set(acceptedIds)
    const missingIds = selectedIds.filter((id) => !acceptedSet.has(id))

    if (missingIds.length || acceptedSet.size !== job.totalSelected) {
      console.error("whatsapp_catalog_delivery_ids_incomplete", {
        organizationId: job.organizationId,
        conversationId: job.conversationId,
        jobId: job.id,
        missingIds,
        acceptedIds,
        totalApproved: job.totalApproved,
        totalSelected: job.totalSelected,
        totalIncluded: job.totalIncluded,
      })
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE catalog_delivery_jobs SET status='needs_review',locked_until=NULL,error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
        ).bind(
          `IDs sem aceite da API: ${missingIds.join(", ")}`,
          job.id,
          job.organizationId,
        ),
        env.DB.prepare(
          "UPDATE conversations SET ai_catalog_status='FALHOU',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
        ).bind(job.conversationId, job.organizationId),
      ])
      return
    }

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE catalog_delivery_jobs SET status='completed',delivery_status=
           CASE WHEN NOT EXISTS (
             SELECT 1 FROM catalog_delivery_batches
             WHERE delivery_job_id=? AND delivery_status NOT IN ('delivered','read')
           ) THEN 'delivered' ELSE 'pending' END,
           locked_until=NULL,error_summary=NULL,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=?`,
      ).bind(job.id, job.id, job.organizationId),
      env.DB.prepare(
        "UPDATE conversations SET ai_catalog_status='ENVIADO',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
      ).bind(job.conversationId, job.organizationId),
    ])
    console.info("whatsapp_ai_catalog_completed", {
      organizationId: job.organizationId,
      conversationId: job.conversationId,
      jobId: job.id,
      totalApproved: job.totalApproved,
      totalSelected: job.totalSelected,
      totalIncluded: job.totalIncluded,
      acceptedIds,
      deliveryStatus: "pending",
    })
  } catch (error) {
    const summary =
      error instanceof Error ? error.message.slice(0, 1000) : "Erro desconhecido"
    if (error instanceof CatalogPdfTooLargeError) {
      const affectedIds = (
        await env.DB.prepare(
          "SELECT product_ids productIds FROM catalog_delivery_batches WHERE delivery_job_id=? AND status='processing'",
        )
          .bind(job.id)
          .all<{ productIds: string }>()
      ).results.flatMap((batch) => parseProductIds(batch.productIds))
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE catalog_delivery_batches SET status='needs_review',error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE delivery_job_id=? AND status='processing'",
        ).bind(summary, job.id),
        env.DB.prepare(
          "UPDATE catalog_delivery_jobs SET status='needs_review',locked_until=NULL,error_summary=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
        ).bind(summary, job.id, job.organizationId),
        env.DB.prepare(
          "UPDATE conversations SET ai_catalog_status='FALHOU',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
        ).bind(job.conversationId, job.organizationId),
      ])
      console.error("whatsapp_catalog_pdf_exceeds_meta_limit", {
        organizationId: job.organizationId,
        conversationId: job.conversationId,
        jobId: job.id,
        productIds: affectedIds,
        error: summary,
      })
      return
    }

    const failed = job.attempts >= CATALOG_JOB_MAX_ATTEMPTS
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE catalog_delivery_jobs SET status=?,locked_until=NULL,
           next_attempt_at=CASE WHEN ?='pending' THEN datetime('now','+60 seconds') ELSE next_attempt_at END,
           error_summary=?,updated_at=CURRENT_TIMESTAMP
         WHERE id=? AND organization_id=?`,
      ).bind(
        failed ? "failed" : "pending",
        failed ? "failed" : "pending",
        summary,
        job.id,
        job.organizationId,
      ),
      ...(failed
        ? [
            env.DB.prepare(
              "UPDATE conversations SET ai_catalog_status='FALHOU',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=?",
            ).bind(job.conversationId, job.organizationId),
          ]
        : []),
    ])
    console.error("whatsapp_catalog_delivery_job_failed", {
      organizationId: job.organizationId,
      conversationId: job.conversationId,
      jobId: job.id,
      attempt: job.attempts,
      status: failed ? "failed" : "pending",
      error: summary,
    })
  }
}

export async function processPendingCatalogDeliveries(
  env: Env,
  organizationId?: string,
  conversationId?: string,
  limit = 10,
) {
  for (let count = 0; count < limit; count++) {
    const filters = [
      "(status='pending' AND next_attempt_at<=CURRENT_TIMESTAMP) OR (status='processing' AND locked_until<=CURRENT_TIMESTAMP)",
    ]
    const values: string[] = []
    if (organizationId) {
      filters.push("organization_id=?")
      values.push(organizationId)
    }
    if (conversationId) {
      filters.push("conversation_id=?")
      values.push(conversationId)
    }
    const job = await env.DB.prepare(
      `SELECT id FROM catalog_delivery_jobs WHERE (${filters[0]})${
        filters.length > 1 ? ` AND ${filters.slice(1).join(" AND ")}` : ""
      } ORDER BY created_at,id LIMIT 1`,
    )
      .bind(...values)
      .first<{ id: string }>()
    if (!job) return
    await processCatalogDeliveryJob(env, job.id)
  }
}

export async function recoverUnqueuedCatalogDeliveries(
  env: Env,
  limit = 20,
) {
  const conversations = (
    await env.DB.prepare(
      `SELECT c.id conversationId,c.organization_id organizationId,
         c.ai_catalog_source_external_id inboundExternalId
       FROM conversations c
       WHERE c.ai_catalog_status='ENVIANDO'
         AND c.ai_catalog_source_external_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM messages m
           WHERE m.organization_id=c.organization_id
             AND m.conversation_id=c.id AND m.direction='outbound' AND m.is_ai=1
             AND m.ai_reply_key='ai:'||c.ai_catalog_source_external_id||':welcome'
             AND m.status IN ('accepted','sent','delivered','read')
         )
         AND NOT EXISTS (
           SELECT 1 FROM catalog_delivery_jobs j
           WHERE j.organization_id=c.organization_id
             AND j.conversation_id=c.id
             AND j.inbound_external_id=c.ai_catalog_source_external_id
         )
       ORDER BY c.ai_catalog_updated_at,c.id LIMIT ?`,
    )
      .bind(limit)
      .all<{
        conversationId: string
        organizationId: string
        inboundExternalId: string
      }>()
  ).results

  for (const conversation of conversations) {
    const result = await queueCatalogDelivery(
      env,
      conversation.organizationId,
      conversation.conversationId,
      conversation.inboundExternalId,
    )
    if (result.status === "FALHOU")
      await env.DB.prepare(
        "UPDATE conversations SET ai_catalog_status='FALHOU',ai_catalog_updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND ai_catalog_status='ENVIANDO'",
      )
        .bind(conversation.conversationId, conversation.organizationId)
        .run()
    console.info("whatsapp_catalog_orphaned_welcome_recovered", {
      organizationId: conversation.organizationId,
      conversationId: conversation.conversationId,
      inboundExternalId: conversation.inboundExternalId,
      status: result.status,
    })
  }
  return conversations.length
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

      .all<{ id: string; key: string; mime: string }>()
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

  if (name === "enviarCatalogoCompleto") {
    const result = await sendCatalog(
      env,

      { userId: "", organizationId, role: "ai" },

      conversationId,

      null,

      state,
    )

    return {
      ...result,

      instrucao:
        "As legendas das fotos não falam de estoque. Não afirme disponibilidade se não estiver confirmada. ENVIADO confirma aceite de todos os lotes pela API, não entrega ao destinatário; consulte statusEntrega antes de falar sobre entrega.",
    }
  }

  const matches = await findProducts(env, organizationId, search)

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
