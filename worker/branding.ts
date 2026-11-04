import type { Env, Session } from "./index"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })

const MAX_IMAGE_CHARS = 150_000
const IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

export const isValidImageData = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_IMAGE_CHARS &&
  IMAGE_PATTERN.test(value)

// Garante contraste mínimo de 3:1 com texto branco nos botões.
export function isReadableBrandColor(value: unknown): value is string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value))
    return false

  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = parseInt(value.slice(i, i + 2), 16) / 255

    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })

  const luminance = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!

  return 1.05 / (luminance + 0.05) >= 3
}

const cleanText = (value: unknown, max: number) => {
  if (value == null) return null

  if (typeof value !== "string") return undefined

  const text = value.replace(/\s+/g, " ").trim()

  if (text.length > max) return undefined

  return text || null
}

async function readBranding(env: Env, auth: Session) {
  const row = await env.DB.prepare(
    `SELECT b.display_name displayName,b.tagline,b.primary_color primaryColor,b.logo_data logo,
      (SELECT avatar_data FROM users WHERE id=?) avatar
     FROM (SELECT ? organization_id) o LEFT JOIN organization_branding b ON b.organization_id=o.organization_id`,
  )
    .bind(auth.userId, auth.organizationId)
    .first<{
      displayName: string | null
      tagline: string | null
      primaryColor: string | null
      logo: string | null
      avatar: string | null
    }>()

  return {
    displayName: row?.displayName ?? null,
    tagline: row?.tagline ?? null,
    primaryColor: row?.primaryColor ?? null,
    logo: row?.logo ?? null,
    avatar: row?.avatar ?? null,
  }
}

const audit = (env: Env, auth: Session, action: string, resourceType: string) =>
  env.DB.prepare(
    "INSERT INTO audit_logs(id,organization_id,actor_user_id,action,resource_type) VALUES(?,?,?,?,?)",
  )
    .bind(crypto.randomUUID(), auth.organizationId, auth.userId, action, resourceType)
    .run()

export async function brandingRoutes(
  request: Request,
  env: Env,
  url: URL,
  auth: Session,
): Promise<Response | null> {
  if (url.pathname === "/api/branding" && request.method === "GET")
    return json(await readBranding(env, auth))

  if (url.pathname === "/api/branding" && request.method === "PUT") {
    if (auth.role !== "admin")
      return json(
        { error: "Apenas administradores podem personalizar a empresa." },
        403,
      )

    const body = await request.json<{
      displayName?: unknown
      tagline?: unknown
      primaryColor?: unknown
      logo?: unknown
    }>()

    const displayName = cleanText(body.displayName, 60)

    const tagline = cleanText(body.tagline, 40)

    if (displayName === undefined || tagline === undefined)
      return json({ error: "Nome ou slogan inválido." }, 400)

    const primaryColor = body.primaryColor ?? null

    if (primaryColor !== null && !isReadableBrandColor(primaryColor))
      return json(
        { error: "Escolha uma cor mais escura para garantir a leitura dos botões." },
        400,
      )

    const logo = body.logo ?? null

    if (logo !== null && !isValidImageData(logo))
      return json(
        { error: "Logo inválido. Use PNG, JPG ou WebP de até 150 KB." },
        400,
      )

    await env.DB.prepare(
      `INSERT INTO organization_branding(organization_id,display_name,tagline,primary_color,logo_data,updated_at)
       VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(organization_id) DO UPDATE SET display_name=excluded.display_name,tagline=excluded.tagline,
         primary_color=excluded.primary_color,logo_data=excluded.logo_data,updated_at=CURRENT_TIMESTAMP`,
    )
      .bind(auth.organizationId, displayName, tagline, primaryColor, logo)
      .run()

    await audit(env, auth, "branding.updated", "organization")

    return json(await readBranding(env, auth))
  }

  if (url.pathname === "/api/profile/avatar" && request.method === "PUT") {
    const body = await request.json<{ avatar?: unknown }>()

    const avatar = body.avatar ?? null

    if (avatar !== null && !isValidImageData(avatar))
      return json(
        { error: "Foto inválida. Use PNG, JPG ou WebP de até 150 KB." },
        400,
      )

    await env.DB.prepare("UPDATE users SET avatar_data=? WHERE id=?")
      .bind(avatar, auth.userId)
      .run()

    return json(await readBranding(env, auth))
  }

  return null
}
