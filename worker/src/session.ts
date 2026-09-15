import { cookies } from "./http"
import type { Env } from "./env"

export const SESSION_COOKIE = "hafezi_members_session"
export const SESSION_MAX_AGE = 8 * 60 * 60

export interface Session {
  login: string
  name: string
  role: "member" | "owner"
  csrf: string
  exp: number
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

const secureFlag = (url: URL) => (url.protocol === "https:" ? "; Secure" : "")

export const serializeCookie = (name: string, value: string, url: URL, maxAge: number) =>
  `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureFlag(url)}`

export const clearCookie = (name: string, url: URL) => serializeCookie(name, "", url, 0)

export async function readSession(request: Request, env: Env): Promise<Session | null> {
  const session = await verify<Session>(cookies(request).get(SESSION_COOKIE), env.SESSION_SECRET)
  if (!session || !session.login || !session.csrf) return null
  return session
}

export async function sessionCookie(
  user: { login: string; name: string; role: "member" | "owner" },
  url: URL,
  env: Env,
): Promise<string> {
  const session: Session = {
    ...user,
    csrf: randomToken(),
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  }
  return serializeCookie(
    SESSION_COOKIE,
    await sign(session, env.SESSION_SECRET),
    url,
    SESSION_MAX_AGE,
  )
}
