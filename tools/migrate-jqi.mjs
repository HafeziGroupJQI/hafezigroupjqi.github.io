// One-off migration of hafezi.jqi.umd.edu (Gatsby + Drupal) into the vault.
// Reads the sitemap, fetches each page's structured page-data.json, and writes
// markdown records with frontmatter into ../vault/content (people, publications,
// news, research, static pages) plus images under content/assets/. Every page
// carries `source:` (original URL) and `migrated:` (date) so nothing is lost.
//
// Usage: node tools/migrate-jqi.mjs [--vault ../vault] [--only people,publications,...]
// Re-running is safe: page-data is cached under .cache/jqi/, existing person
// records keep their hand-maintained fields (building, office, scope, projects).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import yaml from "yaml"
import TurndownService from "turndown"

const SITE = "https://hafezi.jqi.umd.edu"
const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const argv = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const VAULT = path.resolve(here, "..", argv("--vault", "../vault"))
const CONTENT = path.join(VAULT, "content")
const ONLY = argv("--only", "people,publications,news,research,pages").split(",")
const CACHE = path.join(here, "..", ".cache", "jqi")
const TODAY = new Date().toISOString().slice(0, 10)
fs.mkdirSync(CACHE, { recursive: true })

const td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" })
td.remove(["script", "style"])
const html2md = (html) => (html ? td.turndown(html).replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim() : "")
// Drupal-hosted inline images (/sites/default/files/...) are downloaded next to the
// section's assets and the src rewritten relative to the page's folder.
async function localizeImages(html, section, depth) {
  if (!html) return ""
  const prefix = "../".repeat(depth)
  for (const m of [...html.matchAll(/src="(\/sites\/default\/files\/[^"]+)"/g)]) {
    const name = decodeURIComponent(path.basename(new URL(abs(m[1])).pathname))
    const rel = await download(m[1], `assets/${section}/inline/${name}`)
    if (rel) html = html.split(m[1]).join(prefix + rel)
    else html = html.replace(new RegExp(`<img[^>]*src="${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>`, "g"), "")
  }
  return html.replace(/<img([^>]*?)\s+(width|height|style)="[^"]*"/g, "<img$1")
}

const slugify = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
const yq = (v) => yaml.stringify(v).trimEnd()
const fmt = (fm, body) => "---\n" + yq(fm) + "\n---\n\n" + body.trimEnd() + "\n"
const write = (rel, text) => { const p = path.join(CONTENT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text) }
const abs = (u) => (u.startsWith("http") ? u : SITE + u)

async function fetchJson(pagePath) {
  const p = pagePath.replace(/^\/|\/$/g, "") || "index"
  const cache = path.join(CACHE, p.replace(/\//g, "__") + ".json")
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, "utf8"))
  const r = await fetch(`${SITE}/page-data/${p}/page-data.json`)
  if (!r.ok) throw new Error(`${r.status} ${pagePath}`)
  const j = await r.json()
  fs.writeFileSync(cache, JSON.stringify(j))
  return j
}
async function download(url, rel) {
  const dest = path.join(CONTENT, rel)
  if (fs.existsSync(dest)) return rel
  let r = await fetch(abs(url))
  // Drupal-hosted files may only exist on the JQI parent site
  if (!r.ok && url.startsWith("/sites/default/files/")) r = await fetch("https://jqi.umd.edu" + url)
  if (!r.ok) { console.warn(`  image ${r.status}: ${url}`); return null }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
  return rel
}
// largest image from a gatsbyImageData node
function imageUrl(node) {
  const gid = node?.relationships?.mediaImage?.localFile?.childImageSharp?.gatsbyImageData ?? node?.localFile?.childImageSharp?.gatsbyImageData
  const fb = gid?.images?.fallback
  if (!fb) return null
  const set = (fb.srcSet ?? "").split(",").map((s) => s.trim().split(" ")[0]).filter(Boolean)
  return set.length ? set[set.length - 1] : fb.src
}
const ext = (u) => (path.extname(new URL(abs(u)).pathname) || ".jpg").toLowerCase()

// ---------- sitemap ----------
const sitemap = await (await fetch(`${SITE}/sitemap-0.xml`)).text()
const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname.replace(/\/$/, ""))
const bySection = (s) => urls.filter((u) => u.startsWith(`/${s}/`))
console.log(`sitemap: ${urls.length} urls`)

// ---------- people ----------
const GROUP_OF = {
  mahmoudData: ["Group Leads", "role/lead"], researcherData: ["Postdoctoral Researchers", "role/postdoc"],
  graduateStudentData: ["Graduate Students", "role/grad"], undergraduateStudentData: ["Undergraduate Students", "role/undergrad"],
  highSchoolStudentData: ["High School Students", "role/highschool"], alumniData: ["Alumni", "role/alumni"],
}
const peopleGroup = new Map() // pagePath -> [group, tag]
if (ONLY.includes("people")) {
  const idx = (await fetchJson("/people")).result.data
  const lead = idx.content?.relationships?.groupLead
  if (lead?.fields?.pagePath) peopleGroup.set(lead.fields.pagePath, ["Group Leads", "role/lead"])
  for (const [key, [group, tag]] of Object.entries(GROUP_OF)) {
    const bucket = idx[key] ?? {}
    const list = Object.values(bucket).find((v) => Array.isArray(v)) ?? []
    for (const p of list) if (p?.fields?.pagePath && !peopleGroup.has(p.fields.pagePath)) peopleGroup.set(p.fields.pagePath, [group, tag])
  }
  console.log(`people index: ${peopleGroup.size} classified`)
  let n = 0
  for (const u of bySection("people")) {
    const page = (await fetchJson(u)).result.data.page
    if (!page) continue
    const slug = slugify(page.name)
    const file = `people/${slug}.md`
    const existing = fs.existsSync(path.join(CONTENT, file)) ? fs.readFileSync(path.join(CONTENT, file), "utf8") : null
    const old = existing?.match(/^---\n([\s\S]*?)\n---\n/) ? yaml.parse(existing.match(/^---\n([\s\S]*?)\n---\n/)[1]) : {}
    const [group, roleTag] = peopleGroup.get(u) ?? (old.group ? [old.group, "role/" + ({ "Group Leads": "lead", "Postdoctoral Researchers": "postdoc", "Graduate Students": "grad", "Undergraduate Students": "undergrad", "High School Students": "highschool", "Alumni": "alumni" }[old.group] ?? "member")] : ["Alumni", "role/alumni"])
    const email = page.relationships?.contactInfo?.find?.((c) => c.email)?.email ?? page.contactInfo?.find?.((c) => c.email)?.email ?? old.email ?? "TBD"
    const img = imageUrl(page.relationships?.image)
    const photo = img ? await download(img, `assets/people/${slug}${ext(img)}`) : null
    const areas = (page.relationships?.researchAreas ?? []).map((a) => a.title ?? a.name).filter(Boolean)
    const fm = {
      title: page.name, type: "person", role: page.personTitle ?? old.role ?? "", group,
      building: old.building ?? "TBD", office: old.office ?? "TBD", email, scope: old.scope ?? "TBD",
      profile: `${SITE}${u}`, photo: photo ? `assets/people/${path.basename(photo)}` : null,
      research_areas: areas, projects: old.projects ?? [],
      source: `${SITE}${u}`, migrated: TODAY,
      tags: ["people", roleTag, ...(old.tags ?? []).filter((t) => t.startsWith("people/") )],
    }
    const bio = html2md(page.bio?.processed ?? page.bio ?? "")
    const body = [
      photo ? `![[${fm.photo}]]` : "",
      `${page.name}${page.personTitle ? ", " + page.personTitle : ""}. Main-site profile: ${SITE}${u}`,
      bio,
      areas.length ? "Research areas: " + areas.join(", ") : "",
      "> [!info] Keep your own record current\n> Office, email, \"ask me about\" scope, and `projects` feed the [[people/Directory.base|directory]] and [[onboarding/directions|Current Directions]] pages. Edit the frontmatter above.",
    ].filter(Boolean).join("\n\n")
    write(file, fmt(fm, body)); n++
  }
  console.log(`people: ${n} records`)
}

// ---------- publications ----------
if (ONLY.includes("publications")) {
  const bib = []
  let n = 0
  for (const u of bySection("publications")) {
    const page = (await fetchJson(u)).result.data.page
    if (!page) continue
    const slug = u.split("/").pop()
    const authors = (page.relationships?.authors ?? []).map((a) => [a.firstName, a.middleName, a.lastName].filter(Boolean).join(" "))
    const venue = page.journal ?? page.conferenceName ?? page.bookTitle ?? page.publisher ?? null
    const year = Number(page.year) || null
    const kind = page.relationships?.referenceType?.label ?? null
    const areas = (page.relationships?.researchAreas ?? []).map((a) => a.title ?? a.name).filter(Boolean)
    const fm = {
      title: page.title.trim(), type: "publication", year, authors, venue, doi: page.doi ?? null, url: page.url ?? null,
      pub_type: kind, volume: page.volume ?? null, issue: page.issue ?? null, pages: page.startPage ?? null,
      // sortable date: MM/YYYY from Drupal when present, else January of the year
      date: (page.datePublished?.match(/^(\d{2})\/(\d{4})$/) ? `${page.datePublished.slice(3)}-${page.datePublished.slice(0, 2)}-01` : year ? `${year}-01-01` : null),
      published_on: page.datePublished ?? null,
      research_areas: areas, source: `${SITE}${u}`, migrated: TODAY,
      tags: ["publications", ...(year ? [`pub/${year}`] : []), ...areas.map((a) => `research/${slugify(a)}`)],
    }
    const links = [page.doi ? `[doi:${page.doi}](https://doi.org/${page.doi})` : null, page.url ? `[link](${page.url})` : null].filter(Boolean).join(" · ")
    const body = [
      `${authors.join(", ")}${venue ? ". *" + venue + "*" : ""}${year ? " (" + year + ")" : ""}.`,
      links, html2md(page.abstract?.processed ?? page.abstract ?? ""),
    ].filter(Boolean).join("\n\n")
    write(`publications/${slug}.md`, fmt(fm, body)); n++
    const key = slugify((authors[0] ?? "anon").split(" ").pop() + "-" + (year ?? "") + "-" + slug.split("-").slice(0, 2).join("-"))
    bib.push(`@article{${key},\n  title = {${page.title.trim()}},\n  author = {${authors.join(" and ")}},\n  year = {${year ?? ""}},\n  journal = {${venue ?? ""}},\n  doi = {${page.doi ?? ""}},\n  url = {${page.url ?? ""}}\n}`)
  }
  write("publications/publications.bib", bib.join("\n\n") + "\n")
  console.log(`publications: ${n} records`)
}

// ---------- news ----------
if (ONLY.includes("news")) {
  let n = 0
  for (const u of bySection("news")) {
    const page = (await fetchJson(u)).result.data.page
    if (!page) continue
    const slug = u.split("/").pop()
    const date = page.date ? new Date(page.date + " UTC").toISOString().slice(0, 10) : page.created.slice(0, 10)
    const hero = imageUrl(page.relationships?.hero?.relationships?.heroImage)
    const img = hero ? await download(hero, `assets/news/${slug}${ext(hero)}`) : null
    const people = (page.relationships?.people ?? []).map((p) => p.name).filter(Boolean)
    const areas = (page.relationships?.researchAreas ?? []).map((a) => a.title ?? a.name).filter(Boolean)
    const fm = {
      title: page.title.trim(), type: "news", date, people, research_areas: areas,
      source: `${SITE}${u}`, migrated: TODAY, tags: ["news", `news/${date.slice(0, 4)}`, ...areas.map((a) => `research/${slugify(a)}`)],
    }
    const hasRecord = (name) => fs.existsSync(path.join(CONTENT, `people/${slugify(name)}.md`))
    const body = [img ? `![[assets/news/${path.basename(img)}]]` : "", html2md(await localizeImages(page.body?.processed ?? "", "news", 1)),
      people.length ? "People: " + people.map((p) => (hasRecord(p) ? `[[people/${slugify(p)}|${p}]]` : p)).join(", ") : ""].filter(Boolean).join("\n\n")
    write(`news/${date}-${slug}.md`, fmt(fm, body)); n++
  }
  console.log(`news: ${n} posts`)
}

// ---------- research areas ----------
if (ONLY.includes("research")) {
  let n = 0
  for (const u of bySection("research")) {
    const data = (await fetchJson(u)).result.data
    const page = data.page
    if (!page) continue
    const slug = u.split("/").pop()
    const hero = imageUrl(page.relationships?.hero?.relationships?.heroImage)
    const img = hero ? await download(hero, `assets/research/${slug}${ext(hero)}`) : null
    const pubs = (page.relationships?.widgets ?? []).flatMap((w) => w.publications ?? w.relationships?.publications ?? [])
    const fm = { title: page.title.trim(), type: "research", source: `${SITE}${u}`, migrated: TODAY, tags: ["research", `research/${slug}`] }
    const body = [img ? `![[assets/research/${path.basename(img)}]]` : "", page.relationships?.hero?.caption ?? "", html2md(await localizeImages(page.body?.processed ?? "", "research", 1)),
      pubs.length ? "## Related publications\n\n" + pubs.map((p) => `- [[publications/${(p.fields?.pagePath ?? "").split("/").pop()}|${p.title?.trim() ?? ""}]]`).join("\n") : ""].filter(Boolean).join("\n\n")
    write(`research/${slug}.md`, fmt(fm, body)); n++
  }
  console.log(`research: ${n} areas`)
}

// ---------- static pages ----------
if (ONLY.includes("pages")) {
  for (const p of ["theses", "positions", "lab-facilities"]) {
    const page = (await fetchJson(`/${p}`)).result.data.page
    if (!page) continue
    const imgs = []
    for (const [i, w] of (page.relationships?.widgets ?? []).entries()) {
      const src = imageUrl(w.relationships?.heroImage)
      if (src) { const rel = await download(src, `assets/${p}/${p}-${i + 1}${ext(src)}`); if (rel) imgs.push(`![[${rel}]]` + (w.caption ? `\n*${w.caption}*` : "")) }
    }
    const fm = { title: page.title.trim(), type: "page", source: `${SITE}/${p}`, migrated: TODAY, tags: [p] }
    write(`${p}.md`, fmt(fm, [html2md(await localizeImages(page.body?.processed ?? "", p, 0)), ...imgs].filter(Boolean).join("\n\n")))
  }
  const home = (await fetchJson("/")).result.data.content
  const heroSrc = imageUrl(home?.relationships?.hero?.relationships?.heroImage)
  const hero = heroSrc ? await download(heroSrc, `assets/about/hero${ext(heroSrc)}`) : null
  write("about.md", fmt({ title: "About the group", type: "page", source: `${SITE}/`, migrated: TODAY, tags: ["about"] },
    [hero ? `![[${hero}]]` : "", html2md(home?.about?.processed ?? ""), "Group lead: [[people/mohammad-hafezi|Mohammad Hafezi]]. See [[research/index|Research]], [[people/index|People]], and [[publications/index|Publications]]."].filter(Boolean).join("\n\n")))
  console.log("pages: theses, positions, lab-facilities, about")
}
console.log("done")
