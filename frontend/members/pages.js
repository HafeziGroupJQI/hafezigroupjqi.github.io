// The three static sign-in pages on hafezigroupjqi.github.io (/auth/login, /auth/callback,
// /auth/logout) import this module as /static/members-auth.js. GitHub sends members back to
// /auth/callback on the github.io site; the Worker is only ever called with fetch().

import { forgetAccount } from "../page-export/drive.js"
import { clearCache } from "../theme/cache.js"
import { primeTheme } from "../theme/sign-in.js"
import { API_ORIGIN, FLAG_KEY, clearAuth, readAuth, safeNext, writeAuth } from "./auth.js"

const NONCE_KEY = "hafezi.loginNonce"

const status = (text) => {
  const node = document.querySelector("[data-status]")
  if (node) node.textContent = text
}

async function post(path, body) {
  const response = await fetch(API_ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.detail || `sign-in failed (${response.status})`)
  return data
}

async function registerWorker() {
  if (!("serviceWorker" in navigator))
    throw new Error("This browser cannot show member pages (service workers are unavailable).")
  await navigator.serviceWorker.register("/sw.js", { scope: "/" })
  const ready = await navigator.serviceWorker.ready
  ready.active?.postMessage("signed-in")
}

async function finish({ token, exp, user, next }) {
  await writeAuth({ token, exp, user })
  try {
    localStorage.setItem(FLAG_KEY, String(exp * 1000))
  } catch {
    /* the service worker still has the token */
  }
  status(`Signed in as ${user.login}. Loading…`)
  // The member's own theme, so the first page is already in it (at most a few seconds' wait).
  await Promise.race([
    primeTheme(API_ORIGIN, token).catch(() => {}),
    new Promise((done) => setTimeout(done, 3000)),
  ])
  await registerWorker()
  location.replace(safeNext(next))
}

export async function login() {
  try {
    const next = safeNext(new URLSearchParams(location.search).get("next"))
    status("Redirecting to GitHub…")
    const started = await post("/api/auth/start", { next })
    if (started.dev) return await finish(await post("/api/auth/exchange", started))
    sessionStorage.setItem(NONCE_KEY, started.nonce)
    location.replace(started.authorize_url)
  } catch (error) {
    status(error.message)
  }
}

export async function callback() {
  try {
    const query = new URLSearchParams(location.search)
    if (query.get("error")) throw new Error(query.get("error_description") || query.get("error"))
    const nonce = sessionStorage.getItem(NONCE_KEY) ?? ""
    sessionStorage.removeItem(NONCE_KEY)
    status("Checking your lab membership…")
    await finish(
      await post("/api/auth/exchange", {
        code: query.get("code"),
        state: query.get("state"),
        nonce,
      }),
    )
  } catch (error) {
    status(error.message)
  }
}

export async function logout() {
  // Best effort, before the token is forgotten: the Worker ends the session on every device (its
  // bearers and lab tickets stop working, open labs close) and records the sign-out.
  const auth = await readAuth().catch(() => null)
  if (auth)
    await fetch(API_ORIGIN + "/api/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}` },
    }).catch(() => {})
  await clearAuth()
  try {
    localStorage.removeItem(FLAG_KEY)
    sessionStorage.clear()
    // The member's own theme: the next person at this browser sees the site's look.
    clearCache(localStorage)
  } catch {
    /* ignore */
  }
  // The Google account saves to Drive were made with (page-export/drive.js).
  forgetAccount()
  const registration = await navigator.serviceWorker?.getRegistration?.("/")
  registration?.active?.postMessage("signed-out")
  for (const name of (await caches?.keys?.()) ?? [])
    if (name.startsWith("hafezi-")) await caches.delete(name)
  location.replace("/")
}
