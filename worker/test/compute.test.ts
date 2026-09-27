import { SELF, env, runInDurableObject } from "cloudflare:test"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  Flag,
  type Frame,
  FrameType,
  INITIAL_WINDOW,
  MAX_PAYLOAD,
  closePayload,
  decodeFrame,
  encodeFrame,
  jsonFrame,
  readClose,
  readJsonPayload,
  readWindow,
  windowPayload,
} from "../src/compute/frames"
import { authorizeTarget } from "../src/compute/policy"
import { RELAY_NAME } from "../src/compute/relay"
import { FORCED_CSP, stripToken } from "../src/compute/routes"
import { issueAssertion, issueTicket, verifyAssertion, verifyTicket } from "../src/compute/tokens"
import type { Env } from "../src/env"
import { sign } from "../src/session"
import vectors from "./fixtures/compute-vectors.json"
import { ORIGIN, SITE, member } from "./helpers"

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => parseInt(pair, 16))
const workerEnv = env as unknown as Env
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe("compute frames and tokens (shared vectors)", () => {
  for (const vector of vectors.frames) {
    it(`decodes and encodes ${vector.name}`, () => {
      const wire = unhex(vector.wire_hex)
      const frame = decodeFrame(wire)
      expect(frame.type).toBe(vector.type)
      expect(frame.flags).toBe(vector.flags)
      expect(frame.streamId).toBe(vector.stream_id)
      if ("json" in vector) {
        expect(readJsonPayload(frame)).toEqual(vector.json)
        expect(hex(jsonFrame(vector.type, vector.stream_id, vector.json, vector.flags))).toBe(
          vector.wire_hex,
        )
      } else {
        expect(hex(frame.payload)).toBe(vector.bytes_hex)
        expect(hex(encodeFrame(vector.type, vector.stream_id, frame.payload, vector.flags))).toBe(
          vector.wire_hex,
        )
      }
    })
  }

  it("reads WINDOW and WS_CLOSE payloads", () => {
    const window = vectors.frames.find((v) => v.name === "window")!
    expect(readWindow(decodeFrame(unhex(window.wire_hex)))).toBe(262144)
    expect(hex(windowPayload(262144))).toBe("00000400")
    const close = vectors.frames.find((v) => v.name === "ws_close")!
    expect(readClose(decodeFrame(unhex(close.wire_hex)))).toEqual({ code: 1000, reason: "bye" })
    expect(hex(closePayload(1000, "bye"))).toBe("e803627965")
  })

  it("rejects short and oversize frames", () => {
    expect(() => decodeFrame(new Uint8Array(7))).toThrow()
    expect(() => decodeFrame(new Uint8Array(8 + MAX_PAYLOAD + 1))).toThrow()
    expect(() => encodeFrame(FrameType.DATA, 1, new Uint8Array(MAX_PAYLOAD + 1))).toThrow()
  })

  it("verifies the assertion vectors and signs byte-identical tokens", async () => {
    const { secret, tokens } = vectors
    expect(await verifyAssertion(tokens.valid.token, secret)).toEqual(tokens.valid.claims)
    expect(await sign(tokens.valid.claims, secret)).toBe(tokens.valid.token)
    for (const bad of [tokens.tampered, tokens.expired, tokens.wrong_typ, tokens.wrong_aud])
      expect(await verifyAssertion(bad, secret)).toBeNull()
  })

  it("issues 60 s assertions and session-bounded tickets", async () => {
    const assertion = await verifyAssertion(
      await issueAssertion(workerEnv, { login: "Alice", role: "member" }),
      vectors.secret,
    )
    expect(assertion).toMatchObject({ typ: "compute", aud: "hafezi-compute", login: "alice" })
    expect(assertion!.exp - assertion!.iat).toBe(60)
    const exp = Math.floor(Date.now() / 1000) + 120
    const ticket = await verifyTicket(
      workerEnv,
      await issueTicket(workerEnv, { login: "alice", role: "member", exp }),
    )
    expect(ticket).toMatchObject({ typ: "compute-ws", login: "alice", exp })
    // A ticket is not a session, and a session is not a ticket.
    expect(await verifyTicket(workerEnv, "garbage")).toBeNull()
  })
})

describe("compute path policy", () => {
  const alice = { login: "alice", role: "member" as const }
  const owner = { login: "dev", role: "owner" as const }
  const deny = (
    target: string,
    who: { login: string; role: "member" | "owner" } = alice,
    extra: Partial<Env> = {},
  ) => {
    try {
      authorizeTarget(target, who, { ...workerEnv, ...extra })
      return 200
    } catch (error) {
      return (error as { status: number }).status
    }
  }

  it("allows only the member's own server", () => {
    expect(authorizeTarget("/jupyter/user/alice/lab?reset", alice, workerEnv).target).toBe(
      "/jupyter/user/alice/lab?reset",
    )
    expect(deny("/jupyter/user/bob/lab")).toBe(403)
    expect(deny("/jupyter/hub/api/users")).toBe(403)
    expect(deny("/jupyter/hub/")).toBe(403)
    expect(deny("/jupyter/user/alice")).toBe(403)
    expect(deny("/elsewhere")).toBe(403)
  })

  it("refuses traversal and encoded separators", () => {
    expect(deny("/jupyter/user/alice/files%2f..%2fbob")).toBe(400)
    expect(deny("/jupyter/user/alice/files%5Cx")).toBe(400)
    expect(deny("/jupyter/user/alice/../bob/lab")).toBe(400)
    expect(deny("/jupyter/user/alice/%2e%2e/bob/lab")).toBe(400)
    expect(deny("/jupyter/user/alice/%zz")).toBe(400)
    expect(deny("//evil.example/x")).toBe(400)
    expect(deny("jupyter/user/alice/")).toBe(400)
  })

  it("lets an owner in only when COMPUTE_OWNER_ACCESS is on", () => {
    expect(deny("/jupyter/user/alice/lab", owner)).toBe(403)
    expect(deny("/jupyter/user/alice/lab", owner, { COMPUTE_OWNER_ACCESS: "true" })).toBe(200)
    expect(deny("/jupyter/user/alice/lab", alice, { COMPUTE_OWNER_ACCESS: "true" })).toBe(200)
    expect(deny("/jupyter/user/bob/lab", alice, { COMPUTE_OWNER_ACCESS: "true" })).toBe(403)
  })

  it("strips the ticket from a WebSocket query without re-encoding", () => {
    expect(stripToken("?session_id=a%20b&token=t.x&x=1")).toBe("?session_id=a%20b&x=1")
    expect(stripToken("?token=abc")).toBe("")
    expect(stripToken("")).toBe("")
  })
})

// ---- a fake compute host on the real relay ----

interface FakeHost {
  ws: WebSocket
  frames: Frame[]
  next(match: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame>
  send(frame: Uint8Array): void
  closed: Promise<void>
}

async function connectHost(): Promise<FakeHost> {
  const response = await SELF.fetch(`${ORIGIN}/api/compute/host`, {
    headers: { authorization: `Bearer ${vectors.host_key.key}`, upgrade: "websocket" },
  })
  expect(response.status).toBe(101)
  const ws = response.webSocket!
  ws.binaryType = "arraybuffer"
  ws.accept()
  const frames: Frame[] = []
  const waiting: { match: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = []
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") return
    const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer).slice())
    const index = waiting.findIndex((w) => w.match(frame))
    if (index >= 0) waiting.splice(index, 1)[0].resolve(frame)
    else frames.push(frame)
  })
  const closed = new Promise<void>((resolve) => ws.addEventListener("close", () => resolve()))
  const host: FakeHost = {
    ws,
    frames,
    closed,
    next(match, timeoutMs = 5000) {
      const index = frames.findIndex(match)
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0])
      return new Promise((resolve, reject) => {
        const entry = { match, resolve }
        waiting.push(entry)
        setTimeout(() => {
          const at = waiting.indexOf(entry)
          if (at >= 0) {
            waiting.splice(at, 1)
            reject(new Error("fake host: no matching frame"))
          }
        }, timeoutMs)
      })
    },
    send: (frame) => ws.send(frame),
  }
  host.send(
    jsonFrame(FrameType.HELLO, 0, { proto: 1, host_id: "test", version: "0.1.0", max_streams: 64 }),
  )
  await tick()
  return host
}

const ofType = (type: number, sid?: number) => (frame: Frame) =>
  frame.type === type && (sid === undefined || frame.streamId === sid)

/** A member client signed in as `login` (role member), minted directly with the session secret. */
async function memberAs(login: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = await sign(
    { typ: "session", login, name: login, role: "member", exp },
    workerEnv.SESSION_SECRET,
  )
  const headers = { authorization: `Bearer ${token}`, origin: SITE }
  return {
    token,
    fetch: (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
      SELF.fetch(ORIGIN + path, {
        redirect: "manual",
        ...init,
        headers: { ...headers, ...(init.headers ?? {}) },
      }),
  }
}

const envelope = (method: string, target: string, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "x-compute-method": method, "x-compute-target": target, ...extra },
})

async function respond(
  host: FakeHost,
  sid: number,
  status: number,
  headers: [string, string][],
  body = "",
) {
  host.send(jsonFrame(FrameType.RESPONSE_HEAD, sid, { status, headers }))
  host.send(encodeFrame(FrameType.DATA, sid, new TextEncoder().encode(body), Flag.EOS))
}

describe("the compute relay", { timeout: 30_000 }, () => {
  let host: FakeHost
  let alice: Awaited<ReturnType<typeof memberAs>>

  beforeAll(async () => {
    alice = await memberAs("alice")
  })
  afterAll(() => host?.ws.close())

  it("refuses a bad host key and never answers the host route with CORS", async () => {
    const bad = await SELF.fetch(`${ORIGIN}/api/compute/host`, {
      headers: { authorization: "Bearer nope", upgrade: "websocket", origin: SITE },
    })
    expect(bad.status).toBe(401)
    expect(bad.headers.get("access-control-allow-origin")).toBeNull()
    const preflight = await SELF.fetch(`${ORIGIN}/api/compute/host`, {
      method: "OPTIONS",
      headers: { origin: SITE },
    })
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("answers 503 while no host is connected", async () => {
    const response = await alice.fetch(
      "/api/compute/fetch",
      envelope("GET", "/jupyter/user/alice/lab"),
    )
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ detail: "compute host offline" })
    const status = await alice.fetch("/api/compute/status")
    expect((await status.json()) as any).toMatchObject({ host: { online: false }, server: null })
  })

  it("proxies a request with the assertion, forwarded headers and a forced CSP", async () => {
    host = await connectHost()
    const pending = alice.fetch(
      "/api/compute/fetch",
      envelope("GET", "/jupyter/user/alice/lab?reset", {
        accept: "text/html",
        cookie: "stolen=1",
      }),
    )
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    expect(open.streamId % 2).toBe(1)
    const meta = readJsonPayload<any>(open)
    expect(meta).toMatchObject({
      method: "GET",
      target: "/jupyter/user/alice/lab?reset",
      has_body: false,
      window: INITIAL_WINDOW,
      ws_url: "wss://members.test/api/compute/ws",
    })
    expect(meta.headers).toContainEqual(["accept", "text/html"])
    expect(meta.headers.map(([name]: [string]) => name)).not.toContain("cookie")
    expect(await verifyAssertion(meta.assertion, vectors.secret)).toMatchObject({ login: "alice" })
    expect(await verifyTicket(workerEnv, meta.ticket)).toMatchObject({ login: "alice" })

    await respond(
      host,
      open.streamId,
      200,
      [
        ["content-type", "text/html"],
        ["content-security-policy", "frame-ancestors *"],
        ["set-cookie", "jupyterhub-session=x"],
        ["etag", '"abc"'],
      ],
      "<html>lab</html>",
    )
    const response = await pending
    expect(response.status).toBe(200)
    expect(await response.text()).toBe("<html>lab</html>")
    expect(response.headers.get("content-security-policy")).toBe(FORCED_CSP)
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("etag")).toBe('"abc"')
    expect(response.headers.get("access-control-expose-headers")).toContain("x-compute-location")
  })

  it("refuses other members' servers, the hub and encoded separators before the host sees them", async () => {
    for (const [target, status] of [
      ["/jupyter/user/bob/lab", 403],
      ["/jupyter/hub/api/users", 403],
      ["/jupyter/user/alice/api/contents/a%2fb", 400],
      ["/jupyter/user/alice/../bob/lab", 400],
    ] as const) {
      const response = await alice.fetch("/api/compute/fetch", envelope("GET", target))
      expect(response.status, target).toBe(status)
    }
    // The owner too, without COMPUTE_OWNER_ACCESS.
    const owner = await member()
    const response = await owner.fetch(
      "/api/compute/fetch",
      envelope("GET", "/jupyter/user/alice/lab"),
    )
    expect(response.status).toBe(403)
    expect(host.frames.filter(ofType(FrameType.OPEN_HTTP))).toHaveLength(0)
  })

  it("remaps an upstream 401 to 403 so the service worker keeps the member signed in", async () => {
    const pending = alice.fetch("/api/compute/fetch", envelope("GET", "/jupyter/user/alice/api/me"))
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, open.streamId, 401, [["content-type", "application/json"]], "{}")
    const response = await pending
    expect(response.status).toBe(403)
    expect(response.headers.get("x-compute-upstream-status")).toBe("401")
  })

  it("turns a redirect into 204 + x-compute-location", async () => {
    const pending = alice.fetch("/api/compute/fetch", envelope("GET", "/jupyter/user/alice/"))
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, open.streamId, 302, [
      ["location", "http://127.0.0.1:8000/jupyter/user/alice/lab?x=1"],
    ])
    const response = await pending
    expect(response.status).toBe(204)
    expect(response.headers.get("x-compute-location")).toBe("/jupyter/user/alice/lab?x=1")
    expect(response.headers.get("location")).toBeNull()

    const relative = alice.fetch(
      "/api/compute/fetch",
      envelope("GET", "/jupyter/user/alice/tree/a"),
    )
    const second = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, second.streamId, 301, [["location", "b"]])
    expect((await relative).headers.get("x-compute-location")).toBe("/jupyter/user/alice/tree/b")
  })

  it("streams a 5 MiB download within the credit window", async () => {
    const size = 5 * 1024 * 1024
    const pending = alice.fetch(
      "/api/compute/fetch",
      envelope("GET", "/jupyter/user/alice/files/big.bin"),
    )
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    const sid = open.streamId
    host.send(
      jsonFrame(FrameType.RESPONSE_HEAD, sid, {
        status: 200,
        headers: [["content-type", "application/octet-stream"]],
      }),
    )
    const response = await pending
    expect(response.status).toBe(200)

    let credit = INITIAL_WINDOW
    let sent = 0
    let granted = 0
    const collect = async () => {
      while (true) {
        const frame = await host.next(ofType(FrameType.WINDOW, sid))
        credit += readWindow(frame)
        granted += readWindow(frame)
        if (granted >= size) return
      }
    }
    const grants = collect()
    const produce = async () => {
      while (sent < size) {
        if (credit <= 0) {
          await tick(2)
          continue
        }
        const n = Math.min(credit, MAX_PAYLOAD, size - sent)
        const chunk = new Uint8Array(n)
        for (let i = 0; i < n; i++) chunk[i] = (sent + i) % 251
        host.send(encodeFrame(FrameType.DATA, sid, chunk))
        credit -= n
        sent += n
        expect(credit).toBeGreaterThanOrEqual(0)
      }
      host.send(encodeFrame(FrameType.DATA, sid, undefined, Flag.EOS))
    }

    // Nobody reads yet: the host runs out of credit and stalls well short of the whole body.
    const producing = produce()
    await tick(300)
    expect(sent).toBeLessThan(size)

    const body = new Uint8Array(await response.arrayBuffer())
    await producing
    await grants
    expect(body.byteLength).toBe(size)
    expect(body[size - 1]).toBe((size - 1) % 251)
    expect(granted).toBe(size)
  })

  it("streams a 20 MiB upload in chunks that never exceed the host's credit", async () => {
    const size = 20 * 1024 * 1024
    const upload = new Uint8Array(size)
    for (let i = 0; i < size; i += 4096) upload[i] = (i / 4096) % 256
    const pending = alice.fetch("/api/compute/fetch", {
      ...envelope("PUT", "/jupyter/user/alice/api/contents/big.bin", {
        "content-type": "application/octet-stream",
      }),
      body: upload,
    })
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    const sid = open.streamId
    expect(readJsonPayload<any>(open)).toMatchObject({ method: "PUT", has_body: true })

    let received = 0
    let outstanding = 0
    let maxFrame = 0
    let sample = true
    while (true) {
      const frame = await host.next(ofType(FrameType.DATA, sid))
      const n = frame.payload.byteLength
      if (n && received % 4096 === 0 && frame.payload[0] !== (received / 4096) % 256) sample = false
      received += n
      outstanding += n
      maxFrame = Math.max(maxFrame, n)
      expect(outstanding).toBeLessThanOrEqual(INITIAL_WINDOW)
      if (n) {
        host.send(encodeFrame(FrameType.WINDOW, sid, windowPayload(n)))
        outstanding -= n
      }
      if (frame.flags & Flag.EOS) break
    }
    expect(received).toBe(size)
    expect(maxFrame).toBeLessThanOrEqual(MAX_PAYLOAD)
    expect(sample).toBe(true)
    await respond(host, sid, 201, [["content-type", "application/json"]], '{"ok":true}')
    expect((await pending).status).toBe(201)
  })

  it("refuses bodies over 95 MiB with 413", async () => {
    const declared = await alice.fetch("/api/compute/fetch", {
      ...envelope("PUT", "/jupyter/user/alice/api/contents/huge.bin"),
      headers: {
        "x-compute-method": "PUT",
        "x-compute-target": "/jupyter/user/alice/api/contents/huge.bin",
        "content-length": String(96 * 1024 * 1024),
      },
      // Declared, not sent: the Worker refuses on the header before reading a byte.
      body: new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(65536)) }),
      duplex: "half",
    } as RequestInit & { headers: Record<string, string> })
    expect(declared.status).toBe(413)

    // Undeclared (streamed) bodies are counted by the relay, which resets the host's stream.
    const chunk = new Uint8Array(1024 * 1024)
    let pushed = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed++ >= 97) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const pending = alice.fetch("/api/compute/fetch", {
      ...envelope("PUT", "/jupyter/user/alice/api/contents/huge.bin"),
      body,
      duplex: "half",
    } as RequestInit & { headers: Record<string, string> })
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    const sid = open.streamId
    let reset: Frame | null = null
    while (!reset) {
      const frame = await host.next(
        (f) => f.streamId === sid && (f.type === FrameType.DATA || f.type === FrameType.RESET),
      )
      if (frame.type === FrameType.RESET) reset = frame
      else if (frame.payload.byteLength)
        host.send(encodeFrame(FrameType.WINDOW, sid, windowPayload(frame.payload.byteLength)))
    }
    expect(readJsonPayload<any>(reset).code).toBe("too_large")
    expect((await pending).status).toBe(413)
  })

  it("caps a member at 32 concurrent requests", async () => {
    const pending = Array.from({ length: 32 }, () =>
      alice.fetch("/api/compute/fetch", envelope("GET", "/jupyter/user/alice/api/slow")),
    )
    const opens: Frame[] = []
    for (let i = 0; i < 32; i++) opens.push(await host.next(ofType(FrameType.OPEN_HTTP)))
    const over = await alice.fetch(
      "/api/compute/fetch",
      envelope("GET", "/jupyter/user/alice/api/slow"),
    )
    expect(over.status).toBe(429)
    for (const open of opens) await respond(host, open.streamId, 200, [], "ok")
    for (const response of await Promise.all(pending)) expect(await response.text()).toBe("ok")
  })

  it("resets in-flight streams and sends GOAWAY when a new host replaces the old one", async () => {
    const pending = alice.fetch(
      "/api/compute/fetch",
      envelope("GET", "/jupyter/user/alice/api/hang"),
    )
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    const old = host
    host = await connectHost()
    const reset = await old.next(ofType(FrameType.RESET, open.streamId))
    expect(readJsonPayload<any>(reset).code).toBe("host_replaced")
    const goaway = await old.next(ofType(FrameType.GOAWAY, 0))
    expect(readJsonPayload<any>(goaway).reason).toBe("replaced")
    const response = await pending
    expect(response.status).toBe(502)
    await old.closed

    // The new host serves the next request.
    const next = alice.fetch("/api/compute/fetch", envelope("GET", "/jupyter/user/alice/lab"))
    const fresh = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, fresh.streamId, 200, [], "again")
    expect(await (await next).text()).toBe("again")
  })

  it("runs control RPCs: status, start with progress, stop, the owner's list", async () => {
    const answer = (op: string, result: unknown, progress: unknown[] = []) =>
      host
        .next((f) => f.type === FrameType.CONTROL && readJsonPayload<any>(f).op === op)
        .then((frame) => {
          const rpc = readJsonPayload<any>(frame)
          for (const step of progress)
            host.send(
              jsonFrame(FrameType.CONTROL_RESULT, 0, {
                rpc_id: rpc.rpc_id,
                progress: step,
                done: false,
              }),
            )
          host.send(
            jsonFrame(FrameType.CONTROL_RESULT, 0, {
              rpc_id: rpc.rpc_id,
              ok: true,
              result,
              done: true,
            }),
          )
          return rpc
        })

    const statusRpc = answer("status", { server: "stopped" })
    const status = (await (await alice.fetch("/api/compute/status")).json()) as any
    expect(status).toMatchObject({
      host: { online: true, host_id: "test" },
      server: { server: "stopped" },
    })
    expect(await verifyAssertion((await statusRpc).assertion, vectors.secret)).toMatchObject({
      login: "alice",
    })

    const bad = await alice.fetch("/api/compute/server", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "rm -rf" }),
    })
    expect(bad.status).toBe(422)

    const ensure = answer("ensure_server", { server: "running", url: "/jupyter/user/alice/" }, [
      { message: "spawning", percent: 50 },
    ])
    const started = await alice.fetch("/api/compute/server", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "gds" }),
    })
    expect(started.headers.get("content-type")).toContain("ndjson")
    const lines = (await started.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    expect((await ensure).args).toEqual({ profile: "gds" })
    expect(lines[0]).toEqual({ progress: { message: "spawning", percent: 50 } })
    expect(lines.at(-1)).toMatchObject({ done: true, ok: true, result: { server: "running" } })
    expect(await verifyTicket(workerEnv, lines.at(-1).ticket)).toMatchObject({ login: "alice" })

    const stop = answer("stop_server", { server: "stopped" })
    const stopped = await alice.fetch("/api/compute/server", { method: "DELETE" })
    expect(await stopped.json()).toEqual({ server: "stopped" })
    await stop

    expect((await alice.fetch("/api/compute/servers")).status).toBe(403)
    const list = answer("list", { servers: [{ login: "alice", server: "running" }] })
    const owner = await member()
    expect((await owner.json("/api/compute/servers")).body.servers).toHaveLength(1)
    await list

    // An owner stops a member's server; a member cannot, and the login is checked first.
    expect((await alice.fetch("/api/compute/servers/bob", { method: "DELETE" })).status).toBe(403)
    expect((await owner.fetch("/api/compute/servers/..%2Fx", { method: "DELETE" })).status).toBe(
      422,
    )
    const stopOther = answer("stop_server", { server: "stopped" })
    const stoppedOther = await owner.fetch("/api/compute/servers/Bob", { method: "DELETE" })
    expect(await stoppedOther.json()).toEqual({ server: "stopped" })
    expect((await stopOther).args).toEqual({ login: "bob" })
  })

  it("limits Wolfram runs to one at a time per member", async () => {
    const run = () =>
      alice.fetch("/api/compute/wolfram/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "2+2", prelude: [], page: "resources/wolfram-guide/ch01" }),
      })
    const first = run()
    const rpc = readJsonPayload<any>(
      await host.next(
        (f) => f.type === FrameType.CONTROL && readJsonPayload<any>(f).op === "wolfram_run",
      ),
    )
    expect(rpc.args).toEqual({ code: "2+2", prelude: [], page: "resources/wolfram-guide/ch01" })
    expect((await run()).status).toBe(429)
    host.send(
      jsonFrame(FrameType.CONTROL_RESULT, 0, {
        rpc_id: rpc.rpc_id,
        ok: true,
        result: { text: "4", messages: [], ms: 3 },
        done: true,
      }),
    )
    expect(await (await first).json()).toMatchObject({ text: "4" })
  })

  it("forks a published notebook as published:<path>, and nothing else", async () => {
    const fork = (source: unknown) =>
      alice.fetch("/api/compute/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      })
    const pending = fork({ kind: "published", path: "wolfram-guide/EIWL3-01.nb" })
    const rpc = readJsonPayload<any>(
      await host.next((f) => f.type === FrameType.CONTROL && readJsonPayload<any>(f).op === "fork"),
    )
    expect(rpc.args).toEqual({ source: "published:wolfram-guide/EIWL3-01.nb" })
    host.send(
      jsonFrame(FrameType.CONTROL_RESULT, 0, {
        rpc_id: rpc.rpc_id,
        ok: true,
        result: { path: "forks/published/EIWL3-01.nb", size: 12 },
        done: true,
      }),
    )
    expect(await (await pending).json()).toMatchObject({ path: "forks/published/EIWL3-01.nb" })
    for (const bad of [
      { kind: "eiwl", path: "x.nb" },
      { kind: "published", path: "../secret.nb" },
      { kind: "published", path: "/etc/passwd" },
      { kind: "published" },
    ])
      expect((await fork(bad)).status).toBe(422)
  })
})

describe("JupyterLab WebSockets through the relay", { timeout: 30_000 }, () => {
  let host: FakeHost
  let ticket: string
  const PROTOCOL = "v1.kernel.websocket.jupyter.org"
  const path = "/api/compute/ws/jupyter/user/alice/api/kernels/k1/channels?session_id=s1"
  const open = (token: string, origin = SITE, url = path) =>
    SELF.fetch(`${ORIGIN}${url}&token=${encodeURIComponent(token)}`, {
      headers: { upgrade: "websocket", origin, "sec-websocket-protocol": PROTOCOL },
    })

  beforeAll(async () => {
    host = await connectHost()
    ticket = await issueTicket(workerEnv, {
      login: "alice",
      role: "member",
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
  })
  afterAll(() => host.ws.close())

  it("rejects a bad ticket, a foreign origin and another member's path", async () => {
    expect((await open("garbage")).status).toBe(401)
    const session = await sign(
      { typ: "session", login: "alice", name: "a", role: "member", exp: Date.now() / 1000 + 60 },
      workerEnv.SESSION_SECRET,
    )
    expect((await open(session)).status).toBe(401) // a session token is not a ticket
    expect((await open(ticket, "https://evil.example")).status).toBe(403)
    expect(
      (await open(ticket, SITE, "/api/compute/ws/jupyter/user/bob/api/kernels/k1/channels?x=1"))
        .status,
    ).toBe(403)
    expect(host.frames.filter(ofType(FrameType.OPEN_WS))).toHaveLength(0)
  })

  it("negotiates the subprotocol, strips the ticket, and fragments large messages both ways", async () => {
    const pending = open(ticket)
    const frame = await host.next(ofType(FrameType.OPEN_WS))
    const sid = frame.streamId
    const meta = readJsonPayload<any>(frame)
    expect(meta.target).toBe("/jupyter/user/alice/api/kernels/k1/channels?session_id=s1")
    expect(meta.protocols).toEqual([PROTOCOL])
    expect(await verifyAssertion(meta.assertion, vectors.secret)).toMatchObject({ login: "alice" })
    host.send(jsonFrame(FrameType.WS_ACCEPT, sid, { protocol: PROTOCOL }))
    const response = await pending
    expect(response.status).toBe(101)
    expect(response.headers.get("sec-websocket-protocol")).toBe(PROTOCOL)
    const ws = response.webSocket!
    ws.binaryType = "arraybuffer"
    ws.accept()
    const inbox: (string | ArrayBuffer)[] = []
    const got = (n: number) =>
      new Promise<void>((resolve) => {
        const check = () => (inbox.length >= n ? resolve() : setTimeout(check, 5))
        check()
      })
    ws.addEventListener("message", (event) => {
      inbox.push(event.data as string | ArrayBuffer)
    })

    // Browser → host: a 600 KiB binary message needs three fragments and one credit refill.
    const big = new Uint8Array(600 * 1024).map((_, i) => i % 7)
    ws.send(big)
    const parts: Frame[] = []
    let total = 0
    while (total < big.byteLength) {
      const part = await host.next(ofType(FrameType.WS_MSG, sid))
      parts.push(part)
      total += part.payload.byteLength
      host.send(encodeFrame(FrameType.WINDOW, sid, windowPayload(part.payload.byteLength)))
    }
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.every((p) => p.flags & Flag.BIN)).toBe(true)
    expect(parts.slice(0, -1).every((p) => !(p.flags & Flag.FIN))).toBe(true)
    expect(parts.at(-1)!.flags & Flag.FIN).toBeTruthy()

    // Host → browser: a 300 KiB text message in two fragments arrives as one message, and each
    // fragment is acknowledged with credit.
    const text = "x".repeat(300 * 1024)
    const bytes = new TextEncoder().encode(text)
    host.send(encodeFrame(FrameType.WS_MSG, sid, bytes.subarray(0, MAX_PAYLOAD), 0))
    host.send(encodeFrame(FrameType.WS_MSG, sid, bytes.subarray(MAX_PAYLOAD), Flag.FIN))
    await got(1)
    expect(inbox[0]).toBe(text)
    expect(readWindow(await host.next(ofType(FrameType.WINDOW, sid)))).toBe(MAX_PAYLOAD)

    // Recovery after hibernation: forget every in-memory stream and host reference; the relay
    // rebuilds them from its hibernatable sockets and their attachments.
    const relay = workerEnv.COMPUTE_RELAY
    const inRelay = runInDurableObject as unknown as (
      stub: unknown,
      fn: (instance: any) => void,
    ) => Promise<void>
    await inRelay(relay.get(relay.idFromName(RELAY_NAME)), (instance) => {
      instance.streams.clear()
      instance.hostSocket = null
    })
    ws.send("after")
    const after = await host.next(ofType(FrameType.WS_MSG, sid))
    expect(new TextDecoder().decode(after.payload)).toBe("after")
    expect(after.flags & Flag.BIN).toBe(0)
    host.send(encodeFrame(FrameType.WS_MSG, sid, new Uint8Array([1, 2, 3]), Flag.BIN | Flag.FIN))
    await got(2)
    expect([...new Uint8Array(inbox[1] as ArrayBuffer)]).toEqual([1, 2, 3])

    // The host closes the kernel channel.
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve))
    host.send(encodeFrame(FrameType.WS_CLOSE, sid, closePayload(1000, "bye")))
    expect((await closed).code).toBe(1000)
  })

  it("tells the host when the member closes, and fails fast when the host refuses", async () => {
    const pending = open(ticket)
    const frame = await host.next(ofType(FrameType.OPEN_WS))
    host.send(jsonFrame(FrameType.WS_ACCEPT, frame.streamId, { protocol: null }))
    const ws = (await pending).webSocket!
    ws.accept()
    ws.close(1000, "done")
    const close = await host.next(ofType(FrameType.WS_CLOSE, frame.streamId))
    expect(readClose(close).code).toBe(1000)

    const refused = open(ticket)
    const second = await host.next(ofType(FrameType.OPEN_WS))
    host.send(jsonFrame(FrameType.RESET, second.streamId, { code: "refused", reason: "no kernel" }))
    expect((await refused).status).toBe(502)
  })

  it("closes member sockets when the host is replaced", async () => {
    const pending = open(ticket)
    const frame = await host.next(ofType(FrameType.OPEN_WS))
    host.send(jsonFrame(FrameType.WS_ACCEPT, frame.streamId, { protocol: null }))
    const ws = (await pending).webSocket!
    ws.accept()
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve))
    const old = host
    host = await connectHost()
    expect((await closed).code).toBe(1012)
    await old.closed
  })
})
