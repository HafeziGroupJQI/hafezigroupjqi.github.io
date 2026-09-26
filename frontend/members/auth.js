// The members session on hafezigroupjqi.github.io: a bearer token from the Worker, kept in
// IndexedDB so both the pages and the service worker (/sw.js) can read it. Pages also keep a
// plain "signed in until" timestamp in localStorage, which the head bootstrap can read without
// waiting on IndexedDB. Nothing here ever talks to the Worker as a page — only fetch().

/* global __MEMBERS_API__ */
export const API_ORIGIN =
  typeof __MEMBERS_API__ !== "undefined" ? __MEMBERS_API__ : "http://localhost:8787"

export const FLAG_KEY = "hafezi.signedInUntil"
const DB_NAME = "hafezi-members"
const STORE = "auth"
const KEY = "session"

/** A stored session is usable until its expiry (seconds since epoch), with a minute to spare. */
export const isLive = (auth, now = Date.now()) =>
  !!auth && typeof auth.token === "string" && typeof auth.exp === "number" && auth.exp * 1000 - 60_000 > now

function withStore(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(STORE, mode)
      const request = run(tx.objectStore(STORE))
      tx.oncomplete = () => {
        db.close()
        resolve(request?.result)
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

export async function readAuth() {
  try {
    const auth = await withStore("readonly", (store) => store.get(KEY))
    return isLive(auth) ? auth : null
  } catch {
    return null
  }
}

export const writeAuth = (auth) => withStore("readwrite", (store) => store.put(auth, KEY))
export const clearAuth = () => withStore("readwrite", (store) => store.delete(KEY)).catch(() => {})

/** Only same-site paths may be used as a post-login destination (mirrors the Worker's safeNext). */
export function safeNext(value, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback
  if (/^\/[^/]*:/.test(value) || /[\u0000-\u001f]/.test(value)) return fallback
  if (value.startsWith("/auth/")) return fallback
  return value
}
