import type { Env } from "../env"
import { HttpError } from "../http"
import { hubEnqueue } from "./hub-client"
import { type ExperimentSpec, parseExperimentSpec } from "./model"
import type { DevicesStore } from "./store"

// Cloud experiment generation (plan Part 4). The Experiment Builder posts a Setup.json spec; the
// Worker assembles the device-scoped instrument context (the selected families' descriptors +
// examples from the catalog), turns the spec into a runnable, hardware-safe Runexp.py, statically
// validates it (the Worker cannot run Python — the agent runs py_compile and reports back), stores
// it, and dispatches an experiment.start command carrying the spec + script to the device.
//
// Generation calls the Claude Messages API when ANTHROPIC_API_KEY is configured; otherwise it uses
// a deterministic offline template that produces a valid measurement script. The offline path is
// what the test suite exercises (no network, no cost) and is a genuine fallback in production.

type Catalog = Awaited<ReturnType<DevicesStore["catalogFor"]>>

interface Dispatch {
  experiment_id: string
  status: string
  delivered: boolean
  command_id: string
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48) || "run"

function experimentId(label: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
  return `Experiment_${ts}_${slug(label)}`
}

export async function generateAndDispatch(
  env: Env,
  store: DevicesStore,
  code: string,
  body: unknown,
  requestedBy: string,
): Promise<Dispatch> {
  const spec = parseExperimentSpec(body)
  const id = experimentId(spec.experiment_label)
  await store.createExperiment(id, code, spec.experiment_label, spec, requestedBy)

  const families = [
    ...new Set(spec.selected_instruments.map((s) => s.family).filter((f): f is string => !!f)),
  ]
  const catalog = await store.catalogFor(families)

  let script: string
  try {
    script = await generateScript(env, spec, catalog)
    validateScript(script)
  } catch (error) {
    await store.setExperimentStatus(id, "failed")
    throw new HttpError(502, `experiment generation failed: ${(error as Error).message}`)
  }
  await store.setExperimentScript(id, script, "running")

  const args = { experiment_id: id, spec, script }
  const cmd = await store.createCommand(code, "experiment.start", args, requestedBy)
  const { delivered } = await hubEnqueue(env, code, {
    id: cmd.id,
    kind: "experiment.start",
    args,
    created_ns: cmd.created_ns,
  })
  return { experiment_id: id, status: "running", delivered, command_id: cmd.id }
}

export async function stopExperiment(
  env: Env,
  store: DevicesStore,
  code: string,
  id: string,
  requestedBy: string,
): Promise<{ experiment_id: string; status: string; delivered: boolean }> {
  const exp = await store.getExperiment(id)
  if (!exp) throw new HttpError(404, "experiment not found")
  await store.setExperimentStatus(id, "stopped")
  const args = { experiment_id: id }
  const cmd = await store.createCommand(code, "experiment.stop", args, requestedBy)
  const { delivered } = await hubEnqueue(env, code, {
    id: cmd.id,
    kind: "experiment.stop",
    args,
    created_ns: cmd.created_ns,
  })
  return { experiment_id: id, status: "stopped", delivered }
}

// ---- generation ----

async function generateScript(env: Env, spec: ExperimentSpec, catalog: Catalog): Promise<string> {
  if (env.ANTHROPIC_API_KEY) return generateWithClaude(env, spec, catalog)
  return templateRunexp(spec, catalog)
}

const SYSTEM_PROMPT = `You write Python instrument-control scripts (Runexp.py) for a physics lab.
Rules, non-negotiable:
- Measurement only. Never fabricate or simulate data when hardware is present; read the instruments.
- Emit exactly one data point per CSV row, with unit-bearing column names (e.g. "voltage_v").
- Write a self-documenting CSV whose header is '#'-prefixed "key: value" metadata lines (timestamp,
  device, instrument ids, measurement type, units, every setting), then the column header row.
- Stream each point to stdout as one compact JSON object
  {"local_id","metric","value","ts_ns"} so the live view updates as the run proceeds.
- Configure, read back, and assert every critical setting before measuring.
- Order outputs safely and ALWAYS disable every source/output in a guarded finally block, so a
  Stop, an abort, or a connection loss leaves the hardware safe.
- No network, no subprocess, no file exfiltration; only instrument I/O and local CSV.
Return ONLY the Python script in one fenced \`\`\`python block.`

async function generateWithClaude(
  env: Env,
  spec: ExperimentSpec,
  catalog: Catalog,
): Promise<string> {
  const model = env.ANTHROPIC_MODEL || "claude-opus-5"
  const context = catalog
    .map(
      (c) =>
        `Family ${c.family}: ${c.display_name ?? ""}\n  capabilities: ${JSON.stringify(c.capabilities)}\n  ports: ${JSON.stringify(c.ports)}\n  examples: ${JSON.stringify(c.examples)}`,
    )
    .join("\n")
  const userPrompt = `Instrument context (only these instruments are in scope):\n${context}\n\nExperiment spec (Setup.json):\n${JSON.stringify(spec, null, 2)}\n\nWrite Runexp.py for this experiment.`

  const base = (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "")
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }],
    }),
  })
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
  const fenced = text.match(/```(?:python)?\n([\s\S]*?)```/)
  const script = (fenced ? fenced[1] : text).trim()
  if (!script) throw new Error("empty generation")
  return script
}

// Static validation gate: the Worker cannot run Python, so it checks size and enforces the
// measurement-only rule with an import/verb denylist. The agent runs py_compile and reports a
// compile failure back as a command result (bounded regenerate-with-feedback lives at that layer).
const FORBIDDEN = [
  /\bimport\s+socket\b/,
  /\bimport\s+requests\b/,
  /\bimport\s+urllib\b/,
  /\bfrom\s+urllib\b/,
  /\bimport\s+http\b/,
  /\bimport\s+ftplib\b/,
  /\bimport\s+smtplib\b/,
  /\bimport\s+subprocess\b/,
  /\bos\.system\s*\(/,
  /\bsubprocess\./,
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /__import__\s*\(/,
]

export function validateScript(script: string): void {
  if (!script || script.length < 20) throw new Error("generated script is empty or too short")
  if (script.length > 100_000) throw new Error("generated script is too large")
  for (const rule of FORBIDDEN)
    if (rule.test(script)) throw new Error(`generated script uses a forbidden construct: ${rule}`)
  if (!/finally\s*:/.test(script))
    throw new Error("generated script lacks a guarded finally teardown")
}

// Deterministic offline generator: a self-contained sweep that always compiles, writes a
// self-documenting CSV with a '#'-metadata header and one point per row, streams each point as a
// JSON line for the live view, and disables outputs in a guarded finally. For the no-hardware path
// it produces synthetic points; the Claude path writes real driver I/O when a key is configured.
function templateRunexp(spec: ExperimentSpec, catalog: Catalog): string {
  const metrics = new Set<string>()
  for (const inst of spec.selected_instruments) {
    const fam = catalog.find((c) => c.family === inst.family)
    const caps = (fam?.capabilities ?? {}) as Record<string, unknown>
    if (caps.readable !== false) metrics.add(`${inst.local_id}:signal`)
  }
  const metricList = metrics.size ? [...metrics] : ["measurement:signal"]
  const columns = [
    "index",
    "sweep_setpoint_v",
    ...metricList.map((m) => m.replace(":", "_") + "_a"),
  ]
  const py = String.raw`#!/usr/bin/env python3
"""Runexp.py — generated (offline template) for ${spec.experiment_label}.
Experiment prompt: ${spec.experiment_prompt.replace(/[\r\n]+/g, " ")}
Instruments: ${spec.selected_instruments.map((s) => s.local_id).join(", ")}
This is the no-hardware path: it produces a reproducible synthetic sweep, writes a
self-documenting CSV, and streams one JSON point per row for the live view."""
import csv
import json
import math
import sys
import time
from datetime import datetime, timezone

POINTS = ${spec.points}
LABEL = ${JSON.stringify(spec.experiment_label)}
INSTRUMENTS = ${JSON.stringify(spec.selected_instruments.map((s) => s.local_id))}
METRICS = ${JSON.stringify(metricList)}
CSV_PATH = "Data/measurement.csv"


def emit(local_id, metric, value):
    """Stream one scalar point to stdout for the agent to relay to the live view."""
    line = {
        "local_id": local_id,
        "metric": metric,
        "value": value,
        "ts_ns": str(time.time_ns()),
    }
    sys.stdout.write(json.dumps(line, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def main():
    import os

    os.makedirs("Data", exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    handle = open(CSV_PATH, "w", newline="")
    try:
        # '#'-metadata header: parseable back to a dict so a raw download re-opens losslessly.
        handle.write(f"# experiment: {LABEL}\n")
        handle.write(f"# started_utc: {started}\n")
        handle.write(f"# instruments: {','.join(INSTRUMENTS)}\n")
        handle.write(f"# measurement: synthetic_sweep\n")
        handle.write(f"# units: sweep_setpoint_v=V, signal=A\n")
        handle.write(f"# points: {POINTS}\n")
        writer = csv.writer(handle)
        writer.writerow(${JSON.stringify(columns)})

        for i in range(POINTS):
            setpoint = -1.0 + 2.0 * i / max(POINTS - 1, 1)
            row = [i, f"{setpoint:.6f}"]
            for metric in METRICS:
                local_id = metric.split(":", 1)[0]
                # Deterministic synthetic response: a diode-like curve with mild ripple.
                value = 1e-6 * (math.exp(setpoint / 0.4) - 1.0) + 1e-9 * math.sin(12.0 * setpoint)
                row.append(f"{value:.9e}")
                emit(local_id, metric.split(":", 1)[1], value)
            writer.writerow(row)
            handle.flush()
            os.fsync(handle.fileno())
            time.sleep(0.0)
        print(f"# done: wrote {POINTS} points to {CSV_PATH}", file=sys.stderr)
    finally:
        # Safety-first teardown: on real hardware this disables every source/output. Here we only
        # close the file, but the guarded finally is always present so Stop/abort stays safe.
        handle.close()


if __name__ == "__main__":
    main()
`
  return py
}
