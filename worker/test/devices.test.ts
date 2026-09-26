import { SELF, env, runInDurableObject } from "cloudflare:test"
import { beforeAll, describe, expect, it } from "vitest"
import { sign } from "../src/session"
import { ORIGIN, SITE, member } from "./helpers"

// A raw agent call: device-key bearer.
const agent = (path: string, key: string | null, body?: unknown) =>
  SELF.fetch(ORIGIN + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

// A member (non-owner) bearer token, signed with the test SESSION_SECRET.
async function memberSession() {
  const session = {
    typ: "session",
    login: "member1",
    name: "Member One",
    role: "member" as const,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  return await sign(session, (env as any).SESSION_SECRET)
}

async function createDevice(code: string) {
  const owner = await member()
  const { status, body } = await owner.json("/api/devices", {
    method: "POST",
    body: JSON.stringify({ code_name: code }),
  })
  expect(status).toBe(201)
  return body as { code_name: string; enrollment_token: string }
}

describe("device enrollment", () => {
  it("issues a one-time token an agent exchanges for a device key", async () => {
    const { code_name, enrollment_token } = await createDevice("bec-main")
    expect(code_name).toBe("bec-main")

    const first = await agent("/api/agent/enroll", null, {
      enrollment_token,
      platform: "windows-x64",
    })
    expect(first.status).toBe(200)
    const { device_id, device_key } = (await first.json()) as {
      device_id: string
      device_key: string
    }
    expect(device_id).toBe("bec-main")
    expect(device_key.length).toBeGreaterThan(20)

    // single-use
    const again = await agent("/api/agent/enroll", null, { enrollment_token })
    expect(again.status).toBe(401)
  })

  it("rejects a bad or missing device key", async () => {
    expect((await agent("/api/agent/instruments", null, [])).status).toBe(401)
    expect((await agent("/api/agent/instruments", "not-a-real-key", [])).status).toBe(401)
  })

  it("refuses a duplicate code_name once the device is enrolled", async () => {
    const { enrollment_token } = await createDevice("dup-pc")
    await agent("/api/agent/enroll", null, { enrollment_token })
    const owner = await member()
    const { status } = await owner.json("/api/devices", {
      method: "POST",
      body: JSON.stringify({ code_name: "dup-pc" }),
    })
    expect(status).toBe(409)
  })

  it("re-issues a token for a never-enrolled device and kills the old one", async () => {
    const first = await createDevice("slow-pc")
    const second = await createDevice("slow-pc")
    expect(second.enrollment_token).not.toBe(first.enrollment_token)
    expect((await agent("/api/agent/enroll", null, { enrollment_token: first.enrollment_token })).status).toBe(401)
    expect((await agent("/api/agent/enroll", null, { enrollment_token: second.enrollment_token })).status).toBe(200)
  })

  it("lets a revoked code_name be enrolled again", async () => {
    const { enrollment_token } = await createDevice("reborn-pc")
    const enrolled = await agent("/api/agent/enroll", null, { enrollment_token })
    const { device_key } = (await enrolled.json()) as { device_key: string }
    const owner = await member()
    expect((await owner.fetch("/api/devices/reborn-pc", { method: "DELETE" })).status).toBe(200)
    const again = await createDevice("reborn-pc")
    expect((await agent("/api/agent/enroll", null, { enrollment_token: again.enrollment_token })).status).toBe(200)
    // the old key stays dead
    expect((await agent("/api/agent/instruments", device_key, [])).status).toBe(401)
    const { body } = await owner.json("/api/devices")
    const row = (body as Array<Record<string, unknown>>).find((d) => d.code_name === "reborn-pc")!
    expect(row.enrolled).toBe(true)
  })

  it("forbids a non-owner from creating a device", async () => {
    const token = await memberSession()
    const res = await SELF.fetch(`${ORIGIN}/api/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: SITE, "content-type": "application/json" },
      body: JSON.stringify({ code_name: "sneaky" }),
    })
    expect(res.status).toBe(403)
  })
})

describe("instrument declaration and status", () => {
  let key: string
  const code = "lab-pc-1"

  beforeAll(async () => {
    const { enrollment_token } = await createDevice(code)
    const res = await agent("/api/agent/enroll", null, { enrollment_token })
    key = ((await res.json()) as { device_key: string }).device_key
  })

  it("declares a port-aware instrument set the member API reads back", async () => {
    const decl = [
      {
        local_id: "keithley-2450-1",
        title: "Keithley 2450 #1",
        model: "2450",
        driver: "keithley_2450",
        address_kind: "USB",
        capabilities: ["readable", "settable", "switchable"],
        metrics: ["voltage_v", "current_a"],
        ports: [
          { id: "force_hi", label: "Force HI", direction: "source" },
          { id: "sense_hi", label: "Sense HI", direction: "measure" },
        ],
      },
    ]
    const declared = await agent("/api/agent/instruments", key, decl)
    expect(declared.status).toBe(200)

    const owner = await member()
    const { status, body } = await owner.json(`/api/devices/${code}/instruments`)
    expect(status).toBe(200)
    expect(body).toHaveLength(1)
    expect(body[0].local_id).toBe("keithley-2450-1")
    expect(body[0].capabilities).toContain("settable")
    expect(body[0].ports).toHaveLength(2)
    expect(body[0].status).toBe("unpolled")
  })

  it("reflects a heartbeat's status", async () => {
    await agent("/api/agent/heartbeat", key, {
      ts_ns: "1789000000000000000",
      statuses: { "keithley-2450-1": "online" },
    })
    const owner = await member()
    const { body } = await owner.json(`/api/devices/${code}/instruments`)
    expect(body[0].status).toBe("online")
  })

  it("lists the device in the overview", async () => {
    const owner = await member()
    const { body } = await owner.json("/api/devices")
    const found = (body as any[]).find((d) => d.code_name === code)
    expect(found).toBeTruthy()
    expect(found.enrolled).toBe(true)
    expect(found.instrument_count).toBe(1)
  })
})

describe("live plane: readings, SSE, commands, experiments", () => {
  let key: string
  const code = "stream-pc"

  beforeAll(async () => {
    const { enrollment_token } = await createDevice(code)
    key = (
      (await (await agent("/api/agent/enroll", null, { enrollment_token })).json()) as {
        device_key: string
      }
    ).device_key
    await agent("/api/agent/instruments", key, [
      { local_id: "sim-1", title: "Sim 1", driver: "simulated", metrics: ["signal"], ports: [] },
    ])
  })

  const hub = () => env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(code))

  it("routes readings through the DeviceHub and coalesces them into D1 on flush", async () => {
    const posted = await agent("/api/agent/readings", key, {
      readings: [
        { local_id: "sim-1", metric: "signal", value: 1.5, ts_ns: "1789000000000000001" },
        { local_id: "sim-1", metric: "signal", value: 2.5, ts_ns: "1789000000000000002" },
      ],
    })
    expect(posted.status).toBe(202)

    // The hot path never touches D1: force the coalescing flush white-box.
    await (runInDurableObject as any)(hub(), (instance: any) => instance.flush())

    const owner = await member()
    const { body } = await owner.json(`/api/devices/${code}/instruments`)
    const inst = (body as any[]).find((i) => i.local_id === "sim-1")
    expect(inst.latest.signal.value).toBe(2.5) // last point wins in reading_latest

    const { body: detail } = await owner.json(`/api/devices/${code}/instruments/sim-1`)
    expect(detail.history.length).toBe(2)
    expect(detail.history[0].value).toBe(1.5)
  })

  it("preserves non-finite readings as text", async () => {
    await agent("/api/agent/readings", key, {
      readings: [
        { local_id: "sim-1", metric: "noise", value: "NaN", ts_ns: "1789000000000000003" },
      ],
    })
    await (runInDurableObject as any)(hub(), (instance: any) => instance.flush())
    const owner = await member()
    const { body: detail } = await owner.json(`/api/devices/${code}/instruments/sim-1`)
    expect(detail.latest.noise.value).toBe("NaN")
  })

  it("fans out live readings over SSE", async () => {
    const owner = await member()
    const res = await owner.fetch(`/api/devices/${code}/stream`)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    const hello = decoder.decode((await reader.read()).value)
    expect(hello).toContain("event: hello")

    await agent("/api/agent/readings", key, {
      readings: [{ local_id: "sim-1", metric: "signal", value: 9.9, ts_ns: "1789000000000000009" }],
    })

    let buf = ""
    for (let i = 0; i < 6 && !buf.includes("event: readings"); i++)
      buf += decoder.decode((await reader.read()).value)
    expect(buf).toContain("event: readings")
    expect(buf).toContain("9.9")
    await reader.cancel()
  })

  it("enqueues a member command as a durable audit row", async () => {
    const owner = await member()
    const { status, body } = await owner.json(`/api/devices/${code}/commands`, {
      method: "POST",
      body: JSON.stringify({ kind: "poll", args: { local_id: "sim-1" } }),
    })
    expect(status).toBe(202)
    expect(body.delivered).toBe(false) // no agent WebSocket connected in this test

    const { body: list } = await owner.json(`/api/devices/${code}/commands`)
    const cmd = (list as any[]).find((c) => c.kind === "poll")
    expect(cmd).toBeTruthy()
    expect(cmd.status).toBe("queued")
  })

  it("delivers a command over the agent WebSocket and relays its result", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/agent/command-channel`, {
      headers: { authorization: `Bearer ${key}`, upgrade: "websocket" },
    })
    expect(res.status).toBe(101)
    const ws = res.webSocket!
    ws.accept()
    // Any command queued earlier (while no agent was connected) is flushed on connect; wait for the
    // specific reconfigure we enqueue below.
    const reconfigured = new Promise<any>((resolve) =>
      ws.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data as string)
        if (frame.type === "command" && frame.command.kind === "reconfigure") resolve(frame)
      }),
    )

    const owner = await member()
    const { body } = await owner.json(`/api/devices/${code}/commands`, {
      method: "POST",
      body: JSON.stringify({ kind: "reconfigure", args: { interval_s: 5 } }),
    })
    expect(body.delivered).toBe(true)

    const frame = await reconfigured
    ws.send(
      JSON.stringify({
        type: "result",
        command_id: frame.command.id,
        status: "ok",
        result: { applied: true },
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))

    const { body: cmds } = await owner.json(`/api/devices/${code}/commands`)
    const done = (cmds as any[]).find((c) => c.id === frame.command.id)
    expect(done.status).toBe("done")
    expect(done.result.applied).toBe(true)
    ws.close()
  })

  it("rejects an unknown command kind", async () => {
    const owner = await member()
    const { status } = await owner.json(`/api/devices/${code}/commands`, {
      method: "POST",
      body: JSON.stringify({ kind: "rm -rf" }),
    })
    expect(status).toBe(422)
  })

  it("generates a control script offline and dispatches experiment.start", async () => {
    const owner = await member()
    const spec = {
      experiment_label: "iv-sweep",
      experiment_prompt: "sweep the source voltage and measure current",
      selected_instruments: [
        { device: code, local_id: "sim-1", family: "Keithley2450", ports: ["force_hi"] },
      ],
      duts: [{ name: "dut1", ports: ["a", "b"] }],
      netlist: [{ from: "sim-1.force_hi", to: "dut1.a" }],
      points: 5,
    }
    const { status, body } = await owner.json(`/api/devices/${code}/experiments`, {
      method: "POST",
      body: JSON.stringify(spec),
    })
    expect(status).toBe(202)
    expect(body.status).toBe("running")

    const id = body.experiment_id as string
    const { body: exp } = await owner.json(`/api/experiments/${id}`)
    expect(exp.status).toBe("running")
    expect(exp.script).toContain("finally")
    expect(exp.script).toContain("csv")
    expect(exp.spec.experiment_label).toBe("iv-sweep")

    const { body: cmds } = await owner.json(`/api/devices/${code}/commands`)
    expect((cmds as any[]).some((c) => c.kind === "experiment.start")).toBe(true)

    const { body: exps } = await owner.json(`/api/devices/${code}/experiments`)
    expect((exps as any[]).some((e) => e.id === id)).toBe(true)

    // Stop it.
    const { status: stopStatus } = await owner.json(`/api/devices/${code}/experiments/${id}/stop`, {
      method: "POST",
    })
    expect(stopStatus).toBe(202)
    const { body: stopped } = await owner.json(`/api/experiments/${id}`)
    expect(stopped.status).toBe("stopped")
  })

  it("lets the device itself submit a Setup.json with its device key (the desktop builder)", async () => {
    const spec = {
      experiment_label: "desk-sweep",
      experiment_prompt: "sweep the source and measure the response",
      selected_instruments: [
        { device: code, local_id: "sim-1", family: "Keithley2450", ports: ["force_hi"] },
      ],
      duts: [{ name: "dut1", ports: ["a"] }],
      netlist: [{ from: "sim-1.force_hi", to: "dut1.a" }],
      available_endpoints: ["sim-1.force_hi", "dut1.a", "GROUND", "NO_CONNECTION"],
      data_output_format: { format: "csv", guide: "one point per row" },
      plot_formats: ["line"],
      points: 3,
    }
    const res = await agent("/api/agent/experiments", key, spec)
    expect(res.status).toBe(202)
    const body = (await res.json()) as { experiment_id: string; status: string }
    expect(body.status).toBe("running")

    // It lands on the key's own device, attributed to the device, and is dispatched like any other.
    const owner = await member()
    const { body: exp } = await owner.json(`/api/experiments/${body.experiment_id}`)
    expect(exp.status).toBe("running")
    expect(exp.spec.plot_formats).toEqual(["line"])
    const { body: exps } = await owner.json(`/api/devices/${code}/experiments`)
    expect((exps as any[]).some((e) => e.id === body.experiment_id)).toBe(true)

    // No key, no experiment; a bad spec is still a 422.
    expect((await agent("/api/agent/experiments", null, spec)).status).toBe(401)
    expect((await agent("/api/agent/experiments", key, { selected_instruments: [] })).status).toBe(
      422,
    )
  })

  it("refuses an experiment with no instruments", async () => {
    const owner = await member()
    const { status } = await owner.json(`/api/devices/${code}/experiments`, {
      method: "POST",
      body: JSON.stringify({ experiment_label: "empty", selected_instruments: [] }),
    })
    expect(status).toBe(422)
  })
})

describe("catalog", () => {
  it("serves the seeded instrument families", async () => {
    const owner = await member()
    const { status, body } = await owner.json("/api/catalog")
    expect(status).toBe(200)
    const families = (body as any[]).map((f) => f.family)
    expect(families).toContain("Keithley2450")
    expect(families).toContain("ZurichMFLI")
    const mfli = (body as any[]).find((f) => f.family === "ZurichMFLI")
    expect(mfli.capabilities.trace).toBe(true)
    expect(mfli.ports.length).toBeGreaterThan(5)
  })
})

describe("server-side liveness", () => {
  const code = "live-pc"
  let key: string

  beforeAll(async () => {
    const { enrollment_token } = await createDevice(code)
    await createDevice("never-enrolled")
    const res = await agent("/api/agent/enroll", null, { enrollment_token })
    key = ((await res.json()) as { device_key: string }).device_key
    await agent("/api/agent/instruments", key, [
      {
        local_id: "sim-1",
        title: "Sim",
        model: "sim",
        driver: "simulated",
        address_kind: "null",
        capabilities: ["readable"],
        metrics: ["v"],
        ports: [],
      },
    ])
  })

  const listed = async (c: string) => {
    const owner = await member()
    const { body } = await owner.json("/api/devices")
    return (body as Array<Record<string, unknown>>).find((d) => d.code_name === c)!
  }

  it("reports pending before enrolment", async () => {
    const d = await listed("never-enrolled")
    expect(d.liveness).toBe("pending")
    expect(d.last_seen_age_ms).toBeNull()
    expect(d.instruments_online).toBe(0)
  })

  it("stamps the heartbeat with the server clock, so a 1 h-skewed agent still reads online", async () => {
    const skewed = (BigInt(Date.now() - 3_600_000) * 1_000_000n).toString()
    const hb = await agent("/api/agent/heartbeat", key, {
      ts_ns: skewed,
      statuses: { "sim-1": "online" },
    })
    expect(hb.status).toBeLessThan(300)
    const d = await listed(code)
    expect(d.liveness).toBe("online")
    expect(d.last_seen_age_ms as number).toBeLessThan(10_000)
    expect(d.instruments_online).toBe(1)

    const owner = await member()
    const one = await owner.json(`/api/devices/${code}`)
    expect((one.body as Record<string, unknown>).liveness).toBe("online")
    const inst = await owner.json(`/api/devices/${code}/instruments`)
    expect((inst.body as Array<Record<string, unknown>>)[0].effective_status).toBe("online")
  })

  it("forces instruments offline once the device goes quiet", async () => {
    const old = (BigInt(Date.now() - 400_000) * 1_000_000n).toString()
    await env.DB.prepare("UPDATE devices SET last_seen_ns = ? WHERE code_name = ?")
      .bind(old, code)
      .run()
    const d = await listed(code)
    expect(d.liveness).toBe("offline")
    const owner = await member()
    const inst = await owner.json(`/api/devices/${code}/instruments`)
    const row = (inst.body as Array<Record<string, unknown>>)[0]
    expect(row.status).toBe("online")
    expect(row.effective_status).toBe("offline")
    const detail = await owner.json(`/api/devices/${code}/instruments/sim-1`)
    expect((detail.body as Record<string, unknown>).effective_status).toBe("offline")
  })
})
