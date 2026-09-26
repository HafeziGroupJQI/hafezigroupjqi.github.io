// Drive the real /devices page in headless Chromium and capture every tab and overview layout.
// Used by tools/verify-dashboard.sh --screenshots (dev auth: /auth/login signs straight in).
// Usage: node tools/dashboard-screenshots.mjs <base-url> <device-code> <out-dir>
import path from "node:path"
import { chromium } from "playwright-core"

const [base, code, out] = process.argv.slice(2)
const shots = [
  ["overview-grid", "/devices"],
  ["overview-list", "/devices?layout=list"],
  ["overview-focus", `/devices?code=${code}&layout=focus`],
  ["overview-wall", "/devices?layout=wall"],
  ["device", `/devices?tab=device&code=${code}`],
  ["instruments", `/devices?tab=instruments&code=${code}&id=sim-1`],
  ["experiments", "/devices?tab=experiments"],
  ["activity", `/devices?tab=activity&code=${code}`],
  ["builder", `/devices?tab=builder&code=${code}`],
  ["legacy-redirect", `/device?code=${code}`],
]

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
// Only the dashboard bundle's own errors fail the run. Quartz's site-wide mermaid script throws on
// every JQI page (it expects a `.center` element the JQI frame does not render) — not ours.
page.on("pageerror", (error) => {
  if (/member-tools/.test(error.stack ?? "")) errors.push(error.stack)
})
await page.goto(`${base}/auth/login?next=/devices`)
for (const [name, href] of shots) {
  await page.goto(base + href)
  await page.waitForSelector(".dash-panel", { timeout: 15_000 })
  await page.waitForTimeout(2500) // one poll + a few SSE frames + ticks
  if (name === "legacy-redirect" && !page.url().includes("/devices?tab=device"))
    throw new Error(`legacy page did not redirect: ${page.url()}`)
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true })
  console.log(`   ${name}.png  ${page.url().replace(base, "")}`)
}
await browser.close()
if (errors.length) {
  console.error("page errors:\n" + errors.join("\n"))
  process.exit(1)
}
