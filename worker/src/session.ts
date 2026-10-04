import type { Env } from "./env"

// Members authenticate with a bearer token held by the github.io site (a service worker adds it
// to every request); there are no cookies. Tokens are HMAC-signed JSON with a `typ` claim so an
// OAuth state can never be replayed as a session.
export const SESSION_MAX_AGE = 8 * 60 * 60

// "compute" is the Worker → compute-host assertion and "compute-lab" the lab origin's ticket
// (src/compute/tokens.ts).
export type TokenType = "session" | "state" | "compute" | "compute-lab"

export interface Session {
  typ: "session"
  login: string
  name: string
  role: "member" | "owner"
  exp: number
  /** A session stood up from a lab ticket (src/gpt/lab.ts): it is never an admin's. */
  lab?: true
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const base64url = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}
const fromBase64url = (text: string) => {
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}

const key = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])

// Signed, tamper-evident token: base64url(json) "." base64url(hmac-sha256).
export async function sign(payload: object, secret: string): Promise<string> {
  const body = encoder.encode(JSON.stringify(payload))
  const mac = await crypto.subtle.sign("HMAC", await key(secret), body)
  return `${base64url(body)}.${base64url(mac)}`
}

export async function verify<T extends { exp?: number }>(
  token: string | undefined,
  secret: string,
  typ?: TokenType,
): Promise<T | null> {
  if (!token) return null
  const [body, mac] = token.split(".")
  if (!body || !mac) return null
  try {
    const bytes = fromBase64url(body)
    const valid = await crypto.subtle.verify("HMAC", await key(secret), fromBase64url(mac), bytes)
    if (!valid) return null
    const payload = JSON.parse(decoder.decode(bytes)) as T
    if (typeof payload.exp === "number" && payload.exp * 1000 < Date.now()) return null
    if (typ && (payload as { typ?: string }).typ !== typ) return null
    return payload
  } catch {
    return null
  }
}

export const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

export function timingSafeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a)
  const right = encoder.encode(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (let index = 0; index < left.length; index++) diff |= left[index] ^ right[index]
  return diff === 0
}

/** Parse `Authorization: Bearer <token>` (member routes only; /api/agent/* reads device keys). */
export function bearer(request: Request): string | null {
  const match = (request.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}

export async function readSession(request: Request, env: Env): Promise<Session | null> {
  const session = await verify<Session>(bearer(request) ?? undefined, env.SESSION_SECRET, "session")
  if (!session || typeof session.login !== "string" || !session.login) return null
  // Logins are lowercase everywhere; a bearer from before that rule may still carry GitHub's casing.
  const login = session.login.toLowerCase()
  if (await signedOutSince(env, login, session.exp)) return null
  return { ...session, login }
}

// Signing out (POST /api/auth/logout) ends every session the member began before it, on every
// device: its bearers, and the lab tickets issued from them, which expire with their session. A
// session always ends SESSION_MAX_AGE after it began, so a token's exp tells when its session
// began, and a ticket's string stays the same for the whole session (the lab's cache keys on it).

/** When the session a bearer or lab ticket belongs to began (seconds). */
export const sessionStart = (exp: number) => exp - SESSION_MAX_AGE

/** Record a sign-out: sessions that began before now are over. Returns the cutoff (seconds). */
export async function endSessions(env: Env, login: string): Promise<number> {
  const at = Math.floor(Date.now() / 1000)
  await env.DB.prepare(
    `INSERT INTO logouts (login, not_before) VALUES (?, ?)
     ON CONFLICT (login) DO UPDATE SET not_before = MAX(not_before, excluded.not_before)`,
  )
    .bind(login, at)
    .run()
  return at
}

/** Whether the member signed out after the session a token (ending at `exp`) began. */
export async function signedOutSince(env: Env, login: string, exp: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT not_before FROM logouts WHERE login = ?")
    .bind(login)
    .first<{ not_before: number }>()
  return row !== null && sessionStart(exp) < row.not_before
}

/**
 * A probe login: a synthetic member an admin signs in as for 30 minutes (POST
 * /api/admin/acl/probe) to see the site as a member who isn't in a group would. It is never an
 * admin, and changes nothing (src/app.ts).
 */
export const PROBE_LOGIN = /^probe-[0-9a-f]{8}$/
export const isProbe = (login: string) => PROBE_LOGIN.test(login)

/** How long a probe session lasts. */
export const PROBE_MAX_AGE = 30 * 60

/** A probe session's bearer, for a new synthetic login. */
export async function issueProbe(env: Env): Promise<{ token: string; exp: number; login: string }> {
  const id = [...crypto.getRandomValues(new Uint8Array(4))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  const login = `probe-${id}`
  const exp = Math.floor(Date.now() / 1000) + PROBE_MAX_AGE
  const session: Session = { typ: "session", login, name: `probe ${id}`, role: "member", exp }
  return { token: await sign(session, env.SESSION_SECRET), exp, login }
}

export async function issueSession(
  user: { login: string; name: string; role: "member" | "owner" },
  env: Env,
): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE
  const session: Session = { typ: "session", ...user, login: user.login.toLowerCase(), exp }
  return { token: await sign(session, env.SESSION_SECRET), exp }
}
