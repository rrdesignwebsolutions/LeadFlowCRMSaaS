import type { Env } from "./index"

export const INACTIVE_DAYS = 14

// Empresa abandonada: criada há mais de 14 dias, só com o dono, sem nenhum dado
// de uso (leads, contatos, integrações, conversas) e sem acesso recente.
const ABANDONED_ORGS = `
  SELECT o.id FROM organizations o
  WHERE o.created_at < datetime('now', ?1)
    AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) <= 1
    AND NOT EXISTS (SELECT 1 FROM leads x WHERE x.organization_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM contacts x WHERE x.organization_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM integrations x WHERE x.organization_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM conversations x WHERE x.organization_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM sales x WHERE x.organization_id = o.id)
    AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.organization_id = o.id AND s.last_seen_at >= datetime('now', ?1))
    AND NOT EXISTS (
      SELECT 1 FROM organization_members m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = o.id AND u.platform_role = 'superadmin'
    )`

export async function cleanupInactiveAccounts(env: Env) {
  const unverified = await env.DB.prepare(
    `SELECT id FROM users WHERE email_verified_at IS NULL AND platform_role = 'user'
       AND created_at < datetime('now', '-3 days')`,
  ).all<{ id: string }>()

  for (const { id } of unverified.results) {
    await env.DB.prepare(
      `DELETE FROM organizations WHERE id IN (
         SELECT organization_id FROM organization_members WHERE user_id = ?1
       ) AND (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = organizations.id) <= 1`,
    )
      .bind(id)
      .run()

    await env.DB.prepare(
      `DELETE FROM users WHERE id = ? AND email_verified_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = users.id)`,
    )
      .bind(id)
      .run()
  }

  const cutoff = `-${INACTIVE_DAYS} days`

  const orgs = await env.DB.prepare(ABANDONED_ORGS).bind(cutoff).all<{ id: string }>()

  if (!orgs.results.length) return { organizations: 0 }

  const owners = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM organization_members WHERE organization_id IN (${ABANDONED_ORGS})`,
  )
    .bind(cutoff)
    .all<{ user_id: string }>()

  for (const { id } of orgs.results) {
    await env.DB.prepare("DELETE FROM invitations WHERE organization_id = ?").bind(id).run()
    await env.DB.prepare("DELETE FROM organizations WHERE id = ?").bind(id).run()
  }

  for (const { user_id } of owners.results)
    await env.DB.prepare(
      `DELETE FROM users WHERE id = ? AND platform_role = 'user'
         AND NOT EXISTS (SELECT 1 FROM organization_members WHERE user_id = users.id)`,
    )
      .bind(user_id)
      .run()

  console.log("inactive_accounts_removed", orgs.results.length)

  return { organizations: orgs.results.length }
}
