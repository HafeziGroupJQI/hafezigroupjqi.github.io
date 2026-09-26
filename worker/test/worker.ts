import { createHandler } from "../src/app"
import manifest from "./fixtures/docs-manifest.json"

// The Durable Object class must be exported from the test entry module too.
export { DeviceHub } from "../src/devices/hub"

// The test Worker shares the isolate with the tests, so they can inspect the GitHub blob calls.
export const upstreamCalls: string[] = []
export const upstreamBodies: Record<string, [number, string]> = {
  "0123456789abcdef0123456789abcdef01234567": [200, "%PDF-1.4 laser"],
  fedcba9876543210fedcba9876543210fedcba98: [500, "boom"],
}

// A stand-in for GitHub OAuth + REST during sign-in (AUTH_MODE=github tests).
export const githubCalls: string[] = []
export const githubAccounts: Record<string, { org?: object; team?: object }> = {
  "code-owner": { org: { state: "active", role: "admin" } },
  "code-member": { team: { state: "active" } },
  "code-outsider": {},
}
let lastCode = ""

export default createHandler(manifest, {
  github: async (input, init) => {
    githubCalls.push(input)
    if (input === "https://github.com/login/oauth/access_token") {
      const { code } = JSON.parse(String(init.body)) as { code: string }
      lastCode = code
      return Response.json(code in githubAccounts ? { access_token: `gho_${code}` } : {})
    }
    const account = githubAccounts[lastCode] ?? {}
    if (input.endsWith("/user")) return Response.json({ login: lastCode.slice(5), name: null })
    if (input.includes("/user/memberships/orgs/"))
      return account.org ? Response.json(account.org) : new Response("", { status: 404 })
    if (input.includes("/teams/"))
      return account.team ? Response.json(account.team) : new Response("", { status: 404 })
    return new Response("", { status: 404 })
  },
  upstream: async (input) => {
    upstreamCalls.push(input)
    const sha = input.split("/").pop() ?? ""
    const [status, body] = upstreamBodies[sha] ?? [404, "missing"]
    return new Response(body, { status })
  },
})
