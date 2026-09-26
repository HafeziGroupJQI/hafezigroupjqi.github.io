import type { Env } from "../env"
import { HttpError, json, readJson } from "../http"
import { generateAndDispatch } from "./experiments"
import { hubAgentWs, hubIngest } from "./hub-client"
import { hashSecret, newSecret } from "./keys"
import { parseEnroll, parseHeartbeat, parseInstrumentSet, parseLogs, parseReadings } from "./model"
import { DevicesStore } from "./store"

// Agent → Worker ingest. Device-key authenticated (Authorization: Bearer <device-key>), except
// enroll, which authenticates with a one-time enrollment token. No cookies, no CSRF: this is a
// machine caller, not a browser, so it is dispatched before the session gate in app.ts.

const PREFIX = "/api/agent/"

async function requireDevice(request: Request, store: DevicesStore): Promise<string> {
  const header = request.headers.get("authorization") ?? ""
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) throw new HttpError(401, "device key required")
  const device = await store.deviceByKeyHash(await hashSecret(match[1].trim()))
  if (!device) throw new HttpError(401, "unknown or revoked device key")
  return device.code_name
}

export async function agentRoutes(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (!url.pathname.startsWith(PREFIX)) return null
  const target = url.pathname.slice(PREFIX.length)
  const store = new DevicesStore(env.DB)

  if (target === "enroll") {
    if (request.method !== "POST") throw new HttpError(405, "method not allowed")
    const req = parseEnroll(await readJson(request))
    const codeName = await store.consumeEnrollmentToken(await hashSecret(req.enrollment_token))
    if (!codeName) throw new HttpError(401, "invalid or expired enrollment token")
    const key = newSecret()
    await store.completeEnrollment(codeName, await hashSecret(key), {
      hostname: req.hostname,
      platform: req.platform,
      agent_version: req.agent_version,
    })
    return json({ device_id: codeName, device_key: key })
  }

  // Everything below requires the device key.
  const codeName = await requireDevice(request, store)

  // The command channel: one persistent WebSocket the agent holds to its DeviceHub. Enqueued
  // commands wake the hibernated DO and deliver instantly; results return on the same socket.
  if (target === "command-channel") {
    if (request.headers.get("upgrade") !== "websocket")
      throw new HttpError(426, "expected websocket upgrade")
    return hubAgentWs(env, codeName, request)
  }

  if (request.method !== "POST") throw new HttpError(405, "method not allowed")

  switch (target) {
    case "instruments": {
      const list = parseInstrumentSet(await readJson(request))
      await store.setInstruments(codeName, list)
      await store.touchDevice(codeName)
      return json({ ok: true, count: list.length })
    }
    case "heartbeat": {
      const hb = parseHeartbeat(await readJson(request))
      await store.recordHeartbeat(codeName, hb.ts_ns, hb.statuses)
      return json({ ok: true })
    }
    case "readings": {
      // The live firehose: fan out through the DeviceHub DO (real-time SSE) which coalesces the
      // points into bounded D1 writes on its flush alarm. D1 is never touched on this hot path.
      const readings = parseReadings(await readJson(request))
      await hubIngest(env, codeName, { readings })
      return json({ ok: true, accepted: readings.length }, 202)
    }
    case "logs": {
      const logs = parseLogs(await readJson(request))
      await hubIngest(env, codeName, { logs })
      return json({ ok: true, accepted: logs.length }, 202)
    }
    case "experiments": {
      // The desktop cockpit on the lab PC submits a Setup.json for itself. A device has no member
      // cookie, so this is the device-key twin of POST /api/devices/:code/experiments: the same
      // generation, validation and experiment.start dispatch, scoped by the key to this device only.
      return json(
        await generateAndDispatch(
          env,
          store,
          codeName,
          await readJson(request),
          `device:${codeName}`,
        ),
        202,
      )
    }
    default:
      throw new HttpError(404, "not found")
  }
}
