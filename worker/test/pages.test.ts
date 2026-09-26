import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test"
import { describe, expect, it } from "vitest"
import { MEMBER_PAGES } from "../src/app"
import worker from "./worker"
import { ORIGIN } from "./helpers"

// The deployed Worker runs with ALLOW_PUBLIC_BROWSING=1 (the test wrangler.jsonc omits it), so
// pin the gate against that env: the public site renders logged out, member tool pages and the
// member API never do.
const publicEnv = { ...env, ALLOW_PUBLIC_BROWSING: "1" }

async function anonymous(path: string, accept = "text/html") {
  const ctx = createExecutionContext()
  const response = await (worker as ExportedHandler).fetch!(
    new Request(ORIGIN + path, { headers: { accept }, redirect: "manual" }) as any,
    publicEnv as any,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return response
}

describe("public browsing gate", () => {
  it("serves the public home page to anonymous visitors", async () => {
    expect((await anonymous("/")).status).toBe(200)
  })

  for (const page of [...MEMBER_PAGES, "/devices?tab=device&code=x"]) {
    it(`sends anonymous ${page} to login`, async () => {
      const response = await anonymous(page)
      expect(response.status).toBe(302)
      const location = new URL(response.headers.get("location")!, ORIGIN)
      expect(location.pathname).toBe("/auth/login")
      expect(location.searchParams.get("next")).toBe(page)
    })
  }

  it("answers 401 on the member API", async () => {
    expect((await anonymous("/api/devices", "application/json")).status).toBe(401)
  })
})
