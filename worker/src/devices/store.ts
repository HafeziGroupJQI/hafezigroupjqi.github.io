import { HttpError } from "../http"
import { ageMs, type Liveness, liveness } from "./liveness"
import type { InstrumentDecl } from "./model"

// ns timestamp as a string so full 64-bit nanosecond precision survives into SQLite (a JS number
// cannot hold ns-since-epoch without loss). SQLite's INTEGER affinity stores the numeric string
// losslessly; ordering is done in SQL. Display precision on read-back is not relied upon.
export const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString()
const nowMs = () => Date.now()

export interface DeviceRow {
  code_name: string
  key_hash: string | null
  hostname: string | null
  platform: string | null
  agent_version: string | null
  created_by: string
  created_at: number
  enrolled_at: number | null
  last_seen_ns: number | null
  revoked: number
}

export interface CatalogRow {
  family: string
  display_name: string | null
  description: string | null
  ports: string
  capabilities: string
  examples: string
}

const ENROLL_TTL_MS = 15 * 60 * 1000

export class DevicesStore {
  constructor(private db: D1Database) {}

  // ---- devices ----

  /**
   * Create a device, or re-arm one that has no live key: a never-enrolled device (its token
   * expired or was lost) or a revoked one is reset so a fresh enrolment token can be issued.
   * Only an enrolled, un-revoked device is a conflict.
   */
  async createDevice(codeName: string, owner: string): Promise<void> {
    const existing = await this.db
      .prepare("SELECT enrolled_at, revoked FROM devices WHERE code_name = ?")
      .bind(codeName)
      .first<{ enrolled_at: number | null; revoked: number }>()
    if (!existing) {
      await this.db
        .prepare("INSERT INTO devices (code_name, created_by, created_at) VALUES (?, ?, ?)")
        .bind(codeName, owner, nowMs())
        .run()
      return
    }
    if (existing.enrolled_at != null && !existing.revoked)
      throw new HttpError(409, `device ${codeName} is already enrolled; revoke it first`)
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE devices SET revoked = 0, key_hash = NULL, enrolled_at = NULL, last_seen_ns = NULL,
             created_by = ?, created_at = ? WHERE code_name = ?`,
        )
        .bind(owner, nowMs(), codeName),
      // Outstanding tokens for the old incarnation die with it.
      this.db
        .prepare("UPDATE enrollment_tokens SET used_at = ? WHERE code_name = ? AND used_at IS NULL")
        .bind(nowMs(), codeName),
    ])
  }

  async listDevices(): Promise<
    Array<{
      code_name: string
      hostname: string | null
      platform: string | null
      agent_version: string | null
      enrolled: boolean
      last_seen_ns: number | null
      last_seen_age_ms: number | null
      liveness: Liveness
      instrument_count: number
      instruments_online: number
    }>
  > {
    const now = nowMs()
    const { results } = await this.db
      .prepare(
        `SELECT d.code_name, d.hostname, d.platform, d.agent_version, d.enrolled_at, d.last_seen_ns,
                (SELECT COUNT(*) FROM instruments i WHERE i.device_code = d.code_name) AS instrument_count,
                (SELECT COUNT(*) FROM instrument_status s
                   WHERE s.device_code = d.code_name AND s.status = 'online') AS instruments_online
         FROM devices d WHERE d.revoked = 0 ORDER BY d.code_name`,
      )
      .all<{
        code_name: string
        hostname: string | null
        platform: string | null
        agent_version: string | null
        enrolled_at: number | null
        last_seen_ns: number | null
        instrument_count: number
        instruments_online: number
      }>()
    return results.map((r) => ({
      code_name: r.code_name,
      hostname: r.hostname,
      platform: r.platform,
      agent_version: r.agent_version,
      enrolled: r.enrolled_at != null,
      last_seen_ns: r.last_seen_ns,
      last_seen_age_ms: ageMs(r.last_seen_ns, now),
      liveness: liveness(r.last_seen_ns, r.enrolled_at != null, now),
      instrument_count: r.instrument_count,
      instruments_online: r.instruments_online,
    }))
  }

  async getDevice(codeName: string): Promise<DeviceRow> {
    const row = await this.db
      .prepare("SELECT * FROM devices WHERE code_name = ? AND revoked = 0")
      .bind(codeName)
      .first<DeviceRow>()
    if (!row) throw new HttpError(404, "device not found")
    return row
  }

  /** Revoke a device: kills its key immediately and hides it from listings. */
  async revokeDevice(codeName: string): Promise<void> {
    const result = await this.db
      .prepare(
        "UPDATE devices SET revoked = 1, key_hash = NULL WHERE code_name = ? AND revoked = 0",
      )
      .bind(codeName)
      .run()
    if (result.meta.changes !== 1) throw new HttpError(404, "device not found")
  }

  async deviceByKeyHash(hash: string): Promise<DeviceRow | null> {
    return await this.db
      .prepare("SELECT * FROM devices WHERE key_hash = ? AND revoked = 0")
      .bind(hash)
      .first<DeviceRow>()
  }

  async touchDevice(codeName: string): Promise<void> {
    await this.db
      .prepare("UPDATE devices SET last_seen_ns = ? WHERE code_name = ?")
      .bind(nowNs(), codeName)
      .run()
  }

  // ---- enrollment tokens ----

  /** Issue a single-use, short-TTL enrollment token bound to one device. */
  async issueEnrollmentToken(codeName: string, tokenHash: string, owner: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO enrollment_tokens (id, code_name, token_hash, expires_at, created_by) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(crypto.randomUUID(), codeName, tokenHash, nowMs() + ENROLL_TTL_MS, owner)
      .run()
  }

  /** Atomically consume a token; returns the bound code_name or null if invalid/expired/used. */
  async consumeEnrollmentToken(tokenHash: string): Promise<string | null> {
    const now = nowMs()
    const row = await this.db
      .prepare(
        "SELECT id, code_name FROM enrollment_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
      )
      .bind(tokenHash, now)
      .first<{ id: string; code_name: string }>()
    if (!row) return null
    const result = await this.db
      .prepare("UPDATE enrollment_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL")
      .bind(now, row.id)
      .run()
    return result.meta.changes === 1 ? row.code_name : null
  }

  async completeEnrollment(
    codeName: string,
    keyHash: string,
    info: { hostname: string | null; platform: string | null; agent_version: string | null },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE devices SET key_hash = ?, enrolled_at = ?, hostname = ?, platform = ?, agent_version = ?
         WHERE code_name = ?`,
      )
      .bind(keyHash, nowMs(), info.hostname, info.platform, info.agent_version, codeName)
      .run()
  }

  // ---- instruments ----

  /** Replace this device's whole instrument set atomically. */
  async setInstruments(codeName: string, list: InstrumentDecl[]): Promise<void> {
    const declared = nowNs()
    const statements = [
      this.db.prepare("DELETE FROM instruments WHERE device_code = ?").bind(codeName),
      ...list.map((i) =>
        this.db
          .prepare(
            `INSERT INTO instruments
               (device_code, local_id, title, model, driver, address_kind, capabilities, metrics, ports, declared_ns)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            codeName,
            i.local_id,
            i.title,
            i.model,
            i.driver,
            i.address_kind,
            JSON.stringify(i.capabilities),
            JSON.stringify(i.metrics),
            JSON.stringify(i.ports),
            declared,
          ),
      ),
      // keep status rows for instruments that still exist; drop the rest
      this.db
        .prepare(
          "DELETE FROM instrument_status WHERE device_code = ? AND local_id NOT IN (SELECT local_id FROM instruments WHERE device_code = ?)",
        )
        .bind(codeName, codeName),
    ]
    await this.db.batch(statements)
  }

  async instrumentsWithLatest(codeName: string): Promise<
    Array<{
      local_id: string
      title: string | null
      model: string | null
      driver: string | null
      capabilities: unknown
      ports: unknown
      status: string
      latest: Record<string, { value: number | null; ts_ns: number }>
    }>
  > {
    const [instruments, statuses, readings] = await this.db.batch<Record<string, unknown>>([
      this.db
        .prepare("SELECT * FROM instruments WHERE device_code = ? ORDER BY local_id")
        .bind(codeName),
      this.db
        .prepare("SELECT local_id, status FROM instrument_status WHERE device_code = ?")
        .bind(codeName),
      this.db
        .prepare(
          "SELECT local_id, metric, value, value_text, ts_ns FROM reading_latest WHERE device_code = ?",
        )
        .bind(codeName),
    ])
    const statusOf = new Map<string, string>()
    for (const s of statuses.results as Array<{ local_id: string; status: string }>)
      statusOf.set(s.local_id, s.status)
    const latestOf = new Map<string, Record<string, { value: number | null; ts_ns: number }>>()
    for (const r of readings.results as Array<{
      local_id: string
      metric: string
      value: number | null
      value_text: string | null
      ts_ns: number
    }>) {
      const map = latestOf.get(r.local_id) ?? {}
      map[r.metric] = {
        value: r.value_text != null ? (r.value_text as unknown as number) : r.value,
        ts_ns: r.ts_ns,
      }
      latestOf.set(r.local_id, map)
    }
    return (
      instruments.results as Array<{
        local_id: string
        title: string | null
        model: string | null
        driver: string | null
        capabilities: string
        ports: string
      }>
    ).map((i) => ({
      local_id: i.local_id,
      title: i.title,
      model: i.model,
      driver: i.driver,
      capabilities: JSON.parse(i.capabilities),
      ports: JSON.parse(i.ports),
      status: statusOf.get(i.local_id) ?? "unpolled",
      latest: latestOf.get(i.local_id) ?? {},
    }))
  }

  /**
   * Record per-instrument status from a heartbeat, and stamp last_seen with the *server* clock so
   * a lab PC with a wrong clock cannot read as online/stale for everyone. The agent's ts_ns is
   * kept for instrument_status.updated_ns.
   */
  async recordHeartbeat(
    codeName: string,
    tsNs: string,
    statuses: Array<{ local_id: string; status: string }>,
  ): Promise<void> {
    const statements = [
      this.db
        .prepare("UPDATE devices SET last_seen_ns = ? WHERE code_name = ?")
        .bind(nowNs(), codeName),
      ...statuses.map((s) =>
        this.db
          .prepare(
            `INSERT INTO instrument_status (device_code, local_id, status, updated_ns)
             VALUES (?, ?, ?, ?)
             ON CONFLICT (device_code, local_id) DO UPDATE SET status = excluded.status, updated_ns = excluded.updated_ns`,
          )
          .bind(codeName, s.local_id, s.status, tsNs),
      ),
    ]
    await this.db.batch(statements)
  }

  /** One instrument: declaration + latest per-metric values + a small recent history buffer. */
  async instrumentDetail(
    codeName: string,
    localId: string,
    historyLimit = 200,
  ): Promise<{
    local_id: string
    title: string | null
    model: string | null
    driver: string | null
    address_kind: string | null
    capabilities: unknown
    metrics: unknown
    ports: unknown
    status: string
    latest: Record<string, { value: number | null; ts_ns: number }>
    history: Array<{ metric: string; value: number | null; ts_ns: number }>
  }> {
    const inst = await this.db
      .prepare("SELECT * FROM instruments WHERE device_code = ? AND local_id = ?")
      .bind(codeName, localId)
      .first<{
        local_id: string
        title: string | null
        model: string | null
        driver: string | null
        address_kind: string | null
        capabilities: string
        metrics: string
        ports: string
      }>()
    if (!inst) throw new HttpError(404, "instrument not found")
    const [status, latest, history] = await this.db.batch<Record<string, unknown>>([
      this.db
        .prepare("SELECT status FROM instrument_status WHERE device_code = ? AND local_id = ?")
        .bind(codeName, localId),
      this.db
        .prepare(
          "SELECT metric, value, value_text, ts_ns FROM reading_latest WHERE device_code = ? AND local_id = ?",
        )
        .bind(codeName, localId),
      this.db
        .prepare(
          "SELECT metric, value, value_text, ts_ns FROM reading_history WHERE device_code = ? AND local_id = ? ORDER BY id DESC LIMIT ?",
        )
        .bind(codeName, localId, historyLimit),
    ])
    const latestMap: Record<string, { value: number | null; ts_ns: number }> = {}
    for (const r of latest.results as Array<{
      metric: string
      value: number | null
      value_text: string | null
      ts_ns: number
    }>)
      latestMap[r.metric] = {
        value: r.value_text != null ? (r.value_text as unknown as number) : r.value,
        ts_ns: r.ts_ns,
      }
    return {
      local_id: inst.local_id,
      title: inst.title,
      model: inst.model,
      driver: inst.driver,
      address_kind: inst.address_kind,
      capabilities: JSON.parse(inst.capabilities),
      metrics: JSON.parse(inst.metrics),
      ports: JSON.parse(inst.ports),
      status: ((status.results as Array<{ status: string }>)[0]?.status as string) ?? "unpolled",
      latest: latestMap,
      history: (
        history.results as Array<{
          metric: string
          value: number | null
          value_text: string | null
          ts_ns: number
        }>
      )
        .reverse()
        .map((r) => ({
          metric: r.metric,
          value: r.value_text != null ? (r.value_text as unknown as number) : r.value,
          ts_ns: r.ts_ns,
        })),
    }
  }

  // ---- commands (durable audit; the live queue lives in the DeviceHub DO) ----

  async createCommand(
    codeName: string,
    kind: string,
    args: unknown,
    requestedBy: string,
  ): Promise<{ id: string; created_ns: string }> {
    const id = crypto.randomUUID()
    const created_ns = nowNs()
    await this.db
      .prepare(
        "INSERT INTO commands (id, device_code, kind, args, requested_by, created_ns) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, codeName, kind, JSON.stringify(args ?? {}), requestedBy, created_ns)
      .run()
    return { id, created_ns }
  }

  async listCommands(codeName: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const { results } = await this.db
      .prepare(
        "SELECT id, kind, args, status, result, requested_by, created_ns, delivered_ns, completed_ns FROM commands WHERE device_code = ? ORDER BY created_ns DESC LIMIT ?",
      )
      .bind(codeName, limit)
      .all()
    return results.map((r) => ({
      ...r,
      args: JSON.parse((r.args as string) ?? "{}"),
      result: r.result != null ? JSON.parse(r.result as string) : null,
    }))
  }

  // ---- experiments ----

  async createExperiment(
    id: string,
    codeName: string,
    label: string | null,
    spec: unknown,
    createdBy: string,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO experiments (id, device_code, label, spec, status, created_by, created_ns) VALUES (?, ?, ?, ?, 'generating', ?, ?)",
      )
      .bind(id, codeName, label, JSON.stringify(spec ?? {}), createdBy, nowNs())
      .run()
  }

  async setExperimentScript(id: string, script: string, status: string): Promise<void> {
    await this.db
      .prepare("UPDATE experiments SET script = ?, status = ? WHERE id = ?")
      .bind(script, status, id)
      .run()
  }

  async setExperimentStatus(id: string, status: string): Promise<void> {
    const stamp =
      status === "running"
        ? ", started_ns = " + nowNs()
        : status === "stopped" || status === "failed"
          ? ", stopped_ns = " + nowNs()
          : ""
    await this.db
      .prepare(`UPDATE experiments SET status = ?${stamp} WHERE id = ?`)
      .bind(status, id)
      .run()
  }

  async getExperiment(id: string): Promise<Record<string, unknown> | null> {
    const row = await this.db
      .prepare("SELECT * FROM experiments WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>()
    if (!row) return null
    return {
      ...row,
      spec: JSON.parse((row.spec as string) ?? "{}"),
      artifacts: JSON.parse((row.artifacts as string) ?? "{}"),
    }
  }

  async listExperiments(codeName: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const { results } = await this.db
      .prepare(
        "SELECT id, label, status, created_by, created_ns, started_ns, stopped_ns FROM experiments WHERE device_code = ? ORDER BY created_ns DESC LIMIT ?",
      )
      .bind(codeName, limit)
      .all()
    return results
  }

  async recordDataset(
    experimentId: string,
    codeName: string,
    r2Key: string,
    metadata: unknown,
  ): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO datasets (experiment_id, device_code, r2_key, metadata, created_ns) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(experimentId, codeName, r2Key, JSON.stringify(metadata ?? {}), nowNs())
      .run()
  }

  async listDatasets(experimentId: string): Promise<Array<Record<string, unknown>>> {
    const { results } = await this.db
      .prepare(
        "SELECT id, r2_key, metadata, created_ns FROM datasets WHERE experiment_id = ? ORDER BY id",
      )
      .bind(experimentId)
      .all()
    return results.map((r) => ({ ...r, metadata: JSON.parse((r.metadata as string) ?? "{}") }))
  }

  // ---- catalog ----

  async listCatalog(): Promise<
    Array<{
      family: string
      display_name: string | null
      description: string | null
      ports: unknown
      capabilities: unknown
    }>
  > {
    const { results } = await this.db
      .prepare(
        "SELECT family, display_name, description, ports, capabilities FROM catalog ORDER BY family",
      )
      .all<CatalogRow>()
    return results.map((r) => ({
      family: r.family,
      display_name: r.display_name,
      description: r.description,
      ports: JSON.parse(r.ports),
      capabilities: JSON.parse(r.capabilities),
    }))
  }

  /** Full descriptors (incl. examples) for the named families — the device-scoped generator/MCP
   *  context. Missing families are simply absent from the result. */
  async catalogFor(families: string[]): Promise<
    Array<{
      family: string
      display_name: string | null
      description: string | null
      ports: unknown
      capabilities: unknown
      examples: unknown
    }>
  > {
    if (families.length === 0) return []
    const placeholders = families.map(() => "?").join(",")
    const { results } = await this.db
      .prepare(
        `SELECT family, display_name, description, ports, capabilities, examples FROM catalog WHERE family IN (${placeholders})`,
      )
      .bind(...families)
      .all<CatalogRow>()
    return results.map((r) => ({
      family: r.family,
      display_name: r.display_name,
      description: r.description,
      ports: JSON.parse(r.ports),
      capabilities: JSON.parse(r.capabilities),
      examples: JSON.parse(r.examples),
    }))
  }
}
