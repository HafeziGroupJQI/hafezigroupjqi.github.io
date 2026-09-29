import { verifyLabTicket } from "../compute/tokens"
import type { Env } from "../env"
import { HttpError } from "../http"
import { navIdentity } from "../profile/routes"
import { type Session, signedOutSince } from "../session"

// Hafezi GPT inside JupyterLab (the lab extension's panel), on the lab origin: the Worker's own
// origin, where the site's bearer never is. The panel calls /lab/<ticket>/hafezi-gpt/api/gpt/...,
// and the lab ticket in the path is the credential, as it is for the lab itself. Only in a
// member's own lab: in a lab an owner opens for another member, that member's code runs on this
// origin and could read the ticket, so it must not reach the owner's conversations.

const LAB_GPT = /^\/lab\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/hafezi-gpt(\/api\/gpt\/.*)$/

export const isLabGptPath = (path: string) => LAB_GPT.test(path)

/**
 * The member a lab-origin request comes from, from the lab ticket in its path: same origin only
 * (writes must say so), no service workers, and only in the member's own lab.
 */
export async function labSession(
  request: Request,
  url: URL,
  env: Env,
  token: string,
): Promise<Session> {
  const origin = request.headers.get("origin")
  if (origin !== null && origin !== url.origin)
    throw new HttpError(403, "request from an unknown origin")
  if (request.method !== "GET" && request.method !== "HEAD" && origin === null)
    throw new HttpError(403, "writes must come from the lab page")
  if (request.headers.get("service-worker"))
    throw new HttpError(403, "service workers are not allowed on the lab origin")
  const ticket = await verifyLabTicket(env, token)
  if (!ticket || (await signedOutSince(env, ticket.login, ticket.exp)))
    throw new HttpError(401, "this lab link has expired; open the lab again from the Scratchpad")
  if (ticket.login !== ticket.target)
    throw new HttpError(403, "Hafezi GPT is available in your own lab only")
  const base: Session = {
    typ: "session",
    login: ticket.login,
    name: ticket.login,
    role: ticket.role,
    exp: ticket.exp,
  }
  return { ...base, name: (await navIdentity(env, base)).display_name }
}

/**
 * The member session and the /api/gpt request a lab-origin GPT call stands for. The Origin check
 * is done here (same origin only), so the request passed on carries no Origin for the site's own
 * check (requireMutation) to refuse.
 */
export async function labGptRequest(
  request: Request,
  url: URL,
  env: Env,
): Promise<{ session: Session; request: Request; url: URL }> {
  const [, token, apiPath] = url.pathname.match(LAB_GPT) ?? []
  if (!token) throw new HttpError(404, "not found")
  const session = await labSession(request, url, env, token)
  const apiUrl = new URL(apiPath + url.search, url.origin)
  const headers = new Headers(request.headers)
  headers.delete("origin")
  headers.delete("authorization")
  const forwarded = new Request(apiUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    signal: request.signal,
  })
  return { session, request: forwarded, url: apiUrl }
}
