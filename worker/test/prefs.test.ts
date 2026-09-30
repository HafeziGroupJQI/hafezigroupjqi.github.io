import { SELF, env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { HttpError } from "../src/http"
import { DEFAULT_THEME, mergeTheme } from "../src/prefs"
import { ORIGIN, as, auditRows } from "./helpers"

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM member_prefs").run()
  await env.DB.prepare("DELETE FROM audit_log WHERE action = 'prefs.theme'").run()
})

const put = (client: Awaited<ReturnType<typeof as>>, theme: unknown) =>
  client.json("/api/prefs", { method: "PUT", body: JSON.stringify({ theme }) })

describe("member preferences (/api/prefs)", () => {
  it("answers the site's own look to a member who never saved one", async () => {
    const ada = await as("ada")
    expect(await ada.json("/api/prefs")).toEqual({
      status: 200,
      body: { theme: DEFAULT_THEME, updated_at: null },
    })
    expect(DEFAULT_THEME).toEqual({
      mode: "light",
      light: "default",
      dark: "default-dark",
      figures: true,
    })
  })

  it("saves a theme that any later session of the same login reads, whatever its case", async () => {
    const ada = await as("ada")
    const saved = await put(ada, { mode: "dark", dark: "catppuccin-mocha", figures: false })
    expect(saved.status).toBe(200)
    expect(saved.body.theme).toEqual({
      mode: "dark",
      light: "default",
      dark: "catppuccin-mocha",
      figures: false,
    })
    expect(typeof saved.body.updated_at).toBe("number")
    const elsewhere = await as("Ada")
    expect((await elsewhere.json("/api/prefs")).body).toEqual(saved.body)
    // Another member is untouched.
    expect((await (await as("bob")).json("/api/prefs")).body.theme).toEqual(DEFAULT_THEME)
  })

  it("changes only what a request sends", async () => {
    const ada = await as("ada")
    await put(ada, { mode: "system", light: "catppuccin-latte", dark: "nord" })
    const next = await put(ada, { dark: "rose-pine-moon" })
    expect(next.body.theme).toEqual({
      mode: "system",
      light: "catppuccin-latte",
      dark: "rose-pine-moon",
      figures: true,
    })
  })

  it("refuses a mode, id or setting it does not know, and changes nothing", async () => {
    const ada = await as("ada")
    await put(ada, { mode: "dark" })
    for (const theme of [
      { mode: "sepia" },
      { dark: "Nord" },
      { light: "-x" },
      { light: "a".repeat(65) },
      { dark: "../x" },
      { figures: "yes" },
      { accent: "#fff" },
      "dark",
      null,
    ])
      expect((await put(ada, theme)).status).toBe(400)
    expect((await ada.json("/api/prefs")).body.theme.mode).toBe("dark")
  })

  it("needs a session, and a write from one of the site's own origins", async () => {
    expect((await SELF.fetch(ORIGIN + "/api/prefs")).status).toBe(401)
    const ada = await as("ada")
    const foreign = await ada.fetch("/api/prefs", {
      method: "PUT",
      headers: { origin: "https://evil.example" },
      body: JSON.stringify({ theme: { mode: "dark" } }),
    })
    expect(foreign.status).toBe(403)
    expect((await ada.fetch("/api/prefs", { method: "DELETE" })).status).toBe(405)
  })

  it("records each change in the audit log", async () => {
    const ada = await as("ada")
    await put(ada, { mode: "dark", dark: "dracula" })
    const [row] = await auditRows("action = 'prefs.theme'")
    expect(row).toMatchObject({ action: "prefs.theme", login: "ada" })
    expect(JSON.parse(row.detail_json)).toEqual({
      mode: "dark",
      light: "default",
      dark: "dracula",
      figures: true,
    })
  })

  it("merges a partial theme and names what it refuses", () => {
    expect(mergeTheme(DEFAULT_THEME, {})).toEqual(DEFAULT_THEME)
    expect(() => mergeTheme(DEFAULT_THEME, { mode: "dim" })).toThrow(HttpError)
    expect(() => mergeTheme(DEFAULT_THEME, [])).toThrow("theme must be an object")
  })
})
