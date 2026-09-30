import {
  SELF,
  createExecutionContext,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test"
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
import { finish, labCsp } from "../src/compute/routes"
import {
  issueAssertion,
  issueLabTicket,
  verifyAssertion,
  verifyLabTicket,
} from "../src/compute/tokens"
import type { Env } from "../src/env"
import { SESSION_MAX_AGE, sign } from "../src/session"
import vectors from "./fixtures/compute-vectors.json"
import { ORIGIN, SITE, auditRows, member } from "./helpers"
import worker from "./worker"

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

  it("has a shared vector for every frame type", () => {
    const covered = new Set(vectors.frames.map((v) => v.type))
    expect(Object.values(FrameType).filter((type) => !covered.has(type))).toEqual([])
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
    // An admin's read of one member's code names the member; other assertions name no one.
    expect(await verifyAssertion(tokens.admin_read.token, secret)).toEqual(tokens.admin_read.claims)
    expect(await sign(tokens.admin_read.claims, secret)).toBe(tokens.admin_read.token)
    const plain = await verifyAssertion(
      await issueAssertion(workerEnv, { login: "olivia", role: "owner" }),
      secret,
    )
    expect(plain).not.toHaveProperty("admin_read")
    const read = await verifyAssertion(
      await issueAssertion(workerEnv, { login: "Olivia", role: "member" }, "Alice"),
      secret,
    )
    expect(read).toMatchObject({ login: "olivia", role: "member", admin_read: "alice" })
  })

  it("issues 60 s assertions and session-bounded tickets", async () => {
    const assertion = await verifyAssertion(
      await issueAssertion(workerEnv, { login: "Alice", role: "member" }),
      vectors.secret,
    )
    expect(assertion).toMatchObject({ typ: "compute", aud: "hafezi-compute", login: "alice" })
    expect(assertion!.exp - assertion!.iat).toBe(60)
    const exp = Math.floor(Date.now() / 1000) + 120
    const ticket = await verifyLabTicket(
      workerEnv,
      await issueLabTicket(workerEnv, { login: "Alice", role: "member", exp }, "Bob"),
    )
    expect(ticket).toMatchObject({ typ: "compute-lab", login: "alice", target: "bob", exp })
    // A ticket is not a session, and a session is not a ticket.
    expect(await verifyLabTicket(workerEnv, "garbage")).toBeNull()
    const session = await sign(
      { typ: "session", login: "alice", name: "a", role: "member", exp },
      workerEnv.SESSION_SECRET,
    )
    expect(await verifyLabTicket(workerEnv, session)).toBeNull()
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

  it("lets a file in a folder open through the collaboration session endpoint, and judges it decoded", () => {
    const session = "/jupyter/user/alice/api/collaboration/session/"
    expect(authorizeTarget(`${session}profiles%2Fbase.py`, alice, workerEnv).target).toBe(
      `${session}profiles%2Fbase.py`,
    )
    expect(deny(`${session}forks%2Fpublished%2Fa.ipynb`)).toBe(200)
    expect(deny(`${session}..%2F..%2Fbob%2Fx.ipynb`)).toBe(400)
    expect(deny(`${session}a%5Cb.py`)).toBe(400)
    expect(deny(`${session}a%00b.py`)).toBe(400)
    expect(deny("/jupyter/user/alice/api/collaboration%2Fsession/a%2Fb.py")).toBe(400)
    expect(deny("/jupyter/user/alice/api/collaboration/room/a%2Fb")).toBe(400)
    expect(deny("/jupyter/user/bob/api/collaboration/session/a%2Fb.py")).toBe(403)
  })

  it("lets an owner in only when COMPUTE_OWNER_ACCESS is on", () => {
    expect(deny("/jupyter/user/alice/lab", owner)).toBe(403)
    expect(deny("/jupyter/user/alice/lab", owner, { COMPUTE_OWNER_ACCESS: "true" })).toBe(200)
    expect(deny("/jupyter/user/alice/lab", alice, { COMPUTE_OWNER_ACCESS: "true" })).toBe(200)
    expect(deny("/jupyter/user/bob/lab", alice, { COMPUTE_OWNER_ACCESS: "true" })).toBe(403)
  })

  it("keeps the sandbox Jupyter puts on raw files, but not the rest of its policy", () => {
    const raw = new Response("<script>", {
      headers: { "content-security-policy": "frame-ancestors *; sandbox allow-scripts" },
    })
    const lab = { prefix: "/lab/t.k", siteOrigin: "https://site.example" }
    expect(
      finish(raw, "/jupyter/user/alice/files/x.html", lab).headers.get("content-security-policy"),
    ).toBe(`${labCsp(lab.siteOrigin)}; sandbox allow-scripts`)
    const page = new Response("<html>", {
      headers: { "content-security-policy": "frame-ancestors *" },
    })
    expect(
      finish(page, "/jupyter/user/alice/lab", lab).headers.get("content-security-policy"),
    ).toBe(labCsp(lab.siteOrigin))
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

/** A lab-origin request for `target` with `ticket` in the path, the way the lab page makes it. */
const viaLab = (
  ticket: string,
  method: string,
  target: string,
  headers: Record<string, string> = {},
  init: RequestInit = {},
) =>
  SELF.fetch(`${ORIGIN}/lab/${ticket}${target}`, { redirect: "manual", method, headers, ...init })

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
  let aliceLab: string
  const lab = (
    method: string,
    target: string,
    headers?: Record<string, string>,
    init?: RequestInit,
  ) => viaLab(aliceLab, method, target, headers, init)

  beforeAll(async () => {
    alice = await memberAs("alice")
    aliceLab = await issueLabTicket(
      workerEnv,
      { login: "alice", role: "member", exp: Math.floor(Date.now() / 1000) + 3600 },
      "alice",
    )
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
    const response = await lab("GET", "/jupyter/user/alice/lab")
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ detail: "compute host offline" })
    const status = (await (await alice.fetch("/api/compute/status")).json()) as any
    expect(status).toMatchObject({ host: { online: false }, server: null })
    // The member's lab lives on the Worker's origin, keyed by a ticket for their own server.
    expect(status.lab).toMatch(
      /^https:\/\/members\.test\/lab\/[\w-]+\.[\w-]+\/jupyter\/user\/alice\/$/,
    )
  })

  it("proxies a request with the assertion, forwarded headers and a forced CSP", async () => {
    host = await connectHost()
    const pending = lab("GET", "/jupyter/user/alice/lab?reset", {
      accept: "text/html",
      cookie: "stolen=1",
    })
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    expect(open.streamId % 2).toBe(1)
    const meta = readJsonPayload<any>(open)
    expect(meta).toMatchObject({
      method: "GET",
      target: "/jupyter/user/alice/lab?reset",
      has_body: false,
      window: INITIAL_WINDOW,
      ws_url: `wss://members.test/lab/${aliceLab}`,
      ticket: "",
    })
    expect(meta.headers).toContainEqual(["accept", "text/html"])
    expect(meta.headers.map(([name]: [string]) => name)).not.toContain("cookie")
    expect(await verifyAssertion(meta.assertion, vectors.secret)).toMatchObject({ login: "alice" })

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
    expect(response.headers.get("content-security-policy")).toBe(labCsp(new URL(SITE).origin))
    expect(response.headers.get("x-frame-options")).toBeNull()
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("etag")).toBe('"abc"')
  })

  it("refuses other members' servers, the hub and encoded separators before the host sees them", async () => {
    for (const [target, status] of [
      ["/jupyter/user/bob/lab", 403],
      ["/jupyter/hub/api/users", 403],
      ["/jupyter/user/alice/api/contents/a%2fb", 400],
      // The URL is normalised before the Worker sees it, so this is bob's path.
      ["/jupyter/user/alice/../bob/lab", 403],
    ] as const) {
      const response = await lab("GET", target)
      expect(response.status, target).toBe(status)
    }
    // The owner too, without COMPUTE_OWNER_ACCESS, even holding a ticket for alice's server.
    const owner = await issueLabTicket(
      workerEnv,
      { login: "boss", role: "owner", exp: Math.floor(Date.now() / 1000) + 3600 },
      "alice",
    )
    expect((await viaLab(owner, "GET", "/jupyter/user/alice/lab")).status).toBe(403)
    expect(host.frames.filter(ofType(FrameType.OPEN_HTTP))).toHaveLength(0)
  })

  it("passes Jupyter's own status through", async () => {
    const pending = lab("GET", "/jupyter/user/alice/api/me")
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, open.streamId, 401, [["content-type", "application/json"]], "{}")
    const response = await pending
    expect(response.status).toBe(401)
  })

  it("keeps the ticket prefix on redirects, and never redirects off the lab origin", async () => {
    const pending = lab("GET", "/jupyter/user/alice/")
    const open = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, open.streamId, 302, [
      ["location", "http://127.0.0.1:8000/jupyter/user/alice/lab?x=1"],
    ])
    const response = await pending
    expect(response.status).toBe(302)
    expect(response.headers.get("location")).toBe(`/lab/${aliceLab}/jupyter/user/alice/lab?x=1`)

    const relative = lab("GET", "/jupyter/user/alice/tree/a")
    const second = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, second.streamId, 301, [["location", "b"]])
    expect((await relative).headers.get("location")).toBe(
      `/lab/${aliceLab}/jupyter/user/alice/tree/b`,
    )
  })

  it("streams a 5 MiB download within the credit window", async () => {
    const size = 5 * 1024 * 1024
    const pending = lab("GET", "/jupyter/user/alice/files/big.bin")
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
    const pending = lab(
      "PUT",
      "/jupyter/user/alice/api/contents/big.bin",
      { "content-type": "application/octet-stream" },
      { body: upload },
    )
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
    const declared = await lab(
      "PUT",
      "/jupyter/user/alice/api/contents/huge.bin",
      { "content-length": String(96 * 1024 * 1024) },
      {
        // Declared, not sent: the Worker refuses on the header before reading a byte.
        body: new ReadableStream({
          pull: (controller) => controller.enqueue(new Uint8Array(65536)),
        }),
        duplex: "half",
      } as RequestInit,
    )
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
    const pending = lab("PUT", "/jupyter/user/alice/api/contents/huge.bin", {}, {
      body,
      duplex: "half",
    } as RequestInit)
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

  it("caps a member at 32 concurrent requests: reads wait for a free stream, writes are refused", async () => {
    const pending = Array.from({ length: 32 }, () => lab("GET", "/jupyter/user/alice/api/slow"))
    const opens: Frame[] = []
    for (let i = 0; i < 32; i++) opens.push(await host.next(ofType(FrameType.OPEN_HTTP)))
    const write = await lab("PUT", "/jupyter/user/alice/api/contents/a.txt", {}, { body: "x" })
    expect(write.status).toBe(429)
    // A 33rd read (a lab page's script) is held, not failed, until one of the 32 finishes.
    const read = lab("GET", "/jupyter/user/alice/static/x.js")
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(host.frames.filter(ofType(FrameType.OPEN_HTTP))).toHaveLength(0)
    await respond(host, opens[0].streamId, 200, [], "ok")
    const late = await host.next(ofType(FrameType.OPEN_HTTP))
    expect(readJsonPayload<any>(late).target).toBe("/jupyter/user/alice/static/x.js")
    await respond(host, late.streamId, 200, [], "late")
    expect(await (await read).text()).toBe("late")
    for (const open of opens.slice(1)) await respond(host, open.streamId, 200, [], "ok")
    for (const response of await Promise.all(pending)) expect(await response.text()).toBe("ok")
  })

  it("resets in-flight streams and sends GOAWAY when a new host replaces the old one", async () => {
    const pending = lab("GET", "/jupyter/user/alice/api/hang")
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
    const next = lab("GET", "/jupyter/user/alice/lab")
    const fresh = await host.next(ofType(FrameType.OPEN_HTTP))
    await respond(host, fresh.streamId, 200, [], "again")
    expect(await (await next).text()).toBe("again")
  })

  it("reports a host that has gone silent as offline, until it is heard from again", async () => {
    const inRelay = runInDurableObject as unknown as (
      stub: unknown,
      fn: (instance: any) => void,
    ) => Promise<void>
    const stub = workerEnv.COMPUTE_RELAY.get(workerEnv.COMPUTE_RELAY.idFromName(RELAY_NAME))
    const connectedAt = (at: number) =>
      inRelay(stub, (instance) => {
        const ws = instance.host()
        ws.serializeAttachment({ ...ws.deserializeAttachment(), connected_at: at })
        instance.hostFrameAt = 0
      })
    await connectedAt(Date.now() - 10 * 60_000)
    const silent = (await (await alice.fetch("/api/compute/status")).json()) as any
    expect(silent.host.online).toBe(false)
    expect(silent.server).toBeNull()
    await connectedAt(Date.now())
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

    // A member's own profile starts the same way; the host checks the file is there.
    const ensureOwn = answer("ensure_server", { server: "running", url: "/jupyter/user/alice/" })
    const own = await alice.fetch("/api/compute/server", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "user-ring_fits" }),
    })
    await own.text()
    expect((await ensureOwn).args).toEqual({ profile: "user-ring_fits" })
    for (const profile of ["user-", "user-../x", "user-Rings", "mine-x"]) {
      const refused = await alice.fetch("/api/compute/server", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile }),
      })
      expect(refused.status).toBe(422)
    }

    const profilesRpc = answer("profiles", {
      profiles: [
        { id: "gds", name: "gds", title: "GDS layout", builtin: true },
        { id: "user-ring_fits", name: "ring_fits", title: "Ring fits", builtin: false },
      ],
    })
    const profiles = (await (await alice.fetch("/api/compute/profiles")).json()) as any
    expect(profiles.profiles.map((p: any) => p.id)).toEqual(["gds", "user-ring_fits"])
    expect((await profilesRpc).args).toEqual({})

    const stop = answer("stop_server", { server: "stopped" })
    const stopped = await alice.fetch("/api/compute/server", { method: "DELETE" })
    expect(await stopped.json()).toEqual({ server: "stopped" })
    await stop

    expect((await alice.fetch("/api/compute/servers")).status).toBe(403)
    const list = answer("list", { servers: [{ login: "alice", server: "running" }] })
    const owner = await member()
    const listed = (await owner.json("/api/compute/servers")).body.servers
    expect(listed).toHaveLength(1)
    expect(listed[0].lab_url).toBeUndefined() // owner access is off in the test config
    await list

    // An owner stops a member's server only with COMPUTE_OWNER_ACCESS on (the test config leaves it
    // off); a member cannot, and the login is checked first.
    const ownerStop = async (login: string) => {
      const ctx = createExecutionContext()
      const response = await (worker as ExportedHandler).fetch!(
        new Request(`${ORIGIN}/api/compute/servers/${login}`, {
          method: "DELETE",
          headers: owner.headers,
        }) as any,
        { ...env, COMPUTE_OWNER_ACCESS: "true" } as any,
        ctx,
      )
      await waitOnExecutionContext(ctx)
      return response
    }
    // With owner access on, each listed server links to its lab on the lab origin.
    const withAccess = answer("list", { servers: [{ login: "alice", server: "running" }] })
    const ctx = createExecutionContext()
    const on = await (worker as ExportedHandler).fetch!(
      new Request(`${ORIGIN}/api/compute/servers`, { headers: owner.headers }) as any,
      { ...env, COMPUTE_OWNER_ACCESS: "true" } as any,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    await withAccess
    const row = ((await on.json()) as any).servers[0]
    expect(row.lab_url).toMatch(
      /^https:\/\/members\.test\/lab\/[\w-]+\.[\w-]+\/jupyter\/user\/alice\/lab$/,
    )

    expect((await alice.fetch("/api/compute/servers/bob", { method: "DELETE" })).status).toBe(403)
    const off = await owner.fetch("/api/compute/servers/bob", { method: "DELETE" })
    expect(off.status).toBe(403)
    expect(await off.json()).toEqual({ detail: "owner access is off" })
    expect((await ownerStop("..%2Fx")).status).toBe(422)
    const stopOther = answer("stop_server", { server: "stopped" })
    const stoppedOther = await ownerStop("Bob")
    expect(await stoppedOther.json()).toEqual({ server: "stopped" })
    expect((await stopOther).args).toEqual({ login: "bob" })
  })

  it("limits Wolfram runs to one at a time per member", async () => {
    const run = () =>
      alice.fetch("/api/compute/wolfram/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "2+2",
          prelude: [],
          page: "resources/code/wolfram-guide/ch01",
        }),
      })
    const first = run()
    const rpc = readJsonPayload<any>(
      await host.next(
        (f) => f.type === FrameType.CONTROL && readJsonPayload<any>(f).op === "wolfram_run",
      ),
    )
    expect(rpc.args).toEqual({
      code: "2+2",
      prelude: [],
      page: "resources/code/wolfram-guide/ch01",
    })
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

  it("passes a member's Wolfram license requests to the host, never logging the password", async () => {
    const answer = (op: string, result: unknown) =>
      host
        .next((f) => f.type === FrameType.CONTROL && readJsonPayload<any>(f).op === op)
        .then((frame) => {
          const rpc = readJsonPayload<any>(frame)
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
    const status = answer("wolfram_license", { state: "none" })
    const got = await alice.fetch("/api/compute/wolfram/license")
    expect(got.status).toBe(200)
    expect(await got.json()).toEqual({ state: "none" })
    expect((await status).args).toEqual({ action: "status" })

    const post = (body: unknown) =>
      alice.fetch("/api/compute/wolfram/license", { method: "POST", body: JSON.stringify(body) })
    expect((await post({ wolfram_id: "not an id", password: "x" })).status).toBe(422)
    expect((await post({ wolfram_id: "alice@umd.edu", password: "" })).status).toBe(422)
    const activation = answer("wolfram_license", {
      state: "active",
      wolfram_id: "alice@umd.edu",
      activated_at: 1,
    })
    const activated = await post({ wolfram_id: " alice@umd.edu ", password: "correct horse" })
    expect(await activated.json()).toMatchObject({ state: "active" })
    expect((await activation).args).toEqual({
      action: "activate",
      wolfram_id: "alice@umd.edu",
      password: "correct horse",
    })
    const rows = await auditRows("login = 'alice' AND action = 'compute.wolfram_license'")
    expect(rows.map((r) => r.target)).toEqual(["activate"])
    expect(JSON.stringify(rows)).not.toContain("correct horse")

    const removal = answer("wolfram_license", { state: "none" })
    const removed = await alice.fetch("/api/compute/wolfram/license", { method: "DELETE" })
    expect(await removed.json()).toEqual({ state: "none" })
    expect((await removal).args).toEqual({ action: "remove" })
  })

  it("refuses a Wolfram run too big for one tunnel frame, counting bytes", async () => {
    const run = await alice.fetch("/api/compute/wolfram/run", {
      method: "POST",
      body: JSON.stringify({ code: "x", prelude: ["\u20ac".repeat(70_000)] }),
    })
    expect(run.status).toBe(413)
  })

  it("limits Wolfram license activations to a few an hour", async () => {
    for (let i = 0; i < 5; i++)
      await env.DB.prepare(
        `INSERT INTO audit_log (at, login, action, target)
         VALUES (?, 'mallory', 'compute.wolfram_license', 'activate')`,
      )
        .bind(Date.now())
        .run()
    const mallory = await memberAs("mallory")
    const tried = await mallory.fetch("/api/compute/wolfram/license", {
      method: "POST",
      body: JSON.stringify({ wolfram_id: "m@example.com", password: "guess" }),
    })
    expect(tried.status).toBe(429)
  })

  it("forks a published notebook as published:<path>, and nothing else", async () => {
    const fork = (source: unknown) =>
      alice.fetch("/api/compute/fork", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source }),
      })
    const pending = fork({ kind: "published", path: "code/wolfram-guide/EIWL3-01.nb" })
    const rpc = readJsonPayload<any>(
      await host.next((f) => f.type === FrameType.CONTROL && readJsonPayload<any>(f).op === "fork"),
    )
    expect(rpc.args).toEqual({ source: "published:code/wolfram-guide/EIWL3-01.nb" })
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
  const path = "/jupyter/user/alice/api/kernels/k1/channels?session_id=s1"
  // Opened by the lab page, so from the lab origin, with the ticket in the path.
  const open = (token: string, origin = ORIGIN, url = path) =>
    SELF.fetch(`${ORIGIN}/lab/${token}${url}`, {
      headers: { upgrade: "websocket", origin, "sec-websocket-protocol": PROTOCOL },
    })

  beforeAll(async () => {
    host = await connectHost()
    ticket = await issueLabTicket(
      workerEnv,
      { login: "alice", role: "member", exp: Math.floor(Date.now() / 1000) + 3600 },
      "alice",
    )
  })
  afterAll(() => host.ws.close())

  it("rejects a bad ticket, a foreign origin and another member's path", async () => {
    expect((await open("garbage.x")).status).toBe(401)
    expect((await open("garbage")).status).toBe(403) // not even ticket-shaped
    const session = await sign(
      { typ: "session", login: "alice", name: "a", role: "member", exp: Date.now() / 1000 + 60 },
      workerEnv.SESSION_SECRET,
    )
    expect((await open(session)).status).toBe(401) // a session token is not a ticket
    expect((await open(ticket, "https://evil.example")).status).toBe(403)
    expect(
      (await open(ticket, ORIGIN, "/jupyter/user/bob/api/kernels/k1/channels?x=1")).status,
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

  it("audits an owner's socket into another member's server", async () => {
    const owner = await issueLabTicket(
      workerEnv,
      { login: "boss", role: "owner", exp: Math.floor(Date.now() / 1000) + 3600 },
      "alice",
    )
    const ctx = createExecutionContext()
    const pending = (worker as ExportedHandler).fetch!(
      new Request(`${ORIGIN}/lab/${owner}${path}`, {
        headers: { upgrade: "websocket", origin: ORIGIN, "sec-websocket-protocol": PROTOCOL },
      }) as any,
      { ...workerEnv, COMPUTE_OWNER_ACCESS: "true" } as any,
      ctx,
    )
    const frame = await host.next(ofType(FrameType.OPEN_WS))
    host.send(jsonFrame(FrameType.WS_ACCEPT, frame.streamId, { protocol: PROTOCOL }))
    const ws = (await pending).webSocket!
    ws.accept()
    await waitOnExecutionContext(ctx)
    const rows = await auditRows("login = 'boss' AND action = 'compute.access_other'")
    expect(rows.map((r) => [r.target, JSON.parse(r.detail_json)])).toContainEqual([
      "alice",
      { websocket: "/jupyter/user/alice/api/kernels/k1/channels" },
    ])
    ws.close(1000, "done")
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

  it("ends a member's lab when they sign out: open sockets close, older tickets and bearers stop", async () => {
    const now = Math.floor(Date.now() / 1000)
    const session = async (exp: number) => {
      const token = await sign(
        { typ: "session", login: "lou", name: "Lou", role: "member", exp },
        workerEnv.SESSION_SECRET,
      )
      const ticket = await issueLabTicket(workerEnv, { login: "lou", role: "member", exp }, "lou")
      return { token, ticket }
    }
    // A session begun a minute ago, and its lab with a kernel open.
    const before = await session(now - 60 + SESSION_MAX_AGE)
    const kernel = "/jupyter/user/lou/api/kernels/k1/channels?session_id=s1"
    const pending = open(before.ticket, ORIGIN, kernel)
    const frame = await host.next(ofType(FrameType.OPEN_WS))
    host.send(jsonFrame(FrameType.WS_ACCEPT, frame.streamId, { protocol: null }))
    const ws = (await pending).webSocket!
    ws.accept()
    const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener("close", resolve))

    const signOut = await SELF.fetch(`${ORIGIN}/api/auth/logout`, {
      method: "POST",
      headers: { authorization: `Bearer ${before.token}`, origin: SITE },
    })
    expect(signOut.status).toBe(200)
    expect((await closed).code).toBe(1008)
    expect(readClose(await host.next(ofType(FrameType.WS_CLOSE, frame.streamId))).code).toBe(1008)

    // The old session is over everywhere: its bearer, its lab, the lab's Hafezi GPT.
    const asMember = (token: string, path: string) =>
      SELF.fetch(`${ORIGIN}${path}`, {
        headers: { authorization: `Bearer ${token}`, origin: SITE },
      })
    expect(await (await asMember(before.token, "/api/session")).json()).toEqual({ user: null })
    expect((await asMember(before.token, "/api/compute/status")).status).toBe(401)
    expect((await open(before.ticket, ORIGIN, kernel)).status).toBe(401)
    const page = `/lab/${before.ticket}/jupyter/user/lou/lab`
    expect((await SELF.fetch(ORIGIN + page, { redirect: "manual" })).status).toBe(401)
    const reload = await SELF.fetch(ORIGIN + page, {
      redirect: "manual",
      headers: { "sec-fetch-mode": "navigate" },
    })
    expect(reload.status).toBe(302)
    expect(reload.headers.get("location")).toBe(new URL("/scratchpad", SITE).toString())
    const gpt = `/lab/${before.ticket}/hafezi-gpt/api/gpt/tools`
    expect((await SELF.fetch(ORIGIN + gpt)).status).toBe(401)
    // …even after the relay forgets what it had in memory.
    const relay = workerEnv.COMPUTE_RELAY
    const inRelay = runInDurableObject as unknown as (
      stub: unknown,
      fn: (instance: any) => void,
    ) => Promise<void>
    await inRelay(relay.get(relay.idFromName(RELAY_NAME)), (instance) => instance.signedOut.clear())
    expect((await open(before.ticket, ORIGIN, kernel)).status).toBe(401)
    expect(host.frames.filter(ofType(FrameType.OPEN_WS))).toHaveLength(0)

    // Signing in again starts a session the sign-out doesn't touch. It begins after the sign-out,
    // which may already be a second later than `now`.
    const after = await session(Math.floor(Date.now() / 1000) + SESSION_MAX_AGE)
    expect((await (await asMember(after.token, "/api/session")).json()) as any).toMatchObject({
      user: { login: "lou" },
    })
    expect(
      (await SELF.fetch(`${ORIGIN}/lab/${after.ticket}/hafezi-gpt/api/gpt/tools`)).status,
    ).toBe(200)
    const reopened = open(after.ticket, ORIGIN, kernel)
    const again = await host.next(ofType(FrameType.OPEN_WS))
    host.send(jsonFrame(FrameType.WS_ACCEPT, again.streamId, { protocol: null }))
    const socket = (await reopened).webSocket!
    socket.accept()
    socket.close(1000, "done")
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

describe(
  "the lab origin: JupyterLab served by the Worker, keyed by a ticket in the path",
  {
    timeout: 30_000,
  },
  () => {
    let host: FakeHost
    let ticket: string
    const exp = () => Math.floor(Date.now() / 1000) + 3600
    const lab = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
      SELF.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init })

    beforeAll(async () => {
      host = await connectHost()
      ticket = await issueLabTicket(
        workerEnv,
        { login: "alice", role: "member", exp: exp() },
        "alice",
      )
    })
    afterAll(() => host.ws.close())

    it("relays the page with its prefix and site origin, framed only by the site", async () => {
      const pending = lab(`/lab/${ticket}/jupyter/user/alice/lab?reset`, {
        headers: { accept: "text/html" },
      })
      const open = await host.next(ofType(FrameType.OPEN_HTTP))
      const meta = readJsonPayload<any>(open)
      expect(meta).toMatchObject({
        method: "GET",
        target: "/jupyter/user/alice/lab?reset",
        base_prefix: `/lab/${ticket}`,
        site_origin: new URL(SITE).origin,
        ws_url: `wss://members.test/lab/${ticket}`,
        ticket: "",
      })
      expect(await verifyAssertion(meta.assertion, vectors.secret)).toMatchObject({
        login: "alice",
      })
      await respond(host, open.streamId, 200, [["content-type", "text/html"]], "<html>lab</html>")
      const response = await pending
      expect(response.status).toBe(200)
      expect(response.headers.get("content-security-policy")).toBe(labCsp(new URL(SITE).origin))
      expect(response.headers.get("x-frame-options")).toBeNull()
      expect(response.headers.get("referrer-policy")).toBe("same-origin")
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    })

    it("keeps the prefix on redirects, and vouches for unprefixed paths by the page's Referer", async () => {
      const pending = lab(`/lab/${ticket}/jupyter/user/alice/`)
      const open = await host.next(ofType(FrameType.OPEN_HTTP))
      await respond(host, open.streamId, 302, [["location", "/jupyter/user/alice/lab?x=1"]])
      const response = await pending
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`/lab/${ticket}/jupyter/user/alice/lab?x=1`)

      const logo = lab("/jupyter/user/alice/kernelspecs/python3/logo-64x64.png", {
        headers: { referer: `${ORIGIN}/lab/${ticket}/jupyter/user/alice/lab` },
      })
      const second = await host.next(ofType(FrameType.OPEN_HTTP))
      expect(readJsonPayload<any>(second).target).toBe(
        "/jupyter/user/alice/kernelspecs/python3/logo-64x64.png",
      )
      await respond(host, second.streamId, 200, [["content-type", "image/png"]], "png")
      expect((await logo).status).toBe(200)
    })

    it("refuses a missing, foreign or mismatched ticket and service workers", async () => {
      const other = await issueLabTicket(
        workerEnv,
        { login: "alice", role: "member", exp: exp() },
        "bob",
      )
      const session = await sign(
        { typ: "session", login: "alice", name: "a", role: "member", exp: exp() },
        workerEnv.SESSION_SECRET,
      )
      expect((await lab("/lab/garbage.x/jupyter/user/alice/lab")).status).toBe(401)
      expect((await lab(`/lab/${session}/jupyter/user/alice/lab`)).status).toBe(401)
      // A ticket opens its own server only (and a member may never open bob's).
      expect((await lab(`/lab/${ticket}/jupyter/user/bob/lab`)).status).toBe(403)
      expect((await lab(`/lab/${other}/jupyter/user/bob/lab`)).status).toBe(403)
      // No Referer, or one from another origin, vouches for nothing.
      expect((await lab("/jupyter/user/alice/api/contents")).status).toBe(401)
      const foreign = `https://evil.example/lab/${ticket}/jupyter/user/alice/lab`
      expect(
        (await lab("/jupyter/user/alice/api/contents", { headers: { referer: foreign } })).status,
      ).toBe(401)
      const sw = lab(`/lab/${ticket}/jupyter/user/alice/files/sw.js`, {
        headers: { "service-worker": "script" },
      })
      expect((await sw).status).toBe(403)
      // A person following an old link goes back to the Scratchpad.
      const stale = await lab("/lab/garbage.x/jupyter/user/alice/lab", {
        headers: { "sec-fetch-mode": "navigate" },
      })
      expect(stale.status).toBe(302)
      expect(stale.headers.get("location")).toBe(new URL("/scratchpad", SITE).toString())
      expect(host.frames.filter(ofType(FrameType.OPEN_HTTP))).toHaveLength(0)
    })

    it("opens WebSockets from the lab origin only, with the ticket in the path", async () => {
      const path = `/lab/${ticket}/jupyter/user/alice/api/kernels/k1/channels?session_id=s1`
      const ws = (origin: string) =>
        SELF.fetch(`${ORIGIN}${path}`, { headers: { upgrade: "websocket", origin } })
      expect((await ws(SITE)).status).toBe(403)
      const pending = ws(ORIGIN)
      const frame = await host.next(ofType(FrameType.OPEN_WS))
      const meta = readJsonPayload<any>(frame)
      expect(meta.target).toBe("/jupyter/user/alice/api/kernels/k1/channels?session_id=s1")
      expect(await verifyAssertion(meta.assertion, vectors.secret)).toMatchObject({
        login: "alice",
      })
      host.send(
        jsonFrame(FrameType.RESET, frame.streamId, { code: "refused", reason: "no kernel" }),
      )
      expect((await pending).status).toBe(502)
    })
  },
)

describe("the admin console's Code tab: a member's code, read-only", { timeout: 30_000 }, () => {
  let host: FakeHost
  const exp = () => Math.floor(Date.now() / 1000) + 3600
  const bearer = (login: string, role: "member" | "owner", extra: object = {}) =>
    sign(
      { typ: "session", login, name: login, role, exp: exp(), ...extra },
      workerEnv.SESSION_SECRET,
    )
  /** GET an admin route with `token`, owner access on (COMPUTE_OWNER_ACCESS) unless `access` is false. */
  const get = async (token: string, path: string, access = true) => {
    const ctx = createExecutionContext()
    const response = await (worker as ExportedHandler).fetch!(
      new Request(`${ORIGIN}${path}`, {
        headers: { authorization: `Bearer ${token}`, origin: SITE },
      }) as any,
      { ...env, ...(access ? { COMPUTE_OWNER_ACCESS: "true" } : {}) } as any,
      ctx,
    )
    await waitOnExecutionContext(ctx)
    return { status: response.status, body: (await response.json()) as any }
  }
  /** The host answers its next `op` with `result` (or an error), handing back what it was asked. */
  const answer = (op: string, result: unknown, error?: string) =>
    host
      .next((f) => f.type === FrameType.CONTROL && readJsonPayload<any>(f).op === op)
      .then((frame) => {
        const rpc = readJsonPayload<any>(frame)
        host.send(
          jsonFrame(FrameType.CONTROL_RESULT, 0, {
            rpc_id: rpc.rpc_id,
            ...(error ? { ok: false, error } : { ok: true, result }),
            done: true,
          }),
        )
        return rpc
      })
  const controls = () => host.frames.filter(ofType(FrameType.CONTROL))
  const codeRows = async (login: string) =>
    (
      await env.DB.prepare(
        "SELECT action, target, detail_json FROM audit_log WHERE login = ? AND action LIKE 'admin.compute.%' ORDER BY id",
      )
        .bind(login)
        .all()
    ).results as any[]

  beforeAll(async () => {
    host = await connectHost()
    await env.DB.prepare(
      "INSERT INTO admins (login, added_by, added_at) VALUES ('pat', 'ursula', ?)",
    )
      .bind(Date.now())
      .run()
  })
  afterAll(() => host?.ws.close())

  it("is closed to members, lab sessions and lab tickets", async () => {
    const quinn = await bearer("quinn", "member")
    const labSession = await bearer("ursula", "owner", { lab: true })
    const ticket = await issueLabTicket(
      workerEnv,
      { login: "ursula", role: "owner", exp: exp() },
      "ursula",
    )
    for (const path of ["/api/admin/compute/members", "/api/admin/compute/sessions?login=nell"]) {
      expect((await get(quinn, path)).status).toBe(403)
      expect((await get(labSession, path)).status).toBe(403)
      expect((await get(ticket, path)).status).toBe(401)
    }
    expect(controls()).toHaveLength(0)
  })

  it("lists members, the latest to use the Scratchpad first", async () => {
    const now = Date.now()
    const rows = [
      ["nell", "auth.login", now - 5000],
      ["nell", "compute.start", now - 4000],
      ["omar", "auth.login", now - 3000],
      ["pia", "compute.start", now - 1000],
    ] as const
    for (const [login, action, at] of rows)
      await env.DB.prepare("INSERT INTO audit_log (at, login, action) VALUES (?, ?, ?)")
        .bind(at, login, action)
        .run()
    const ursula = await bearer("ursula", "owner")
    const { status, body } = await get(ursula, "/api/admin/compute/members")
    expect(status).toBe(200)
    const logins = body.members.map((m: any) => m.login)
    expect(logins.indexOf("pia")).toBeLessThan(logins.indexOf("nell"))
    expect(logins.indexOf("nell")).toBeLessThan(logins.indexOf("omar"))
    expect(body.members.find((m: any) => m.login === "nell")).toMatchObject({
      last_start: now - 4000,
      last_login: now - 5000,
    })
    expect(body.access).toBe(true)
    expect((await get(ursula, "/api/admin/compute/members", false)).body.access).toBe(false)
  })

  it("reads a member's live sessions for any admin, naming the member, and records it", async () => {
    const pat = await bearer("pat", "member") // promoted, not an org owner
    const live = {
      login: "nell",
      server: "running",
      status: { started: "2026-09-29T19:00:00Z", last_activity: null, connections: 1, kernels: 1 },
      sessions: [{ id: "s1", path: "rings.ipynb", name: "rings.ipynb", type: "notebook" }],
      kernels: [{ id: "k1", name: "hafezi-base", execution_state: "idle" }],
      terminals: [],
    }
    const asked = answer("admin_sessions", live)
    const { status, body } = await get(pat, "/api/admin/compute/sessions?login=Nell")
    expect(status).toBe(200)
    expect(body).toEqual(live)
    const rpc = await asked
    expect(rpc.args).toEqual({ login: "nell" })
    expect(await verifyAssertion(rpc.assertion, vectors.secret)).toMatchObject({
      login: "pat",
      role: "member",
      admin_read: "nell",
    })
    expect(await codeRows("pat")).toEqual([
      { action: "admin.compute.sessions", target: "nell", detail_json: null },
    ])
    // What the host refuses reaches the admin as its reason.
    const refused = answer(
      "admin_sessions",
      null,
      "reading members' code is off on the compute host",
    )
    const off = await get(pat, "/api/admin/compute/sessions?login=nell")
    await refused
    expect(off.status).toBe(502)
    expect(off.body.detail).toBe("reading members' code is off on the compute host")
  })

  it("reads IPython, shell and file history and a commit's diff, and records each read", async () => {
    const ursula = await bearer("ursula", "owner")
    const cases = [
      [
        "ipython",
        "limit=50&since=1790000000999&before=49:2",
        { limit: 50, since: 1790000000, before: "49:2" },
      ],
      ["bash", "before=1234&limit=500", { limit: 500, before: 1234 }],
      ["files", "offset=50&limit=25", { limit: 25, offset: 50 }],
      ["files", "", {}],
    ] as const
    for (const [view, query, args] of cases) {
      const asked = answer(`admin_${view}`, { login: "nell", entries: [] })
      const { status, body } = await get(ursula, `/api/admin/compute/${view}?login=nell&${query}`)
      expect(status).toBe(200)
      expect(body).toEqual({ login: "nell", entries: [] })
      const rpc = await asked
      expect(rpc.args).toEqual({ ...args, login: "nell" })
      expect(await verifyAssertion(rpc.assertion, vectors.secret)).toMatchObject({
        login: "ursula",
        role: "owner",
        admin_read: "nell",
      })
    }
    const rev = "0123456789abcdef0123456789abcdef01234567"
    const diff = answer("admin_diff", { login: "nell", rev, diff: "diff --git a/x b/x" })
    const shown = await get(ursula, `/api/admin/compute/files/${rev}?login=nell`)
    expect(shown.body.diff).toBe("diff --git a/x b/x")
    expect((await diff).args).toEqual({ rev, login: "nell" })
    const rows = (await codeRows("ursula")).map((row) => [
      row.action,
      row.target,
      JSON.parse(row.detail_json ?? "null"),
    ])
    expect(rows).toEqual([
      ["admin.compute.ipython", "nell", { limit: 50, since: 1790000000, before: "49:2" }],
      ["admin.compute.bash", "nell", { limit: 500, before: 1234 }],
      ["admin.compute.files", "nell", { limit: 25, offset: 50 }],
      ["admin.compute.files", "nell", null],
      ["admin.compute.files", "nell", { rev }],
    ])
  })

  it("refuses paging the host wouldn't take, before asking it", async () => {
    const pat = await bearer("pat", "member")
    for (const query of [
      "ipython?login=nell&limit=0",
      "ipython?login=nell&limit=501",
      "ipython?login=nell&before=49",
      "ipython?login=nell&since=yesterday",
      "bash?login=nell&before=-1",
      "bash?login=nell&before=1.5",
      "files?login=nell&limit=101",
      "files?login=nell&offset=-1",
      "files?login=../nell",
    ])
      expect((await get(pat, `/api/admin/compute/${query}`)).status, query).toBe(422)
    for (const rev of [
      "HEAD",
      "0123",
      "0123456789ABCDEF",
      "0123456789abcdef0123456789abcdef012345678",
    ])
      expect((await get(pat, `/api/admin/compute/files/${rev}?login=nell`)).status, rev).toBe(404)
    expect((await get(pat, "/api/admin/compute/bash?login=nell", false)).status).toBe(403)
    expect(controls()).toHaveLength(0)
  })

  it("refuses a bad login, or owner access off, before asking the host or recording", async () => {
    const vera = await bearer("vera", "owner")
    expect((await get(vera, "/api/admin/compute/sessions?login=../x")).status).toBe(422)
    expect((await get(vera, "/api/admin/compute/sessions")).status).toBe(422)
    const off = await get(vera, "/api/admin/compute/sessions?login=nell", false)
    expect(off.status).toBe(403)
    expect(off.body.detail).toContain("COMPUTE_OWNER_ACCESS")
    expect(controls()).toHaveLength(0)
    expect(await codeRows("vera")).toEqual([])
  })
})
