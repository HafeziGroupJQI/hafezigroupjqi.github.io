// Drive the one-domain members site in headless Chromium against a local Pages stand-in
// (tools/serve-pages.mjs) and a local members API (wrangler dev, dev auth). Asserts that every
// page is shown at the Pages origin, private content only appears after sign-in, and the browser
// never navigates to the API origin. Used by tools/verify-members.sh.
// Usage: node tools/members-e2e.mjs <pages-url> <api-url> <device-code> <private-dir> <shots-dir>
import fs from "node:fs"
import path from "node:path"
import { chromium } from "playwright-core"

const [pages, api, code, privateDir, shots] = process.argv.slice(2)
const ok = (m) => console.log(`   \x1b[32mok\x1b[0m  ${m}`)
const check = (cond, m) => {
  if (!cond) throw new Error(m)
  ok(m)
}

// A private note with a picture, and a private document from the manifest.
const findNote = () => {
  const dir = path.join(privateDir, "resources")
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory() && entry.name !== "assets") stack.push(p)
      else if (
        entry.name.endsWith(".html") &&
        /<img[^>]+src="[^"]*resources\/assets\/[^"]+\.(?:jpe?g|png)"/.test(
          fs.readFileSync(p, "utf8"),
        )
      )
        return "/" + path.relative(privateDir, p).replace(/\.html$/, "")
    }
  }
  return null
}
const note = findNote()
const manifest = JSON.parse(
  fs.readFileSync(new URL("../worker/generated/docs-manifest.json", import.meta.url)),
)
const pdf = Object.keys(manifest.documents).find((k) => k.endsWith(".pdf"))

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
const navigations = []
page.on("framenavigated", (frame) => frame === page.mainFrame() && navigations.push(frame.url()))
const errors = []
page.on(
  "pageerror",
  (error) => /member-tools|sw\.js|members-auth/.test(error.stack ?? "") && errors.push(error.stack),
)
page.on("console", (m) => process.env.E2E_DEBUG && console.log("   console:", m.type(), m.text()))
page.on("pageerror", (e) => process.env.E2E_DEBUG && console.log("   pageerror:", e.stack))
const headings = () => page.locator("h1").allTextContents()
const shot = (name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: true })

// Signed out: the public site, no private content.
let response = await page.goto(pages + "/")
check(response.status() === 200, "signed out: the public home page loads")
check(
  (await page.locator('a[href="/auth/login"]').count()) > 0,
  "signed out: 'Sign in with GitHub' stays on this site",
)
response = await page.goto(pages + "/resources/")
check(
  response.status() === 404 && !(await headings()).includes("Group resources"),
  "signed out: /resources/ is the public 404",
)

// Mermaid diagrams render (the renderer looks for its content inside .center).
if (fs.existsSync(path.join(privateDir, "setups/setup-1-main.html"))) {
  await page.goto(pages + "/setups/setup-1-main")
  await page.waitForSelector("code.mermaid svg, .mermaid svg", { timeout: 30_000 })
  check(true, "mermaid: the setup's signal graph renders as a diagram, not raw code")
}

// Sign in (dev auth): /auth/login → start → exchange → service worker → back to next.
await page.goto(pages + "/auth/login?next=/resources/")
await page.waitForURL(pages + "/resources/", { timeout: 30_000 })
await page.waitForSelector("h1")
check(
  (await headings()).includes("Group resources"),
  "signed in: /resources/ shows the members' resources index",
)
check(
  await page.evaluate(() => !!navigator.serviceWorker.controller),
  "the members service worker controls the page",
)
await shot("members-resources")

const session = await page.evaluate(() => fetch("/api/session").then((r) => r.json()))
check(
  session.user?.login === "dev",
  "same-origin /api/session is answered for the signed-in member",
)
const index = await page.evaluate(() => fetch("/static/contentIndex.json").then((r) => r.json()))
check(
  Object.keys(index).some((slug) => slug.startsWith("resources/")),
  "search/graph index includes private notes",
)

if (note) {
  await page.goto(pages + note)
  await page.waitForLoadState("networkidle")
  const images = await page.evaluate(() =>
    [...document.querySelectorAll('img[src*="resources/assets/"]')].map(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  )
  check(
    images.length > 0 && images.every(Boolean),
    `private note ${note}: ${images.length} picture(s) load`,
  )
  await shot("members-note")
}
if (pdf) {
  const doc = await page.evaluate(
    (p) =>
      fetch("/" + p).then((r) => [
        r.status,
        r.headers.get("content-type"),
        r.headers.get("content-disposition"),
      ]),
    pdf,
  )
  if (doc[0] === 200)
    check(
      doc[1] === "application/pdf" && /filename=/.test(doc[2] ?? ""),
      `private document /${pdf} streams with its filename`,
    )
  else
    console.log(
      `   \x1b[33mskip\x1b[0m private document (${doc[0]}; set GITHUB_DOCS_TOKEN to stream documents)`,
    )
}

await page.goto(pages + "/calendar")
await page.waitForSelector(".fc", { timeout: 15_000 })
check(true, "/calendar renders the members calendar")

await page.goto(`${pages}/devices`)
await page.waitForSelector(`.dev-card.live-online`, { timeout: 20_000 })
check(
  (await page.textContent(".dash-summary")).includes("online"),
  "/devices overview shows the simulated lab PC online",
)
await shot("members-devices")
await page.goto(`${pages}/devices?tab=device&code=${code}`)
await page.waitForSelector('.sse-badge[data-state="live"]', { timeout: 20_000 })
await page.waitForSelector('[data-metric="voltage_v"]', { timeout: 20_000 })
check(true, "device tab: live SSE stream straight from the API, readings shown")
await shot("members-device")

// Hafezi GPT (offline here: no ANTHROPIC_API_KEY, so replies list the context they would send).
await page.goto(`${pages}/gpt`)
await page.waitForSelector(".gpt-composer .gpt-input", { timeout: 20_000 })
check(
  !(await page.textContent(".gpt-header")).includes("null"),
  "/gpt: a new chat's header has no stray null",
)
await page.click(".gpt-input")
await page.keyboard.type("@onboarding")
await page.waitForSelector(".gpt-popup [role=option]", { timeout: 15_000 })
await page.keyboard.press("Enter")
check(
  (await page.locator(".gpt-composer .gpt-chip").count()) === 1,
  "/gpt: @-mention picks a page as a chip",
)
await page.keyboard.type("Where do I start?")
await page.keyboard.press("Enter")
await page.waitForSelector(".gpt-msg--assistant .gpt-md", { timeout: 30_000 })
await page.waitForFunction(
  () => document.querySelector(".gpt-send")?.textContent === "Send",
  null,
  { timeout: 30_000 },
)
check(
  (await page.textContent(".gpt-msg--assistant")).includes("Page:"),
  "/gpt: a streamed reply lists the mentioned page",
)
await page.waitForSelector(".gpt-chat-link", { timeout: 10_000 })
check(new URL(page.url()).searchParams.has("c"), "/gpt: the new chat is in the history and the URL")
await shot("members-gpt")

await page.goto(pages + "/resources/")
await page.waitForSelector(".gpt-fab", { timeout: 15_000 })
await page.keyboard.press("Control+j")
await page.waitForSelector(".gpt-modal[open] .gpt-input", { timeout: 20_000 })
check(
  (await page.textContent(".gpt-modal .gpt-chips")).includes("This page"),
  "Ctrl+J opens Ask Hafezi GPT with the page attached",
)
await page.fill(".gpt-modal .gpt-input", "Summarize this page")
await page.keyboard.press("Enter")
await page.waitForSelector(".gpt-modal .gpt-msg--assistant .gpt-md", { timeout: 30_000 })
await page.waitForFunction(
  () => document.querySelector(".gpt-modal .gpt-send")?.textContent === "Send",
  null,
  { timeout: 30_000 },
)
check(
  (await page.textContent(".gpt-modal .gpt-msg--assistant")).includes("Page:"),
  "the page modal answers with the page as context",
)
await shot("members-gpt-modal")
await page.keyboard.press("Escape")

await page.goto(pages + "/admin")
await page.waitForSelector(".audit-row", { timeout: 20_000 })
const audit = await page.textContent(".audit-list")
check(
  audit.includes("signed in") && audit.includes("asked Hafezi GPT"),
  "/admin: the audit log shows sign-ins and Hafezi GPT activity",
)
check(!audit.includes("Where do I start"), "/admin: chat text never reaches the audit log")
await shot("members-admin")

// A browser without the worker (hard reload): the page bootstraps it and reloads into members view.
await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/"))?.unregister())
await page.goto(pages + "/resources/")
await page.waitForFunction(
  () => [...document.querySelectorAll("h1")].some((h) => h.textContent === "Group resources"),
  null,
  { timeout: 30_000 },
)
check(true, "without a controlling worker, the head bootstrap restores the members view")

// Sign out.
await page.goto(pages + "/auth/logout")
await page.waitForURL(pages + "/", { timeout: 15_000 })
response = await page.goto(pages + "/resources/")
check(
  response.status() === 404 && !(await headings()).includes("Group resources"),
  "after sign-out, /resources/ is the public 404 again",
)

const offsite = navigations.filter((url) => !url.startsWith(pages))
check(
  offsite.length === 0,
  `the browser never navigated off ${pages} (${navigations.length} navigations)`,
)
check(errors.length === 0, "no errors from the members scripts")
await browser.close()
