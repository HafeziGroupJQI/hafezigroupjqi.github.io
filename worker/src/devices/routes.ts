import type { Auditor } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, decodeSegment, json, readJson } from "../http"
import type { Session } from "../session"
import { generateAndDispatch, stopExperiment } from "./experiments"
import { hubEnqueue, hubStream } from "./hub-client"
import { hashSecret, newSecret, normalizeCodeName } from "./keys"
import { ageMs, effectiveStatus, liveness } from "./liveness"
import { DevicesStore } from "./store"

// Member → Worker. Bearer session; writes pass requireMutation (origin allow-list). Any member may
// register or revoke a lab PC; both are audited. Returns null when it does not own the path so
// app.ts can fall through.

const COMMAND_KINDS = new Set(["poll", "reconfigure", "experiment.stop"])

export async function deviceRoutes(
  request: Request,
  url: URL,
  env: Env,
  session: Session,
  record: Auditor,
): Promise<Response | null> {
  const store = new DevicesStore(env.DB)

  if (url.pathname === "/api/catalog") {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed")
    return json(await store.listCatalog())
  }

  // Experiment detail routes are keyed by experiment id, not device code.
  const exp = url.pathname.match(/^\/api\/experiments\/([^/]+)(?:\/(datasets))?$/)
  if (exp) {
    if (request.method !== "GET") throw new HttpError(405, "method not allowed")
    const id = decodeSegment(exp[1])
    const experiment = await store.getExperiment(id)
    if (!experiment) throw new HttpError(404, "experiment not found")
    if (exp[2] === "datasets") return json(await store.listDatasets(id))
    return json(experiment)
  }

  if (url.pathname === "/api/devices") {
    if (request.method === "GET") return json(await store.listDevices())
    if (request.method === "POST") {
      requireMutation(request, env)
      const body = (await readJson(request)) as { code_name?: unknown }
      const codeName = normalizeCodeName(body.code_name)
      await store.createDevice(codeName, session.login)
      const token = newSecret()
      await store.issueEnrollmentToken(codeName, await hashSecret(token), session.login)
      record("device.create", codeName)
      // The plaintext token is shown once; only its hash is stored.
      return json({ code_name: codeName, enrollment_token: token }, 201)
    }
    throw new HttpError(405, "method not allowed")
  }

  const match = url.pathname.match(/^\/api\/devices\/([^/]+)(?:\/(.*))?$/)
  if (!match) return null
  const code = decodeSegment(match[1])
  const rest = match[2] ?? ""

  // ---- reads (GET) ----
  if (request.method === "GET") {
    if (rest === "") {
      const d = await store.getDevice(code)
      const now = Date.now()
      return json({
        code_name: d.code_name,
        hostname: d.hostname,
        platform: d.platform,
        agent_version: d.agent_version,
        enrolled: d.enrolled_at != null,
        enrolled_at: d.enrolled_at,
        last_seen_ns: d.last_seen_ns,
        last_seen_age_ms: ageMs(d.last_seen_ns, now),
        liveness: liveness(d.last_seen_ns, d.enrolled_at != null, now),
      })
    }
    if (rest === "instruments") {
      const d = await store.getDevice(code)
      const live = liveness(d.last_seen_ns, d.enrolled_at != null, Date.now())
      const rows = await store.instrumentsWithLatest(code)
      return json(rows.map((r) => ({ ...r, effective_status: effectiveStatus(r.status, live) })))
    }
    const instMatch = rest.match(/^instruments\/([^/]+)$/)
    if (instMatch) {
      const d = await store.getDevice(code)
      const live = liveness(d.last_seen_ns, d.enrolled_at != null, Date.now())
      const inst = await store.instrumentDetail(code, decodeSegment(instMatch[1]))
      return json({ ...inst, effective_status: effectiveStatus(inst.status, live) })
    }
    if (rest === "stream") {
      await store.getDevice(code)
      // The DeviceHub returns the SSE stream; app.ts wraps it with private headers.
      return hubStream(env, code)
    }
    if (rest === "commands") {
      await store.getDevice(code)
      return json(await store.listCommands(code))
    }
    if (rest === "experiments") {
      await store.getDevice(code)
      return json(await store.listExperiments(code))
    }
    throw new HttpError(404, "not found")
  }

  // ---- writes: same-origin + CSRF ----
  requireMutation(request, env)

  if (request.method === "DELETE" && rest === "") {
    await store.revokeDevice(code)
    record("device.revoke", code)
    return json({ revoked: true })
  }

  if (request.method === "POST" && rest === "commands") {
    await store.getDevice(code)
    const body = (await readJson(request)) as { kind?: unknown; args?: unknown }
    const kind = typeof body.kind === "string" ? body.kind : ""
    if (!COMMAND_KINDS.has(kind)) throw new HttpError(422, "unknown command kind")
    const { id, created_ns } = await store.createCommand(code, kind, body.args, session.login)
    const { delivered } = await hubEnqueue(env, code, {
      id,
      kind,
      args: body.args ?? {},
      created_ns,
    })
    return json({ id, delivered }, 202)
  }

  if (request.method === "POST" && rest === "experiments") {
    await store.getDevice(code)
    return json(
      await generateAndDispatch(env, store, code, await readJson(request), session.login),
      202,
    )
  }

  if (request.method === "POST" && rest.match(/^experiments\/([^/]+)\/stop$/)) {
    const id = decodeSegment(rest.match(/^experiments\/([^/]+)\/stop$/)![1])
    await store.getDevice(code)
    return json(await stopExperiment(env, store, code, id, session.login), 202)
  }

  throw new HttpError(405, "method not allowed")
}
