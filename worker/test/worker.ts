import { createHandler } from "../src/app"
import manifest from "./fixtures/docs-manifest.json"

// The test Worker shares the isolate with the tests, so they can inspect these calls.
export const upstreamCalls: string[] = []
export const upstreamBodies: Record<string, [number, string]> = {
  "0123456789abcdef0123456789abcdef01234567": [200, "%PDF-1.4 laser"],
  fedcba9876543210fedcba9876543210fedcba98: [500, "boom"],
}

export default createHandler(manifest, {
  upstream: async (input) => {
    upstreamCalls.push(input)
    const sha = input.split("/").pop() ?? ""
    const [status, body] = upstreamBodies[sha] ?? [404, "missing"]
    return new Response(body, { status })
  },
})
