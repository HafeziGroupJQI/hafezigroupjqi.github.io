/**
 * Minimal, interoperable implementation of itsdangerous `URLSafeTimedSerializer.dumps`.
 *
 * C2 (`c2.auth.verify_assertion`) validates gateway assertions with Python's itsdangerous,
 * so the Worker must produce exactly that wire format. Keeping the format also means the
 * outgoing Python gateway and this Worker can both talk to the same C2 during the cutover,
 * which is what makes rolling back safe.
 *
 * Format: base64url(json) "." base64url(timestamp) "." base64url(hmac-sha1)
 * Key:    sha1(salt + "signer" + secret)   (itsdangerous "django-concat" derivation)
 *
 * SHA-1 is itsdangerous' default here. It is used only inside HMAC, for a token that is
 * valid for 30 seconds; HMAC-SHA1 remains sound for authentication.
 */

const encoder = new TextEncoder()

const base64url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Big-endian, minimal-width, as itsdangerous' `int_to_bytes` writes timestamps. */
const intToBytes = (value: number): Uint8Array => {
  const out: number[] = []
  let remaining = value
  while (remaining > 0) {
    out.unshift(remaining & 0xff)
    remaining = Math.floor(remaining / 256)
  }
  return new Uint8Array(out.length ? out : [0])
}

async function deriveKey(secret: string, salt: string): Promise<CryptoKey> {
  const material = new Uint8Array(await crypto.subtle.digest("SHA-1", encoder.encode(salt + "signer" + secret)))
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-1" }, false, ["sign"])
}

/** Sign `payload` the way `URLSafeTimedSerializer(secret, salt=salt).dumps(payload)` does. */
export async function dumps(payload: unknown, secret: string, salt: string, now?: number): Promise<string> {
  const body = base64url(encoder.encode(JSON.stringify(payload)))
  const stamp = base64url(intToBytes(now ?? Math.floor(Date.now() / 1000)))
  const value = `${body}.${stamp}`
  const mac = await crypto.subtle.sign("HMAC", await deriveKey(secret, salt), encoder.encode(value))
  return `${value}.${base64url(new Uint8Array(mac))}`
}
