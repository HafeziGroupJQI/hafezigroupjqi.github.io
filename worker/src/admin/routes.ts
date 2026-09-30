import { requireMutation } from "../auth"
import { type Auditor, requireAdmin } from "../audit"
import type { Env } from "../env"
import { displayTurns } from "../gpt/chat"
import { AGENT_MODELS } from "../gpt/lab-agent"
import { GptStore } from "../gpt/store"
import { HttpError, decodeSegment, json, readJson } from "../http"
import { decideClaim, pendingClaims } from "../profile/routes"
import type { VaultFetch } from "../profile/vault"
import type { RepoFetch } from "../repo"
import type { Session } from "../session"
import { discard, draftRow, liveDrafts } from "../uploads/drafts"
import { PrivateVault } from "../uploads/github"

// Group-admin console: the audit log, the admin allow-list, Hafezi GPT usage + budgets,
// members' claims of People pages, members' upload drafts, and members' Hafezi GPT conversations (read-only). Everything here is admin-only (org owners, or
// members an admin promoted).

const PAGE = 100
const LOGIN = /^[A-Za-z0-9-]{1,39}$/

export interface AuditRow {
  id: number
  at: number
  login: string
  role: string | null
  action: string
  target: string | null
  status: number | null
  detail: Record<string, unknown> | null
  ip: string | null
  user_agent: string | null
}

const month = (at = Date.now()) => new Date(at).toISOString().slice(0, 7)

function auditQuery(params: URLSearchParams, limit: number) {
  const where: string[] = []
  const binds: unknown[] = []
  const login = params.get("login")?.trim().toLowerCase()
  if (login) {
    where.push("login = ?")
    binds.push(login)
  }
  // "gpt" matches gpt.message, gpt.share …; "auth.login" matches exactly.
  const action = params.get("action")?.trim()
  if (action) {
    where.push("(action = ? OR action LIKE ?)")
    binds.push(action, `${action}.%`)
  }
  for (const [key, op] of [
    ["since", ">="],
    ["until", "<"],
    ["before_id", "<"],
  ] as const) {
    const raw = params.get(key)
    if (raw === null || raw === "") continue
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new HttpError(422, `${key} must be a number`)
    where.push(`${key === "before_id" ? "id" : "at"} ${op} ?`)
    binds.push(value)
  }
  const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY id DESC LIMIT ?`
  return { sql, binds: [...binds, limit] }
}

const toRow = (raw: Record<string, unknown>): AuditRow => ({
  ...(raw as unknown as AuditRow),
  detail: raw.detail_json ? JSON.parse(String(raw.detail_json)) : null,
})

const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export async function adminRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
  vaultFetch: VaultFetch,
  privateVaultFetch: RepoFetch,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/admin/")) return null
  await requireAdmin(env, session)
  const path = url.pathname.slice("/api/admin".length)

  if (path === "/audit" && request.method === "GET") {
    // A page is 1 to 500 rows: SQLite reads a negative LIMIT as no limit at all.
    const asked = Math.trunc(Number(url.searchParams.get("limit"))) || PAGE
    const limit = Math.min(Math.max(asked, 1), 500)
    const { sql, binds } = auditQuery(url.searchParams, limit)
    const { results } = await env.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
    const rows = results.map(toRow)
    return json({ rows, next_before_id: rows.length === limit ? rows[rows.length - 1].id : null })
  }

  if (path === "/audit.csv" && request.method === "GET") {
    const { sql, binds } = auditQuery(url.searchParams, 50_000)
    const { results } = await env.DB.prepare(sql)
      .bind(...binds)
      .all<Record<string, unknown>>()
    const columns = [
      "id",
      "at",
      "time_utc",
      "login",
      "role",
      "action",
      "target",
      "status",
      "detail_json",
      "ip",
      "user_agent",
    ]
    const lines = [columns.join(",")]
    for (const row of results)
      lines.push(
        columns
          .map((c) => csvCell(c === "time_utc" ? new Date(Number(row.at)).toISOString() : row[c]))
          .join(","),
      )
    record("admin.audit.export", null, { rows: results.length })
    return new Response(lines.join("\n") + "\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="hafezi-audit-${month()}.csv"`,
      },
    })
  }

  if (path === "/admins") {
    if (request.method === "GET") {
      const { results } = await env.DB.prepare(
        "SELECT login, added_by, added_at FROM admins ORDER BY login",
      ).all()
      return json({ admins: results, org: env.GITHUB_ORG })
    }
    if (request.method === "POST") {
      requireMutation(request, env)
      const body = (await readJson(request)) as { login?: unknown }
      const login =
        typeof body.login === "string" ? body.login.trim().replace(/^@/, "").toLowerCase() : ""
      if (!LOGIN.test(login)) throw new HttpError(422, "enter a GitHub login")
      await env.DB.prepare(
        `INSERT INTO admins (login, added_by, added_at) SELECT ?1, ?2, ?3
         WHERE NOT EXISTS (SELECT 1 FROM admins WHERE login = ?1 COLLATE NOCASE)`,
      )
        .bind(login, session.login, Date.now())
        .run()
      record("admin.promote", login)
      return json({ login }, 201)
    }
    throw new HttpError(405, "method not allowed")
  }

  const demote = path.match(/^\/admins\/([^/]+)$/)
  if (demote && request.method === "DELETE") {
    requireMutation(request, env)
    const login = decodeSegment(demote[1]).toLowerCase()
    const { meta } = await env.DB.prepare("DELETE FROM admins WHERE login = ? COLLATE NOCASE")
      .bind(login)
      .run()
    if (!meta.changes) throw new HttpError(404, "not an admin (org owners are managed on GitHub)")
    record("admin.demote", login)
    return json({ removed: login })
  }

  if (path === "/usage" && request.method === "GET") {
    const m = url.searchParams.get("month") || month()
    if (!/^\d{4}-\d{2}$/.test(m)) throw new HttpError(422, "month must be YYYY-MM")
    // Everyone with usage this month or a budget, plus everyone seen signing in.
    const { results } = await env.DB.prepare(
      `WITH people AS (
         SELECT login FROM gpt_usage WHERE month = ?1
         UNION SELECT login FROM gpt_budgets
         UNION SELECT DISTINCT login FROM audit_log WHERE action = 'auth.login'
       )
       SELECT p.login, COALESCE(u.input, 0) AS input, COALESCE(u.output, 0) AS output,
              COALESCE(u.cache_read, 0) AS cache_read, COALESCE(u.cache_write, 0) AS cache_write,
              COALESCE(u.cost_usd, 0) AS cost_usd, b.monthly_tokens
       FROM people p
       LEFT JOIN gpt_usage u ON u.login = p.login AND u.month = ?1
       LEFT JOIN gpt_budgets b ON b.login = p.login
       ORDER BY cost_usd DESC, p.login`,
    )
      .bind(m)
      .all()
    // The month by model and source (ghost text apart), and by day: gpt_usage_daily, counted
    // since migration 0015.
    const sums = `SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
      SUM(cache_write) AS cache_write, SUM(cost_usd) AS cost_usd, SUM(requests) AS requests
      FROM gpt_usage_daily WHERE day BETWEEN ?1 || '-01' AND ?1 || '-31'`
    const [models, days] = await env.DB.batch<{ model: string }>([
      env.DB.prepare(
        `SELECT model, source, ${sums} GROUP BY model, source ORDER BY cost_usd DESC, model, source`,
      ).bind(m),
      env.DB.prepare(
        `SELECT day, model, source, ${sums} GROUP BY day, model, source ORDER BY day, model, source`,
      ).bind(m),
    ])
    const labelled = (rows: Array<{ model: string }>) =>
      rows.map((row) => ({ ...row, label: AGENT_MODELS[row.model]?.label ?? row.model }))
    return json({
      month: m,
      members: results,
      models: labelled(models.results),
      days: labelled(days.results),
    })
  }

  const budget = path.match(/^\/budgets\/([^/]+)$/)
  if (budget && request.method === "PUT") {
    requireMutation(request, env)
    const login = decodeSegment(budget[1]).toLowerCase()
    if (!LOGIN.test(login)) throw new HttpError(422, "invalid login")
    const body = (await readJson(request)) as { monthly_tokens?: unknown }
    if (body.monthly_tokens === null) {
      await env.DB.prepare("DELETE FROM gpt_budgets WHERE login = ?").bind(login).run()
    } else {
      const tokens = Number(body.monthly_tokens)
      if (!Number.isInteger(tokens) || tokens < 0)
        throw new HttpError(422, "monthly_tokens must be a whole number, or null for no limit")
      await env.DB.prepare(
        `INSERT INTO gpt_budgets (login, monthly_tokens) VALUES (?, ?)
         ON CONFLICT (login) DO UPDATE SET monthly_tokens = excluded.monthly_tokens`,
      )
        .bind(login, tokens)
        .run()
    }
    record("admin.budget", login, { monthly_tokens: body.monthly_tokens ?? null })
    return json({ login, monthly_tokens: body.monthly_tokens ?? null })
  }

  // ---- members' claims of People pages (src/profile/routes.ts) ----
  if (path === "/profile-claims" && request.method === "GET")
    return json({ claims: await pendingClaims(env) })

  const claim = path.match(/^\/profile-claims\/([^/]+)\/(approve|reject)$/)
  if (claim && request.method === "POST") {
    requireMutation(request, env)
    const login = decodeSegment(claim[1]).toLowerCase()
    const approve = claim[2] === "approve"
    const decided = await decideClaim(env, vaultFetch, login, approve)
    record(`admin.profile.${claim[2]}`, login, { path: decided.path })
    return json({ login, status: approve ? "approved" : "rejected", ...decided })
  }

  // ---- members' uploads to vault-private (src/uploads/) ----
  if (path === "/uploads" && request.method === "GET")
    return json({ drafts: await liveDrafts(env, new PrivateVault(env, privateVaultFetch).repo) })

  const upload = path.match(/^\/uploads\/([0-9a-f]{12})\/discard$/)
  if (upload && request.method === "POST") {
    requireMutation(request, env)
    const row = await draftRow(env, upload[1])
    if (!row) throw new HttpError(404, "no such draft")
    await discard(
      env,
      new PrivateVault(env, privateVaultFetch),
      row,
      `discarded by ${session.login}`,
    )
    record("admin.uploads.discard", row.id, { login: row.login, pull: row.pr_number })
    return json({ id: row.id, status: "discarded" })
  }

  // ---- Hafezi GPT conversations, per member (read-only) ----
  if (path === "/gpt/members" && request.method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT c.owner AS login, COUNT(DISTINCT c.id) AS conversations, COUNT(m.id) AS messages,
              MAX(c.updated_at) AS last_at
       FROM gpt_conversations c LEFT JOIN gpt_messages m ON m.conversation_id = c.id
       GROUP BY c.owner ORDER BY last_at DESC`,
    ).all()
    return json({ members: results })
  }

  if (path === "/gpt/conversations" && request.method === "GET") {
    const login = url.searchParams.get("login")?.trim() ?? ""
    if (!LOGIN.test(login)) throw new HttpError(422, "login must be a GitHub login")
    const { results } = await env.DB.prepare(
      `SELECT c.id, c.title, c.model, p.name AS project, c.origin_slug, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM gpt_messages m WHERE m.conversation_id = c.id) AS messages
       FROM gpt_conversations c LEFT JOIN gpt_projects p ON p.id = c.project_id
       WHERE c.owner = ? COLLATE NOCASE ORDER BY c.updated_at DESC LIMIT 500`,
    )
      .bind(login)
      .all()
    return json({ login, conversations: results })
  }

  const conversation = path.match(/^\/gpt\/conversations\/([^/]+)$/)
  if (conversation && request.method === "GET") {
    const id = decodeSegment(conversation[1])
    const row = await env.DB.prepare(
      `SELECT c.id, c.owner, c.title, c.model, p.name AS project, c.origin_slug, c.forked_from,
              c.created_at, c.updated_at
       FROM gpt_conversations c LEFT JOIN gpt_projects p ON p.id = c.project_id WHERE c.id = ?`,
    )
      .bind(id)
      .first()
    if (!row) throw new HttpError(404, "no such conversation")
    const turns = displayTurns(await new GptStore(env.DB).messages(id))
    return json({ conversation: row, turns })
  }

  throw new HttpError(404, "not found")
}
