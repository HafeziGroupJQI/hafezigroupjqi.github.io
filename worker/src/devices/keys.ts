import { randomToken } from "../session"

const encoder = new TextEncoder()

/** A fresh device key or enrollment token: 32 random bytes, base64url. */
export const newSecret = () => randomToken()

/** SHA-256 hex of a secret; only the hash is ever stored. */
export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// Owner-chosen, human-readable, URL-safe: lowercase letters, digits, and single hyphens.
const CODE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export function normalizeCodeName(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("code_name must be a string")
  const trimmed = value.trim().toLowerCase()
  if (!CODE_NAME.test(trimmed))
    throw new TypeError("code_name must be 1-64 chars: lowercase letters, digits, single hyphens")
  return trimmed
}
