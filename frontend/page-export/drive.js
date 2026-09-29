// "Save to Google Drive" (the Export menu, index.js), entirely in the browser with Google's own
// pieces and no server secret:
//   - Google Identity Services' token client (https://accounts.google.com/gsi/client,
//     google.accounts.oauth2.initTokenClient) asks the member, in Google's window, for the
//     drive.file scope: this site may create files in their Drive and see only those. The access
//     token lives in this page's memory for its hour, never stored; an expired one is asked for
//     again on the next click.
//   - A resumable upload to the Drive API v3, ported from Google's CORS upload sample
//     (https://github.com/googledrive/cors-upload-sample, upload.js, MediaUploader, Apache-2.0) to
//     fetch: the metadata opens a session, the file goes in one PUT, and a dropped PUT resumes from
//     what Drive has. Resumable rather than multipart, which Drive caps at 5 MB: a page with its
//     images inlined can be larger (Drive converts up to 50 MB to a Google Doc).
// Files land in My Drive's root; the status line links to them.

export const GIS_URL = "https://accounts.google.com/gsi/client"
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
export const GOOGLE_DOC = "application/vnd.google-apps.document"
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"
const FIELDS = "id,name,mimeType,webViewLink"

/** A failure to show as it is: "Export failed: " + its message. */
export class DriveError extends Error {}

// ---- pure helpers (node:test) ----

/** Whether a token ({value, expires} in ms) still has a minute left. */
export const tokenValid = (token, now = Date.now()) => !!token && token.expires - 60_000 > now

/** The token client's error_callback types: its window didn't open, or was closed. */
export function popupMessage(type) {
  if (type === "popup_failed_to_open")
    return "the Google sign-in window was blocked; allow pop-ups for this site and try again"
  if (type === "popup_closed") return "the Google sign-in window was closed before Drive access"
  return "Google sign-in did not finish"
}

/** An OAuth error in the token response: the member declined, or something else went wrong. */
export function consentMessage(error) {
  if (error === "access_denied") return "Google Drive access was declined"
  return `Google sign-in failed (${error})`
}

/** The upload session's request: [url, init] for fetch. */
export function uploadStart(token, { metadata, type, size }) {
  const url = `${UPLOAD_URL}?${new URLSearchParams({ uploadType: "resumable", fields: FIELDS })}`
  return [
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": type,
        "x-upload-content-length": String(size),
      },
      body: JSON.stringify(metadata),
    },
  ]
}

/** Where a resumed upload starts: after the last byte Drive has (a 308's Range, "bytes=0-N"). */
export function resumeOffset(range) {
  const last = range?.match(/-(\d+)$/)?.[1]
  return last === undefined ? 0 : Number(last) + 1
}

/** A Drive API error answer (status, and its JSON body if any) as a message. */
export function driveErrorMessage(status, body) {
  const error = body?.error ?? {}
  const reason = error.errors?.[0]?.reason ?? error.status ?? ""
  const detail = typeof error.message === "string" ? error.message : ""
  if (status === 401) return "your Google sign-in expired; choose the item again to sign in again"
  if (reason === "storageQuotaExceeded") return "your Google Drive is full"
  if (/rateLimitExceeded/i.test(reason) || status === 429)
    return "Google Drive is busy; try again in a minute"
  if (status === 413) return "the file is too large for Google Drive"
  if (status >= 500) return "Google Drive is unavailable right now; try again"
  return `Google Drive refused the file (${status}${detail ? `: ${detail}` : ""})`
}

/** A saved file's type in Drive, by its name. */
export function driveType(name) {
  const extension = name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase()
  return (
    {
      md: "text/markdown",
      qmd: "text/markdown",
      ipynb: "application/x-ipynb+json",
      nb: "application/vnd.wolfram.mathematica",
    }[extension] ?? "application/octet-stream"
  )
}

/** Colab opens a notebook in the member's Drive by its file id. */
export const colabUrl = (id) => `https://colab.research.google.com/drive/${encodeURIComponent(id)}`

// ---- the browser ----

const offline = () => new DriveError("you are offline")

let loading = null
/** Google Identity Services, loaded once, when the menu first opens (so a click opens its window). */
export function loadGis() {
  loading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve(window.google.accounts.oauth2)
    const script = document.createElement("script")
    script.src = GIS_URL
    script.async = true
    script.onload = () =>
      window.google?.accounts?.oauth2
        ? resolve(window.google.accounts.oauth2)
        : reject(new DriveError("Google sign-in did not load"))
    script.onerror = () => {
      script.remove()
      loading = null
      reject(
        navigator.onLine
          ? new DriveError("Google sign-in did not load (a network or an extension may block it)")
          : offline(),
      )
    }
    document.head.append(script)
  })
  return loading
}

let client = null
let pending = null
let token = null

function settle(response, error) {
  const waiting = pending
  pending = null
  if (!waiting) return
  if (error) return waiting.reject(new DriveError(popupMessage(error.type)))
  if (response.error) return waiting.reject(new DriveError(consentMessage(response.error)))
  if (!window.google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_SCOPE))
    return waiting.reject(new DriveError("Google Drive access was not granted"))
  token = {
    value: response.access_token,
    expires: Date.now() + Number(response.expires_in ?? 3599) * 1000,
  }
  waiting.resolve(token.value)
}

/**
 * An access token for drive.file: the one this page holds, else Google's window asks for one.
 * Call it first thing in a click: browsers let only a click open a window.
 */
export async function driveToken(clientId) {
  if (tokenValid(token)) return token.value
  if (!navigator.onLine) throw offline()
  const oauth2 = window.google?.accounts?.oauth2 ?? (await loadGis())
  client ??= oauth2.initTokenClient({
    client_id: clientId,
    scope: DRIVE_SCOPE,
    callback: (response) => settle(response),
    error_callback: (error) => settle(null, error),
  })
  pending?.reject(new DriveError("Google sign-in was asked for again"))
  return new Promise((resolve, reject) => {
    pending = { resolve, reject }
    client.requestAccessToken()
  })
}

async function failure(response) {
  if (response.status === 401) token = null
  const body = await response.json().catch(() => null)
  return new DriveError(driveErrorMessage(response.status, body))
}

/**
 * Upload {metadata (Drive's: name, mimeType…), type, body (a string or Blob)} with the token.
 * Returns the new file's {id, name, mimeType, webViewLink}.
 */
export async function uploadToDrive(accessToken, { metadata, type, body }) {
  const blob = body instanceof Blob ? body : new Blob([body], { type })
  const size = blob.size
  let started
  try {
    started = await fetch(...uploadStart(accessToken, { metadata, type, size }))
  } catch {
    throw navigator.onLine ? new DriveError("Google Drive did not answer") : offline()
  }
  if (!started.ok) throw await failure(started)
  const session = started.headers.get("location")
  if (!session) throw new DriveError("Google Drive did not open the upload")
  let offset = 0
  for (let attempt = 0; ; attempt++) {
    const range = size ? `bytes ${offset}-${size - 1}/${size}` : "bytes */0"
    const sent = await fetch(session, {
      method: "PUT",
      headers: { "content-type": type, "content-range": range },
      body: blob.slice(offset),
    }).catch(() => null)
    if (sent?.ok) return sent.json()
    if (sent && sent.status !== 308 && sent.status < 500) throw await failure(sent)
    if (attempt === 3)
      throw navigator.onLine ? new DriveError("the upload to Google Drive broke off") : offline()
    // A dropped connection or a 5xx: wait, then ask Drive how much it has and send the rest.
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt))
    const status = await fetch(session, {
      method: "PUT",
      headers: { "content-range": `bytes */${size}` },
    }).catch(() => null)
    if (status?.ok) return status.json()
    offset = status?.status === 308 ? resumeOffset(status.headers.get("range")) : 0
  }
}
