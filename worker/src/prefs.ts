import type { Auditor } from "./audit"
import { requireMutation } from "./auth"
import type { Env } from "./env"
import { HttpError, json, readJson } from "./http"
import type { Session } from "./session"

// A member's own settings for how the members site looks (D1 member_prefs, migration 0016), read
// and saved from /settings (frontend/settings/theme.js) and kept in the browser for the first
// paint (frontend/theme/). GET /api/prefs answers the defaults for a member who never saved any.
// The theme ids are the site's (tools/themes/); the Worker checks only their shape, and a browser
// that doesn't know an id shows its default.

export type ThemeMode = "light" | "dark" | "system"

export interface ThemePrefs {
  /** Dark mode off, on, or following the device. */
  mode: ThemeMode
  /** The theme for light mode, and the one for dark mode. */
  light: string
  dark: string
  /** Figures drawn on white are matched to a dark theme. */
  figures: boolean
}

export const DEFAULT_THEME: ThemePrefs = {
  mode: "light",
  light: "default",
  dark: "default-dark",
  figures: true,
}

const MODES: ThemeMode[] = ["light", "dark", "system"]
export const THEME_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

interface Row {
  theme_mode: ThemeMode
  theme_light: string
  theme_dark: string
  figures: number
  updated_at: number
}

export async function readPrefs(
  env: Env,
  login: string,
): Promise<{ theme: ThemePrefs; updated_at: number | null }> {
  const row = await env.DB.prepare(
    "SELECT theme_mode, theme_light, theme_dark, figures, updated_at FROM member_prefs WHERE login = ?",
  )
    .bind(login)
    .first<Row>()
  if (!row) return { theme: { ...DEFAULT_THEME }, updated_at: null }
  return {
    theme: {
      mode: row.theme_mode,
      light: row.theme_light,
      dark: row.theme_dark,
      figures: row.figures === 1,
    },
    updated_at: row.updated_at,
  }
}

/** The theme settings a PUT sends, over the ones already saved: any field may be left out. */
export function mergeTheme(current: ThemePrefs, sent: unknown): ThemePrefs {
  if (!sent || typeof sent !== "object" || Array.isArray(sent))
    throw new HttpError(400, "theme must be an object")
  const theme = sent as Record<string, unknown>
  const next = { ...current }
  for (const key of Object.keys(theme))
    if (!(key in DEFAULT_THEME)) throw new HttpError(400, `unknown theme setting: ${key}`)
  if (theme.mode !== undefined) {
    if (!MODES.includes(theme.mode as ThemeMode))
      throw new HttpError(400, "mode must be light, dark or system")
    next.mode = theme.mode as ThemeMode
  }
  for (const key of ["light", "dark"] as const)
    if (theme[key] !== undefined) {
      if (typeof theme[key] !== "string" || !THEME_ID.test(theme[key]))
        throw new HttpError(400, `${key} must be a theme id`)
      next[key] = theme[key]
    }
  if (theme.figures !== undefined) {
    if (typeof theme.figures !== "boolean")
      throw new HttpError(400, "figures must be true or false")
    next.figures = theme.figures
  }
  return next
}

export async function prefsRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
): Promise<Response | null> {
  if (url.pathname !== "/api/prefs") return null
  if (request.method === "GET") return json(await readPrefs(env, session.login))
  if (request.method !== "PUT") throw new HttpError(405, "method not allowed")
  requireMutation(request, env)
  const body = (await readJson(request)) as Record<string, unknown>
  const theme = mergeTheme((await readPrefs(env, session.login)).theme, body.theme)
  const now = Date.now()
  await env.DB.prepare(
    `INSERT INTO member_prefs (login, theme_mode, theme_light, theme_dark, figures, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (login) DO UPDATE SET theme_mode = excluded.theme_mode,
       theme_light = excluded.theme_light, theme_dark = excluded.theme_dark,
       figures = excluded.figures, updated_at = excluded.updated_at`,
  )
    .bind(session.login, theme.mode, theme.light, theme.dark, theme.figures ? 1 : 0, now)
    .run()
  record("prefs.theme", null, { ...theme })
  return json({ theme, updated_at: now })
}
