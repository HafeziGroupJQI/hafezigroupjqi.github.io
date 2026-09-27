import { DurableObject } from "cloudflare:workers"
import type { Env } from "../env"
import {
  Flag,
  type Frame,
  FrameType,
  INITIAL_WINDOW,
  MAX_PAYLOAD,
  PROTOCOL_VERSION,
  closePayload,
  decodeFrame,
  encodeFrame,
  jsonFrame,
  readClose,
  readJsonPayload,
  readWindow,
  windowPayload,
} from "./frames"

// ComputeRelay: the one Durable Object (idFromName(RELAY_NAME)) between the site and the compute
// host. The host (compute/hafezi_compute/tunnel) dials out and holds a single WebSocket here; every
// member HTTP request, JupyterLab WebSocket and control RPC is multiplexed over it as binary frames
// (frames.ts). Nothing is stored on Cloudflare except a stream-id counter and the Wolfram run-rate
// window.
//
// Hibernation: the host socket (tag "host") and every browser WebSocket (tags "b", "<sid>", with a
// {sid, login} attachment) are hibernatable. An open HTTP response or a pending RPC keeps the DO in
// memory, so only WebSocket streams ever need rebuilding, which wsStream() does from the sockets.
//
// Flow control: each direction starts with INITIAL_WINDOW bytes of credit per stream. The relay
// returns credit for response bytes only after the member's side has taken them (writer.write
// resolves), and sends request-body and WebSocket bytes only while it holds the host's credit.

export const RELAY_NAME = "hafezi-compute"

export const HTTP_PER_LOGIN = 32
export const WS_PER_LOGIN = 16
export const MAX_BODY = 95 * 1024 * 1024
const DEFAULT_MAX_STREAMS = 64
const HEAD_TIMEOUT_MS = 120_000
const ACCEPT_TIMEOUT_MS = 10_000
const REASSEMBLY_CAP = 16 * 1024 * 1024
/** Browser → host WebSocket bytes the relay will hold while it waits for host credit. */
const WS_QUEUE_CAP = 32 * 1024 * 1024
const WOLFRAM_WINDOW_MS = 10 * 60 * 1000
const WOLFRAM_PER_WINDOW = 30

/** What routes.ts hands the relay for one proxied request or WebSocket (x-relay-meta). */
export interface OpenMeta {
  method: string
  target: string
  headers: [string, string][]
  assertion: string
  ws_url: string
  ticket: string
  login: string
  has_body?: boolean
  protocols?: string[]
}

export interface ControlRequest {
  op: string
  args: unknown
  assertion: string
  login: string
  /** Answer as NDJSON: progress lines, then the final {done: true, ...} line. */
  stream?: boolean
  timeout_ms?: number
  /** Apply the Wolfram run limits (1 concurrent + 30 per 10 min per login). */
  limit?: "wolfram"
  /** Merged into a successful streamed final line (the ws ticket for POST /api/compute/server). */
  extra?: Record<string, unknown>
}

interface ControlResult {
  rpc_id: number
  ok?: boolean
  result?: unknown
  error?: unknown
  progress?: unknown
  done?: boolean
}

interface HostAttachment {
  connected_at: number
  hello?: { proto?: number; host_id?: string; version?: string; max_streams?: number }
}

interface BrowserAttachment {
  sid: number
  login: string
}

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
}

interface HttpStream {
  kind: "http"
  sid: number
  login: string
  sendCredit: number
  waiters: Waiter[]
  /** Resolves the member's Response once RESPONSE_HEAD (or an error) arrives. */
  head: ((response: Response) => void) | null
  writer: WritableStreamDefaultWriter<Uint8Array> | null
  timer?: ReturnType<typeof setTimeout>
}

interface WsStream {
  kind: "ws"
  sid: number
  login: string
  sendCredit: number
  socket: WebSocket | null
  accept: ((protocol: string | null | Error) => void) | null
  /** Browser → host message pieces waiting for credit. */
  queue: { bytes: Uint8Array; binary: boolean; offset: number }[]
  queued: number
  /** Host → browser fragments of the message being reassembled. */
  partial: Uint8Array[]
  partialBytes: number
  /** Host messages that arrived between WS_ACCEPT and the socket being created. */
  early: { data: string | Uint8Array }[]
}

type Stream = HttpStream | WsStream

const decoder = new TextDecoder()
const encoder = new TextEncoder()

const problem = (status: number, detail: string, headers: Record<string, string> = {}) =>
  Response.json({ detail }, { status, headers })

// routes.ts sends the metadata URI-encoded: a header value must stay ASCII.
const readMeta = (request: Request) =>
  JSON.parse(decodeURIComponent(request.headers.get("x-relay-meta") ?? "%7B%7D")) as OpenMeta

const offline = () => problem(503, "compute host offline")

// Close codes a WebSocket may be closed with from script.
const sendableClose = (code: number) =>
  code === 1000 ||
  (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
  (code >= 3000 && code <= 4999)

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

export class ComputeRelay extends DurableObject<Env> {
  private hostSocket: WebSocket | null = null
  private readonly streams = new Map<number, Stream>()
  private readonly rpcs = new Map<
    number,
    { progress: (value: unknown) => void; done: (result: ControlResult) => void }
  >()
  private nextRpc = 1
  private readonly wolframActive = new Set<string>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // The host pings every 20 s; answer without waking the DO. (This applies to every socket here,
    // but a Jupyter kernel/terminal message is never the bare text "ping".)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    switch (url.pathname) {
      case "/host":
        return this.acceptHost(request)
      case "/status":
        return Response.json(this.status())
      case "/http":
        return this.openHttp(request)
      case "/ws":
        return this.openWs(request)
      case "/control":
        return this.control((await request.json()) as ControlRequest)
      default:
        return new Response("not found", { status: 404 })
    }
  }

  // ---- the host socket ----

  /** The current host: the newest socket tagged "host" (in memory, or rebuilt after hibernation). */
  private host(): WebSocket | null {
    if (this.hostSocket) return this.hostSocket
    let newest: WebSocket | null = null
    let at = -1
    for (const ws of this.ctx.getWebSockets("host")) {
      const attachment = ws.deserializeAttachment() as HostAttachment | null
      if (attachment && attachment.connected_at > at) {
        newest = ws
        at = attachment.connected_at
      }
    }
    this.hostSocket = newest
    return newest
  }

  private hello(): HostAttachment["hello"] {
    return (this.host()?.deserializeAttachment() as HostAttachment | null)?.hello
  }

  private status() {
    const host = this.host()
    const hello = this.hello()
    return {
      online: host != null,
      host_id: hello?.host_id ?? null,
      version: hello?.version ?? null,
      streams: this.liveStreamCount(),
    }
  }

  private send(frame: Uint8Array): void {
    const host = this.host()
    if (!host) throw new Error("compute host offline")
    host.send(frame)
  }

  private trySend(frame: Uint8Array): void {
    try {
      this.send(frame)
    } catch {
      // The host is gone; every stream fails through dropHost().
    }
  }

  private acceptHost(request: Request): Response {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 })
    const previous = this.host()
    // Collected before the new socket is accepted (getWebSockets hands out fresh wrappers, so
    // identity comparisons against `server` would not hold).
    const stale = this.ctx.getWebSockets("host")
    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, ["host"])
    const attachment: HostAttachment = { connected_at: Date.now() }
    server.serializeAttachment(attachment)
    // A new host replaces the old one: its streams are reset (they would never complete) and it is
    // told to go away before the new socket takes over.
    if (previous) {
      for (const sid of this.allStreamIds())
        try {
          previous.send(
            jsonFrame(FrameType.RESET, sid, { code: "host_replaced", reason: "replaced" }),
          )
        } catch {}
      try {
        previous.send(jsonFrame(FrameType.GOAWAY, 0, { reason: "replaced" }))
        previous.close(1012, "replaced by a new host connection")
      } catch {}
      this.failAll("compute host reconnected")
    }
    for (const ws of stale)
      if (ws !== previous)
        try {
          ws.close(1012, "replaced by a new host connection")
        } catch {}
    this.hostSocket = server
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Fail every stream and RPC: the host went away or was replaced. */
  private failAll(reason: string): void {
    for (const stream of [...this.streams.values()]) this.failStream(stream, reason, 1012)
    for (const ws of this.ctx.getWebSockets("b"))
      try {
        ws.close(1012, reason)
      } catch {}
    this.streams.clear()
    for (const [id, rpc] of this.rpcs) {
      rpc.done({ rpc_id: id, ok: false, error: reason, done: true })
      this.rpcs.delete(id)
    }
  }

  private isCurrentHost(ws: WebSocket): boolean {
    const host = this.host()
    if (!host) return false
    if (host === ws) return true
    const at = (socket: WebSocket) =>
      (socket.deserializeAttachment() as HostAttachment | null)?.connected_at
    return at(host) === at(ws)
  }

  private dropHost(ws: WebSocket): void {
    if (!this.isCurrentHost(ws)) return
    this.hostSocket = null
    this.failAll("compute host disconnected")
  }

  // ---- stream bookkeeping ----

  private allStreamIds(): number[] {
    const ids = new Set(this.streams.keys())
    for (const ws of this.ctx.getWebSockets("b")) {
      const attachment = ws.deserializeAttachment() as BrowserAttachment | null
      if (attachment) ids.add(attachment.sid)
    }
    return [...ids]
  }

  private liveStreamCount(): number {
    return this.allStreamIds().length
  }

  /** Odd ids from 1, persisted so a hibernated relay never reuses one the host may still hold. */
  private allocateSid(): number {
    let sid = this.ctx.storage.kv.get<number>("next_sid") ?? 1
    if (sid > 0x7fff_fff0) sid = 1
    while (this.streams.has(sid) || this.ctx.getWebSockets(String(sid)).length) sid += 2
    this.ctx.storage.kv.put("next_sid", sid + 2)
    return sid
  }

  private countFor(login: string, kind: "http" | "ws"): number {
    let count = 0
    for (const stream of this.streams.values())
      if (
        stream.login === login &&
        (stream.kind === "http" ? kind === "http" : kind === "ws" && !stream.socket)
      )
        count++
    if (kind === "ws")
      for (const ws of this.ctx.getWebSockets("b"))
        if ((ws.deserializeAttachment() as BrowserAttachment | null)?.login === login) count++
    return count
  }

  private admit(login: string, kind: "http" | "ws"): Response | null {
    if (!this.host()) return offline()
    const max = this.hello()?.max_streams ?? DEFAULT_MAX_STREAMS
    if (this.liveStreamCount() >= max)
      return problem(503, "compute host busy", { "retry-after": "2" })
    const cap = kind === "http" ? HTTP_PER_LOGIN : WS_PER_LOGIN
    if (this.countFor(login, kind) >= cap)
      return problem(429, `too many open ${kind === "http" ? "requests" : "connections"}`, {
        "retry-after": "2",
      })
    return null
  }

  /** The WebSocket stream for `sid`, rebuilt from its hibernated socket when needed. */
  private wsStream(sid: number): WsStream | null {
    const existing = this.streams.get(sid)
    if (existing) return existing.kind === "ws" ? existing : null
    const socket = this.ctx.getWebSockets(String(sid))[0]
    if (!socket) return null
    const attachment = socket.deserializeAttachment() as BrowserAttachment | null
    if (!attachment) return null
    // Credit is not persisted; a hibernated stream was idle, so the host had consumed everything.
    const stream = this.newWsStream(sid, attachment.login)
    stream.socket = socket
    this.streams.set(sid, stream)
    return stream
  }

  private newWsStream(sid: number, login: string): WsStream {
    return {
      kind: "ws",
      sid,
      login,
      sendCredit: INITIAL_WINDOW,
      socket: null,
      accept: null,
      queue: [],
      queued: 0,
      partial: [],
      partialBytes: 0,
      early: [],
    }
  }

  private failStream(stream: Stream, reason: string, code = 1011): void {
    this.streams.delete(stream.sid)
    if (stream.kind === "http") {
      clearTimeout(stream.timer)
      for (const waiter of stream.waiters.splice(0)) waiter.reject(new Error(reason))
      if (stream.head) {
        stream.head(problem(502, reason))
        stream.head = null
      }
      stream.writer?.abort(new Error(reason)).catch(() => {})
    } else {
      stream.accept?.(new Error(reason))
      stream.accept = null
      try {
        stream.socket?.close(code, reason)
      } catch {}
    }
  }

  // ---- HTTP streams ----

  private async openHttp(request: Request): Promise<Response> {
    const meta = readMeta(request)
    const refused = this.admit(meta.login, "http")
    if (refused) return refused
    const sid = this.allocateSid()
    const hasBody = !!meta.has_body && request.body != null
    const stream: HttpStream = {
      kind: "http",
      sid,
      login: meta.login,
      sendCredit: INITIAL_WINDOW,
      waiters: [],
      head: null,
      writer: null,
    }
    const head = new Promise<Response>((resolve) => (stream.head = resolve))
    this.streams.set(sid, stream)
    const settle = (response: Response) => {
      if (stream.head) {
        stream.head(response)
        stream.head = null
      }
    }
    stream.timer = setTimeout(() => {
      this.trySend(jsonFrame(FrameType.RESET, sid, { code: "timeout", reason: "no response" }))
      settle(problem(504, "compute host did not answer in time"))
      this.failStream(stream, "compute host did not answer in time")
    }, HEAD_TIMEOUT_MS)

    try {
      this.send(
        jsonFrame(FrameType.OPEN_HTTP, sid, {
          method: meta.method,
          target: meta.target,
          headers: meta.headers,
          assertion: meta.assertion,
          has_body: hasBody,
          window: INITIAL_WINDOW,
          ws_url: meta.ws_url,
          ticket: meta.ticket,
        }),
      )
    } catch {
      this.streams.delete(sid)
      clearTimeout(stream.timer)
      return offline()
    }
    if (hasBody)
      this.pumpBody(stream, request.body!).catch((error: Error) => {
        if (!this.streams.has(sid)) return
        const tooLarge = error.message === "too large"
        this.trySend(
          jsonFrame(FrameType.RESET, sid, {
            code: tooLarge ? "too_large" : "body_error",
            reason: error.message,
          }),
        )
        this.streams.delete(sid)
        clearTimeout(stream.timer)
        settle(tooLarge ? problem(413, "request body over 95 MiB") : problem(502, "upload failed"))
        stream.writer?.abort(error).catch(() => {})
      })
    return head
  }

  /**
   * Stream the member's request body to the host within the host's credit. The runtime hands the
   * body over in small (4 KiB) chunks; whatever is already available is coalesced into frames of up
   * to 256 KiB so a large upload is a few hundred frames, not tens of thousands.
   */
  private async pumpBody(stream: HttpStream, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    let total = 0
    let ended = false
    let pending = reader.read()
    while (!ended) {
      const first = await pending
      if (first.done) break
      const parts = [first.value]
      let size = first.value.byteLength
      pending = reader.read()
      while (size < MAX_PAYLOAD) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const next = await Promise.race([
          pending,
          new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 0))),
        ])
        clearTimeout(timer)
        if (next === null) break // nothing more right now; send what we have
        if (next.done) {
          ended = true
          break
        }
        parts.push(next.value)
        size += next.value.byteLength
        pending = reader.read()
      }
      total += size
      if (total > MAX_BODY) {
        pending.catch(() => {})
        reader.cancel().catch(() => {})
        throw new Error("too large")
      }
      const chunk = concat(parts, size)
      let offset = 0
      while (offset < chunk.byteLength) {
        while (stream.sendCredit <= 0)
          await new Promise<void>((resolve, reject) => stream.waiters.push({ resolve, reject }))
        if (!this.streams.has(stream.sid)) return
        const n = Math.min(stream.sendCredit, MAX_PAYLOAD, chunk.byteLength - offset)
        this.send(encodeFrame(FrameType.DATA, stream.sid, chunk.subarray(offset, offset + n)))
        stream.sendCredit -= n
        offset += n
      }
    }
    if (this.streams.has(stream.sid))
      this.send(encodeFrame(FrameType.DATA, stream.sid, undefined, Flag.EOS))
  }

  private onResponseHead(stream: HttpStream, frame: Frame): void {
    if (!stream.head) return
    clearTimeout(stream.timer)
    const head = readJsonPayload<{ status: number; headers: [string, string][] }>(frame)
    const headers = new Headers()
    for (const [name, value] of head.headers ?? [])
      try {
        headers.append(name, value)
      } catch {}
    const status = head.status >= 200 && head.status <= 599 ? head.status : 502
    const nullBody = [204, 205, 304].includes(status)
    if (nullBody) {
      // Any DATA still arrives (until EOS) and is acknowledged but discarded.
      stream.head(new Response(null, { status, headers }))
      stream.head = null
      stream.writer = new WritableStream<Uint8Array>().getWriter()
      return
    }
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    stream.writer = writer
    // The member stopped reading (navigated away, aborted the fetch): tell the host.
    writer.closed.catch(() => {
      if (!this.streams.has(stream.sid)) return
      this.streams.delete(stream.sid)
      this.trySend(
        jsonFrame(FrameType.RESET, stream.sid, { code: "cancel", reason: "client gone" }),
      )
    })
    stream.head(new Response(readable, { status, headers }))
    stream.head = null
  }

  private onHttpData(stream: HttpStream, frame: Frame): void {
    const writer = stream.writer
    if (!writer) {
      this.trySend(
        jsonFrame(FrameType.RESET, stream.sid, { code: "protocol", reason: "DATA before head" }),
      )
      this.failStream(stream, "compute host protocol error")
      return
    }
    const bytes = frame.payload.slice()
    const eos = (frame.flags & Flag.EOS) !== 0
    if (bytes.byteLength)
      writer.write(bytes).then(
        () => {
          // Credit goes back only once the member's side has taken the bytes.
          if (this.streams.get(stream.sid) === stream)
            this.trySend(encodeFrame(FrameType.WINDOW, stream.sid, windowPayload(bytes.byteLength)))
        },
        () => {},
      )
    if (eos) {
      this.streams.delete(stream.sid)
      writer.close().catch(() => {})
    }
  }

  // ---- WebSocket streams ----

  private async openWs(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 })
    const meta = readMeta(request)
    const refused = this.admit(meta.login, "ws")
    if (refused) return refused
    const sid = this.allocateSid()
    const stream = this.newWsStream(sid, meta.login)
    this.streams.set(sid, stream)
    const accepted = new Promise<string | null | Error>((resolve) => (stream.accept = resolve))
    try {
      this.send(
        jsonFrame(FrameType.OPEN_WS, sid, {
          method: "GET",
          target: meta.target,
          headers: meta.headers,
          assertion: meta.assertion,
          window: INITIAL_WINDOW,
          ws_url: meta.ws_url,
          ticket: meta.ticket,
          protocols: meta.protocols ?? [],
        }),
      )
    } catch {
      this.streams.delete(sid)
      return offline()
    }
    const timer = setTimeout(() => stream.accept?.(new Error("timeout")), ACCEPT_TIMEOUT_MS)
    const protocol = await accepted
    clearTimeout(timer)
    stream.accept = null
    if (protocol instanceof Error) {
      this.streams.delete(sid)
      if (protocol.message === "timeout") {
        this.trySend(jsonFrame(FrameType.RESET, sid, { code: "timeout", reason: "no accept" }))
        return problem(504, "compute host did not accept the connection")
      }
      return problem(502, protocol.message)
    }

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    this.ctx.acceptWebSocket(server, ["b", String(sid)])
    const attachment: BrowserAttachment = { sid, login: meta.login }
    server.serializeAttachment(attachment)
    stream.socket = server
    for (const message of stream.early.splice(0)) server.send(message.data)
    const headers: Record<string, string> = {}
    if (protocol) headers["sec-websocket-protocol"] = protocol
    return new Response(null, { status: 101, webSocket: client, headers })
  }

  /** Queue a browser message for the host and send what the host's credit allows. */
  private fromBrowser(stream: WsStream, message: string | ArrayBuffer): void {
    const binary = typeof message !== "string"
    const bytes = binary ? new Uint8Array(message) : encoder.encode(message)
    stream.queue.push({ bytes, binary, offset: 0 })
    stream.queued += bytes.byteLength
    if (stream.queued > WS_QUEUE_CAP) {
      this.trySend(encodeFrame(FrameType.WS_CLOSE, stream.sid, closePayload(1009, "backpressure")))
      this.failStream(stream, "message backlog too large", 1009)
      return
    }
    this.flushWs(stream)
  }

  private flushWs(stream: WsStream): void {
    while (stream.queue.length) {
      const item = stream.queue[0]
      const remaining = item.bytes.byteLength - item.offset
      if (remaining > 0 && stream.sendCredit <= 0) return
      const n = Math.min(stream.sendCredit, MAX_PAYLOAD, remaining)
      const last = n === remaining
      const flags = (item.binary ? Flag.BIN : 0) | (last ? Flag.FIN : 0)
      this.send(
        encodeFrame(
          FrameType.WS_MSG,
          stream.sid,
          item.bytes.subarray(item.offset, item.offset + n),
          flags,
        ),
      )
      stream.sendCredit -= n
      stream.queued -= n
      item.offset += n
      if (last) stream.queue.shift()
    }
  }

  /** A host fragment: acknowledge it, reassemble, and deliver whole messages to the browser. */
  private toBrowser(stream: WsStream, frame: Frame): void {
    const bytes = frame.payload.slice()
    if (bytes.byteLength)
      this.trySend(encodeFrame(FrameType.WINDOW, stream.sid, windowPayload(bytes.byteLength)))
    stream.partial.push(bytes)
    stream.partialBytes += bytes.byteLength
    if (stream.partialBytes > REASSEMBLY_CAP) {
      this.trySend(
        encodeFrame(FrameType.WS_CLOSE, stream.sid, closePayload(1009, "message too big")),
      )
      this.failStream(stream, "message too big", 1009)
      return
    }
    if (!(frame.flags & Flag.FIN)) return
    const whole = concat(stream.partial, stream.partialBytes)
    stream.partial = []
    stream.partialBytes = 0
    const data = frame.flags & Flag.BIN ? whole : decoder.decode(whole)
    if (stream.socket) stream.socket.send(data)
    else stream.early.push({ data })
  }

  // ---- control RPCs ----

  private async control(body: ControlRequest): Promise<Response> {
    if (!this.host()) return offline()
    const login = body.login
    if (body.limit === "wolfram") {
      if (this.wolframActive.has(login)) return problem(429, "a Wolfram run is already in progress")
      const now = Date.now()
      const recent = (this.ctx.storage.kv.get<number[]>(`wolfram:${login}`) ?? []).filter(
        (at) => now - at < WOLFRAM_WINDOW_MS,
      )
      if (recent.length >= WOLFRAM_PER_WINDOW) {
        const retry = Math.ceil((recent[0] + WOLFRAM_WINDOW_MS - now) / 1000)
        return problem(429, "Wolfram run limit reached (30 per 10 minutes)", {
          "retry-after": String(retry),
        })
      }
      recent.push(now)
      this.ctx.storage.kv.put(`wolfram:${login}`, recent)
      this.wolframActive.add(login)
    }
    const release = () => {
      if (body.limit === "wolfram") this.wolframActive.delete(login)
    }

    const rpcId = this.nextRpc++
    const timeout = body.timeout_ms ?? 60_000
    if (!body.stream) {
      const result = await new Promise<ControlResult>((resolve) => {
        const timer = setTimeout(() => {
          this.rpcs.delete(rpcId)
          resolve({
            rpc_id: rpcId,
            ok: false,
            error: "compute host did not answer in time",
            done: true,
          })
        }, timeout)
        this.rpcs.set(rpcId, {
          progress: () => {},
          done: (final) => {
            clearTimeout(timer)
            resolve(final)
          },
        })
        this.sendControl(rpcId, body)
      })
      release()
      if (result.ok) return Response.json(result.result ?? {})
      return problem(502, typeof result.error === "string" ? result.error : "compute host error")
    }

    // NDJSON: {"progress": ...} lines while the host works, then the final {"done": true, ...}.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    const writer = writable.getWriter()
    const line = (value: unknown) =>
      writer.write(encoder.encode(JSON.stringify(value) + "\n")).catch(() => {})
    const timer = setTimeout(() => {
      this.rpcs.get(rpcId)?.done({
        rpc_id: rpcId,
        ok: false,
        error: "compute host did not answer in time",
        done: true,
      })
    }, timeout)
    this.rpcs.set(rpcId, {
      progress: (progress) => void line({ progress }),
      done: (final) => {
        clearTimeout(timer)
        this.rpcs.delete(rpcId)
        release()
        const extra = final.ok ? (body.extra ?? {}) : {}
        void line({
          done: true,
          ok: !!final.ok,
          result: final.result,
          error: final.error,
          ...extra,
        }).then(() => writer.close().catch(() => {}))
      },
    })
    this.sendControl(rpcId, body)
    return new Response(readable, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    })
  }

  private sendControl(rpcId: number, body: ControlRequest): void {
    try {
      this.send(
        jsonFrame(FrameType.CONTROL, 0, {
          rpc_id: rpcId,
          op: body.op,
          assertion: body.assertion,
          args: body.args ?? {},
        }),
      )
    } catch {
      this.rpcs
        .get(rpcId)
        ?.done({ rpc_id: rpcId, ok: false, error: "compute host offline", done: true })
      this.rpcs.delete(rpcId)
    }
  }

  private onControlResult(frame: Frame): void {
    const result = readJsonPayload<ControlResult>(frame)
    const rpc = this.rpcs.get(result.rpc_id)
    if (!rpc) return
    if (result.progress !== undefined && !result.done) rpc.progress(result.progress)
    if (result.done) {
      this.rpcs.delete(result.rpc_id)
      rpc.done(result)
    }
  }

  // ---- hibernation WebSocket handlers ----

  async webSocketMessage(ws: WebSocket, received: string | ArrayBuffer): Promise<void> {
    let tags: string[]
    try {
      tags = this.ctx.getTags(ws)
    } catch {
      return // a socket this relay already let go of (a replaced host)
    }
    // Newer runtimes may hand binary messages over as Blobs.
    const message: string | ArrayBuffer =
      typeof received === "string" || received instanceof ArrayBuffer
        ? received
        : await (received as Blob).arrayBuffer()
    if (tags.includes("host")) {
      if (typeof message === "string") return // only "ping", answered by the auto-response
      if (!this.isCurrentHost(ws)) return
      this.fromHost(ws, message)
      return
    }
    const sid = Number(tags.find((tag) => tag !== "b"))
    const stream = this.wsStream(sid)
    if (!stream) {
      ws.close(1011, "stream gone")
      return
    }
    try {
      this.fromBrowser(stream, message)
    } catch {
      this.failStream(stream, "compute host offline", 1012)
    }
  }

  private fromHost(ws: WebSocket, message: ArrayBuffer): void {
    let frame: Frame
    try {
      frame = decodeFrame(message)
    } catch {
      return
    }
    switch (frame.type) {
      case FrameType.HELLO: {
        const hello = readJsonPayload<NonNullable<HostAttachment["hello"]>>(frame)
        if (hello.proto !== PROTOCOL_VERSION) {
          ws.send(jsonFrame(FrameType.GOAWAY, 0, { reason: `unsupported protocol ${hello.proto}` }))
          ws.close(1002, "unsupported protocol")
          this.dropHost(ws)
          return
        }
        const attachment = (ws.deserializeAttachment() as HostAttachment | null) ?? {
          connected_at: Date.now(),
        }
        ws.serializeAttachment({ ...attachment, hello })
        return
      }
      case FrameType.CONTROL_RESULT:
        this.onControlResult(frame)
        return
    }
    const stream = this.streams.get(frame.streamId) ?? this.wsStream(frame.streamId)
    if (!stream) return // a stream that already ended; late frames are dropped
    switch (frame.type) {
      case FrameType.WINDOW: {
        stream.sendCredit += readWindow(frame)
        if (stream.kind === "http") for (const waiter of stream.waiters.splice(0)) waiter.resolve()
        else this.flushWs(stream)
        return
      }
      case FrameType.RESET: {
        const reset = readJsonPayload<{ code?: string; reason?: string }>(frame)
        this.failStream(stream, reset.reason || "compute host reset the stream")
        return
      }
    }
    if (stream.kind === "http") {
      if (frame.type === FrameType.RESPONSE_HEAD) this.onResponseHead(stream, frame)
      else if (frame.type === FrameType.DATA) this.onHttpData(stream, frame)
      return
    }
    switch (frame.type) {
      case FrameType.WS_ACCEPT:
        stream.accept?.(readJsonPayload<{ protocol?: string | null }>(frame).protocol ?? null)
        stream.accept = null
        return
      case FrameType.WS_MSG:
        this.toBrowser(stream, frame)
        return
      case FrameType.WS_CLOSE: {
        const { code, reason } = readClose(frame)
        this.streams.delete(stream.sid)
        if (stream.accept) {
          stream.accept(new Error(reason || "compute host refused the connection"))
          stream.accept = null
        }
        try {
          stream.socket?.close(sendableClose(code) ? code : 1000, reason)
        } catch {}
        return
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    let tags: string[]
    try {
      tags = this.ctx.getTags(ws)
    } catch {
      return
    }
    if (tags.includes("host")) {
      this.dropHost(ws)
      return
    }
    const attachment = ws.deserializeAttachment() as BrowserAttachment | null
    if (attachment) {
      // The member closed the socket; the host drops a WS_CLOSE for a stream it already ended.
      this.streams.delete(attachment.sid)
      this.trySend(
        encodeFrame(
          FrameType.WS_CLOSE,
          attachment.sid,
          closePayload(sendableClose(code) ? code : 1000, reason),
        ),
      )
    }
    try {
      ws.close(sendableClose(code) ? code : 1000, reason)
    } catch {}
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error")
  }
}
