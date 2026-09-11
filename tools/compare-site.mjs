// Run after npm run build. This audits text parity, not screenshot/layout parity.
import fs from "node:fs/promises"
import path from "node:path"

const output = path.resolve(process.argv[2] ?? "public")
const origin = "https://hafezi.jqi.umd.edu"
const normalize = (html) => html.replace(/<script\b[\s\S]*?<\/script>/gi, "")
  .replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ")
  .replace(/&(?:nbsp|#160);/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"')
  .replace(/&#(?:39|x27);/g, "'").replace(/[’‘]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, " ").trim()
const main = (html) => (html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html)
  .replace(/<(?:nav|aside)\b[^>]*>[\s\S]*?<\/(?:nav|aside)>/gi, "")
const blocks = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((m) => normalize(m[1])).filter(Boolean)
const indexRoutes = ["", "people", "research", "news", "publications", "positions", "lab-facilities", "theses"]
const manifest = JSON.parse(await fs.readFile(".cache/site-source-map.json", "utf8"))
const routes = new Map(indexRoutes.map((route) => [`${origin}/${route}`, ["", "people", "research", "news", "publications"].includes(route) ? (route ? route + "/index" : "index") : route]))
for (const record of manifest) {
  if (record.source.replace(/\/$/, "") === origin) continue
  if (new URL(record.source).origin === origin) routes.set(record.source.replace(/\/$/, ""), record.slug)
}
const report = { generated: new Date().toISOString(), kind: "HTML content comparison; visual validation required separately", pages: [] }
for (const [url, slug] of routes) {
  try {
    const local = await fs.readFile(path.join(output, slug + ".html"), "utf8")
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!response.ok) throw new Error(`Live page returned HTTP ${response.status}`)
    const live = main(await response.text())
    const text = normalize(main(local))
    const missingHeadings = [...new Set(blocks(live, "h[1-4]").filter((s) => !text.includes(s)))]
    const missingParagraphs = [...new Set(blocks(live, "p").filter((s) => s.length > 40 && !text.includes(s)))]
    const missingChrome = ["Research", "People", "Positions", "News", "Publications", "Lab Facilities", "Theses", "Contact Us", "jqi-info@umd.edu", "Privacy Policy", "Web Accessibility"].filter((s) => !normalize(local).includes(s))
    report.pages.push({ url, slug, missingHeadings, missingParagraphs, missingChrome })
    console.log(`${slug}: ${missingHeadings.length} missing headings, ${missingParagraphs.length} missing paragraphs`)
  } catch (error) {
    report.pages.push({ url, slug, error: error.message })
    console.error(`${slug}: ${error.message}`)
  }
}
await fs.writeFile(".cache/parity-report.json", JSON.stringify(report, null, 2))
process.exitCode = report.pages.some((p) => p.error || p.missingHeadings.length || p.missingParagraphs.length || p.missingChrome.length) ? 1 : 0
