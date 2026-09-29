import type { Env } from "./env"
import { HttpError } from "./http"
import type { Session } from "./session"

// Group admins and the member audit log. GitHub org owners are always admins; owners and admins
// can promote more members through /api/admin/admins. The admin check reads D1 on every call, so
// a promotion applies to the next request, not the next sign-in.

export async function isAdmin(
  env: Env,
  session: Pick<Session, "login" | "role" | "lab">,
): Promise<boolean> {
  // Code in the member's lab can read its ticket, so a lab session has the member's own rights
  // only, even an owner's.
  if (session.lab) return false
  if (session.role === "owner") return true
  // GitHub logins are case-insensitive, so an admin added as "Dave" is the session's "dave".
  const row = await env.DB.prepare("SELECT 1 FROM admins WHERE login = ? COLLATE NOCASE")
    .bind(session.login)
    .first()
  return row !== null
}

export async function requireAdmin(env: Env, session: Session): Promise<void> {
  if (!(await isAdmin(env, session))) throw new HttpError(403, "admin access required")
}

export interface AuditEntry {
  login: string
  role?: string | null
  action: string
  target?: string | null
  status?: number | null
  detail?: Record<string, unknown> | null
}

/** Days of audit history kept; the daily cron prunes older rows. */
export const AUDIT_RETENTION_DAYS = 365

/** Record one audit row without blocking or failing the request it describes. */
export function audit(env: Env, ctx: ExecutionContext, request: Request, entry: AuditEntry): void {
  const write = env.DB.prepare(
    `INSERT INTO audit_log (at, login, role, action, target, status, detail_json, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      Date.now(),
      entry.login,
      entry.role ?? null,
      entry.action,
      entry.target ?? null,
      entry.status ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
      request.headers.get("cf-connecting-ip"),
      request.headers.get("user-agent")?.slice(0, 300) ?? null,
    )
    .run()
    .catch((error) => console.error("audit write failed", error))
  ctx.waitUntil(write)
}

export async function pruneAudit(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare("DELETE FROM audit_log WHERE at < ?")
    .bind(now - AUDIT_RETENTION_DAYS * 86_400_000)
    .run()
}

/** A per-request recorder for routes. It remembers whether a route logged a specific event, so
 *  the generic `api.<METHOD>` row is written only for writes nobody described better. */
export interface Auditor {
  (action: string, target?: string | null, detail?: Record<string, unknown> | null): void
  recorded: boolean
}

export function auditor(
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  session: Pick<Session, "login" | "role">,
): Auditor {
  const record = ((action, target = null, detail = null) => {
    record.recorded = true
    audit(env, ctx, request, { login: session.login, role: session.role, action, target, detail })
  }) as Auditor
  record.recorded = false
  return record
}
