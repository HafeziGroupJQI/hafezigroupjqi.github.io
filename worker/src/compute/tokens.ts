import type { Env } from "../env"
import { HttpError } from "../http"
import { SESSION_MAX_AGE, type Session, sign, verify } from "../session"

// Short-lived tokens, all in the site's HMAC format (session.ts sign/verify):
//   assertion  Worker → compute host, inside every OPEN_HTTP / OPEN_WS / CONTROL frame. Signed with
//              COMPUTE_ASSERTION_SECRET, the only secret the host shares; it never sees SESSION_SECRET.
//   lab ticket Worker → browser → Worker. The lab runs on the Worker's own origin, never on the site's
//              (where the members token lives), at /lab/<ticket>/jupyter/user/<target>/…: the ticket
//              names who is looking and at which server, so a lab page reaches that one server only.

export const ASSERTION_AUDIENCE = "hafezi-compute"
export const ASSERTION_TTL = 60

export interface Assertion {
  typ: "compute"
  aud: typeof ASSERTION_AUDIENCE
  login: string
  role: "member" | "owner"
  iat: number
  exp: number
}

type Principal = Pick<Session, "login" | "role"> & { exp?: number }

const now = () => Math.floor(Date.now() / 1000)

export function assertionSecret(env: Env): string {
  if (!env.COMPUTE_ASSERTION_SECRET) throw new HttpError(503, "compute is not configured")
  return env.COMPUTE_ASSERTION_SECRET
}

export async function issueAssertion(env: Env, principal: Principal): Promise<string> {
  const iat = now()
  const claims: Assertion = {
    typ: "compute",
    aud: ASSERTION_AUDIENCE,
    login: principal.login.toLowerCase(),
    role: principal.role,
    iat,
    exp: iat + ASSERTION_TTL,
  }
  return sign(claims, assertionSecret(env))
}

/** The host's check, mirrored here so the shared vectors are exercised on both sides. */
export async function verifyAssertion(token: string, secret: string): Promise<Assertion | null> {
  const claims = await verify<Assertion>(token, secret, "compute")
  if (!claims || claims.aud !== ASSERTION_AUDIENCE || typeof claims.exp !== "number") return null
  return claims
}

export interface LabTicket {
  typ: "compute-lab"
  login: string
  role: "member" | "owner"
  /** The server this ticket opens: the viewer's own, or (owners) a member's. */
  target: string
  exp: number
}

/** A lab ticket for one server, as long-lived as the session (and never over 8 h). */
export async function issueLabTicket(
  env: Env,
  session: Principal,
  target: string,
): Promise<string> {
  const cap = now() + SESSION_MAX_AGE
  const ticket: LabTicket = {
    typ: "compute-lab",
    login: session.login.toLowerCase(),
    role: session.role,
    target: target.toLowerCase(),
    exp: Math.min(session.exp ?? cap, cap),
  }
  return sign(ticket, env.SESSION_SECRET)
}

export async function verifyLabTicket(env: Env, token: string | null): Promise<LabTicket | null> {
  const ticket = await verify<LabTicket>(token ?? undefined, env.SESSION_SECRET, "compute-lab")
  if (
    !ticket ||
    typeof ticket.login !== "string" ||
    typeof ticket.target !== "string" ||
    typeof ticket.exp !== "number"
  )
    return null
  return { ...ticket, login: ticket.login.toLowerCase(), target: ticket.target.toLowerCase() }
}
