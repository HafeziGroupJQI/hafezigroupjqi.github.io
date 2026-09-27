// Hafezi GPT's calls. JSON goes through the members service worker like every other /api call
// (`api` from member-tools.js); the reply stream is fetched straight from the Worker with the
// member's bearer token, because the service worker cannot hold a long-lived stream.
import { createSseParser } from "../members/sse-parse.js"

const enc = encodeURIComponent

export function gptApi(api) {
  const send = (path, method, body) =>
    api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return {
    bootstrap: () => api("/api/gpt/bootstrap"),
    pages: (q) => api(`/api/gpt/pages?q=${enc(q)}`),
    projects: () => api("/api/gpt/projects"),
    project: (id) => api(`/api/gpt/projects/${enc(id)}`),
    saveProject: (id, body) =>
      id
        ? send(`/api/gpt/projects/${enc(id)}`, "PUT", body)
        : send("/api/gpt/projects", "POST", body),
    deleteProject: (id) => send(`/api/gpt/projects/${enc(id)}`, "DELETE"),
    conversations: (params = {}) =>
      api(
        `/api/gpt/conversations?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""))}`,
      ),
    conversation: (id) => api(`/api/gpt/conversations/${enc(id)}`),
    createConversation: (body) => send("/api/gpt/conversations", "POST", body),
    updateConversation: (id, body) => send(`/api/gpt/conversations/${enc(id)}`, "PATCH", body),
    deleteConversation: (id) => send(`/api/gpt/conversations/${enc(id)}`, "DELETE"),
    share: (id, grantee) => send(`/api/gpt/conversations/${enc(id)}/shares`, "POST", { grantee }),
    unshare: (id, grantee) =>
      send(`/api/gpt/conversations/${enc(id)}/shares/${enc(grantee)}`, "DELETE"),
    fork: (id) => send(`/api/gpt/conversations/${enc(id)}/fork`, "POST"),
    skills: () => api("/api/gpt/skills"),
    saveSkill: (id, body) =>
      id ? send(`/api/gpt/skills/${enc(id)}`, "PUT", body) : send("/api/gpt/skills", "POST", body),
    deleteSkill: (id) => send(`/api/gpt/skills/${enc(id)}`, "DELETE"),
    deleteFile: (id) => send(`/api/gpt/files/${enc(id)}`, "DELETE"),
    fileUrl: (id) => `/api/gpt/files/${enc(id)}`,
    /** Multipart upload to a chat (`conversations/<id>/files`) or project (`projects/<id>/files`). */
    async upload(path, file) {
      const form = new FormData()
      form.append("file", file)
      const response = await fetch(`/api/gpt/${path}`, {
        method: "POST",
        body: form,
        cache: "no-store",
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok)
        throw new Error(
          typeof data.detail === "string" ? data.detail : `Upload failed (${response.status})`,
        )
      return data
    },
  }
}

export class LoggedOut extends Error {}

async function defaultConnect(path, body, signal) {
  const { API_ORIGIN, readAuth } = await import("../members/auth.js")
  const auth = await readAuth()
  if (!auth) return new Response(null, { status: 401 })
  return fetch(API_ORIGIN + path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal,
  })
}

/** Send one message and call onEvent(name, data) for each streamed event until the turn ends. */
export async function streamTurn(
  conversationId,
  body,
  { onEvent, signal, connect = defaultConnect },
) {
  const response = await connect(
    `/api/gpt/conversations/${enc(conversationId)}/messages`,
    body,
    signal,
  )
  if (response.status === 401) throw new LoggedOut("Your session expired. Sign in again.")
  if (!response.ok || !response.headers.get("content-type")?.includes("event-stream")) {
    const data = await response.json().catch(() => ({}))
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : `Hafezi GPT could not answer (${response.status}).`,
    )
  }
  const parser = createSseParser((name, data) => {
    let parsed = null
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    onEvent(name, parsed)
  })
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    parser.feed(value)
  }
}
