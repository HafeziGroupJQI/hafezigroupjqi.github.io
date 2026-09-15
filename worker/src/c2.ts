/**
 * Gateway to the instrument service (hafezi-c2) on the lab PC.
 *
 * The member site is the only thing C2 trusts in `C2_AUTH=gateway`: it authenticates the lab
 * member here, then signs a short-lived assertion bound to one path and one method, so an
 * assertion captured on a harmless read cannot be replayed against a write.
 *
 * C2 sits behind a Cloudflare Tunnel public hostname with an Access policy in front, which
 * the Worker passes with a service token. Workers run at Cloudflare's edge and cannot reach
 * a WARP private network, which is why the tunnel exists at all.
 */

import { requireMutation } from "./auth"
import { type Upstream } from "./docs"
import type { Env } from "./env"
import { HttpError, json } from "./http"
import { dumps } from "./itsdangerous"
import type { Session } from "./session"

const SALT = "hafezi-c2-gateway"
const TIMEOUT_MS = 10_000
const PREFIX = "/api/c2/"

/** Only these C2 routes are reachable through the member site. */
const READABLE = [
  /^instruments$/,
  /^setups$/,
  /^events$/,
  /^runs$/,
  /^instruments\/[A-Za-z0-9_-]+\/(status|history)$/,
  /^runs\/[A-Za-z0-9T-]+$/,
]
const WRITABLE = [/^instruments\/[A-Za-z0-9_-]+\/poll$/]

const configured = (env: Env) => Boolean(env.C2_URL && env.C2_GATEWAY_SECRET)

const matches = (patterns: RegExp[], target: string) => patterns.some((p) => p.test(target))

async function forward(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  target: string,
  upstream: Upstream,
): Promise<unknown> {
  const path = `/api/${target}`
  const assertion = await dumps(
    { login: session.login, role: session.role, aud: "c2", path, method: request.method },
    env.C2_GATEWAY_SECRET as string,
    SALT,
  )
  const headers: Record<string, string> = {
    "X-Hafezi-Assertion": assertion,
    accept: "application/json",
  }
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.CF_ACCESS_CLIENT_ID
    headers["CF-Access-Client-Secret"] = env.CF_ACCESS_CLIENT_SECRET
  }

  let response: Response
  try {
    response = await upstream(`${(env.C2_URL as string).replace(/\/$/, "")}${path}${url.search}`, {
      method: request.method,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    // the instrument PC being off is normal, not a bug in the site
    throw new HttpError(503, "instrument service unavailable")
  }
  if (!response.ok) throw new HttpError(502, "instrument service rejected the request")
  try {
    return await response.json()
  } catch {
    throw new HttpError(502, "instrument service returned a malformed response")
  }
}

export async function c2Routes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  upstream: Upstream = (input, init) => fetch(input, init),
): Promise<Response | null> {
  if (!url.pathname.startsWith(PREFIX)) return null
  const target = decodeURIComponent(url.pathname.slice(PREFIX.length)).replace(/\/$/, "")

  if (target === "status") {
    if (!configured(env)) return json({ state: "not_configured", message: "Not configured" })
    try {
      await forward(request, url, env, session, "instruments", upstream)
      return json({ state: "connected", message: "Connected" })
    } catch {
      // status reports an outage, it does not become one
      return json({ state: "unavailable", message: "Instrument service unavailable" })
    }
  }

  if (!configured(env)) throw new HttpError(503, "instrument service is not configured")

  if (request.method === "POST") {
    requireMutation(request, url, session)
    if (!matches(WRITABLE, target)) throw new HttpError(404, "not found")
  } else if (request.method === "GET") {
    if (!matches(READABLE, target)) throw new HttpError(404, "not found")
  } else {
    throw new HttpError(405, "method not allowed")
  }
  return json(await forward(request, url, env, session, target, upstream))
}
