import { createHandler } from "../src/app"
import manifest from "./fixtures/docs-manifest.json"

// The test Worker shares the isolate with the tests, so they can inspect these calls.
export const upstreamCalls: string[] = []
export const upstreamBodies: Record<string, [number, string]> = {
  "0123456789abcdef0123456789abcdef01234567": [200, "%PDF-1.4 laser"],
  fedcba9876543210fedcba9876543210fedcba98: [500, "boom"],
}

export const C2_URL = "https://c2.test"

export interface C2Call {
  url: string
  method: string
  assertion: string
}
export const c2Calls: C2Call[] = []
/** Tests flip this to simulate the instrument PC being off or refusing the assertion. */
export const c2Behaviour: { mode: "ok" | "outage" | "reject" | "garbage" } = { mode: "ok" }
export const c2Bodies: Record<string, unknown> = {
  "/api/instruments": [],
  "/api/instruments/device/poll": { ok: true },
  "/api/runs": [{ run_id: "20260915T120000-abc123", status: "ok" }],
}

export default createHandler(manifest, {
  upstream: async (input, init) => {
    if (input.startsWith(C2_URL)) {
      const headers = new Headers(init?.headers as HeadersInit)
      c2Calls.push({
        url: input,
        method: init?.method ?? "GET",
        assertion: headers.get("x-hafezi-assertion") ?? "",
      })
      if (c2Behaviour.mode === "outage") throw new TypeError("connection refused")
      if (c2Behaviour.mode === "reject") return new Response("denied", { status: 403 })
      if (c2Behaviour.mode === "garbage") return new Response("not json", { status: 200 })
      const path = new URL(input).pathname
      return Response.json(c2Bodies[path] ?? null)
    }
    upstreamCalls.push(input)
    const sha = input.split("/").pop() ?? ""
    const [status, body] = upstreamBodies[sha] ?? [404, "missing"]
    return new Response(body, { status })
  },
})
