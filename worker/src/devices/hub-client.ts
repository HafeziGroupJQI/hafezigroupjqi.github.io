import type { Env } from "../env"

// Thin helpers for talking to a device's DeviceHub Durable Object from the Worker's request
// handlers. One DO instance per code-name via idFromName; the base URL is arbitrary (the DO routes
// on pathname only).

export function hubStub(env: Env, code: string): DurableObjectStub {
  return env.DEVICE_HUB.get(env.DEVICE_HUB.idFromName(code))
}

export async function hubIngest(
  env: Env,
  code: string,
  body: { readings?: unknown[]; logs?: unknown[] },
): Promise<void> {
  await hubStub(env, code).fetch("https://hub/ingest", {
    method: "POST",
    body: JSON.stringify({ code_name: code, ...body }),
  })
}

export async function hubEnqueue(
  env: Env,
  code: string,
  command: { id: string; kind: string; args: unknown; created_ns: string },
): Promise<{ delivered: boolean }> {
  const res = await hubStub(env, code).fetch("https://hub/enqueue", {
    method: "POST",
    body: JSON.stringify({ code_name: code, ...command }),
  })
  return (await res.json()) as { delivered: boolean }
}

export function hubStream(env: Env, code: string): Promise<Response> {
  return hubStub(env, code).fetch("https://hub/stream")
}

export function hubAgentWs(env: Env, code: string, request: Request): Promise<Response> {
  return hubStub(env, code).fetch("https://hub/agent-ws", request)
}
