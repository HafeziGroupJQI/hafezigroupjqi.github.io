// Build a website view of the vault in a disposable directory. Never edit the vault.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  alumniPage,
  cards,
  peoplePage,
  placesPage,
  publicationList,
  rewriteLinks,
  profileContact,
} from "./site-model.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
export function prepareSite(source, yaml, { mode = "public" } = {}) {
  const parse = (text) => {
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
    return {
      fm: match ? (yaml.parse(match[1]) ?? {}) : {},
      body: match ? text.slice(match[0].length).trim() : text,
    }
  }
  const format = ({ fm, body }) => `---\n${yaml.stringify(fm)}---\n\n${body}\n`
  const input = fs.realpathSync(path.resolve(root, source))
  // Quartz honors Git ignores, so stage content outside the ignored repo cache.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-site-"))
  const output = path.join(stage, "content")
  fs.cpSync(input, output, { recursive: true })
  // Source-control ignores are useful in the vault, but Quartz also reads them
  // after Quarto runs. Keeping this file would hide freshly generated *_files
  // figure directories from the asset emitter.
  fs.rmSync(path.join(output, ".gitignore"), { force: true })
  const freeze = path.join(input, "_freeze")
  if (fs.existsSync(freeze)) {
    fs.mkdirSync(path.join(stage, "_freeze"), { recursive: true })
    fs.cpSync(freeze, path.join(stage, "_freeze", "content"), { recursive: true })
    fs.rmSync(path.join(output, "_freeze"), { recursive: true, force: true })
  }
  const config = [
    path.join(input, "_quarto.yml"),
    path.join(path.dirname(input), "_quarto.yml"),
  ].find(fs.existsSync)
  if (config) fs.copyFileSync(config, path.join(stage, "_quarto.yml"))
  const records = walk(output)
    .filter((f) => f.endsWith(".md"))
    .map((file) => ({
      ...parse(fs.readFileSync(file, "utf8")),
      slug: path.relative(output, file).replace(/\\/g, "/").replace(/\.md$/, ""),
    }))
  const get = (slug) => records.find((r) => r.slug === slug)
  const manifest = records
    .filter((r) => typeof r.fm.source === "string")
    .map((r) => ({ source: r.fm.source, slug: r.slug }))
  const write = (slug, fm, body) => {
    const target = path.join(output, slug + ".md")
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, format({ fm, body: rewriteLinks(body) }))
  }
  // These are website landing pages, so suppress Quartz's automatic file listing.
  const page = (slug, title, body, extra = {}) =>
    write(
      slug,
      {
        title,
        type: "page",
        tags: mode === "internal" ? ["internal"] : [],
        ...(mode === "public" ? { site_public: true } : { site_internal: true }),
        ...extra,
      },
      body,
    )
  if (mode === "internal") {
    const sections = [
      [
        "Journal club",
        "journal-club",
        "Session write-ups, discussion notes, drawings, recordings, and papers.",
      ],
      ["Notes", "notes", "Internal meeting notes, planning documents, and handoffs."],
      ["Projects", "projects", "Current project logs, priorities, and recovered plans."],
      ["Code", "code", "Runnable analyses and notes for the lab's software repositories."],
      ["Drive", "drive", "The indexed catalogue of shared-drive content."],
    ].filter(([, slug]) => fs.existsSync(path.join(output, slug)))
    page(
      "index",
      "Members vault",
      [
        '<div class="internal-portal-intro">',
        '<p class="internal-kicker">Hafezi Group · members only</p>',
        "# Shared knowledge for the lab",
        "Search working notes, code, project records, and session material from one authenticated place.",
        "</div>",
        '<div class="internal-portal-grid">',
        ...sections.map(
          ([title, slug, description]) =>
            `<a class="internal-portal-card" href="${slug}/"><strong>${title}</strong><span>${description}</span></a>`,
        ),
        "</div>",
      ].join("\n\n"),
      { site_home: true },
    )
    return { stage, output, manifest }
  }
  const welcome = get("index")
  if (welcome?.fm.title === "Welcome") {
    write(
      "onboarding/welcome",
      { ...welcome.fm, aliases: [...new Set([...(welcome.fm.aliases ?? []), "welcome"])] },
      welcome.body,
    )
    const onboarding = get("onboarding/index")
    if (onboarding)
      write(
        onboarding.slug,
        onboarding.fm,
        `[[onboarding/welcome|Welcome to the group]]\n\n${onboarding.body}`,
      )
  }
  const people = records.filter((r) => r.fm.type === "person")
  if (people.length) {
    page("people/index", "People", peoplePage(records))
    page("people/alumni/index", "Alumni", alumniPage(records), {
      tags: ["people", "people/alumni"],
    })
  }
  const placesSource = get("places/index")
  const placesFile = path.join(output, "places/places.yml")
  if (placesSource && fs.existsSync(placesFile)) {
    const directory = placesPage(yaml.parse(fs.readFileSync(placesFile, "utf8")), records)
    page(
      "places/index",
      "Places",
      placesSource.body.replace("<!-- places-directory -->", directory),
      { tags: placesSource.fm.tags },
    )
  }
  const research = records.filter((r) => r.fm.type === "research")
  const newest = (a, b) =>
    String(b.fm.date ?? b.fm.year ?? "").localeCompare(String(a.fm.date ?? a.fm.year ?? "")) ||
    String(a.fm.title).localeCompare(String(b.fm.title))
  const news = records.filter((r) => r.fm.type === "news").sort(newest)
  const publications = records.filter((r) => r.fm.type === "publication").sort(newest)
  if (research.length) page("research/index", "Research", cards(research, "research/index"))
  if (news.length)
    page(
      "news/index",
      "News",
      "[[news/News.base|Filter and sort news]]\n\n" + cards(news, "news/index"),
    )
  if (publications.length)
    page(
      "publications/index",
      "Publications",
      "[[publications/Publications.base|Filter and sort publications]]\n\n" +
        publicationList(publications, "publications/index"),
    )
  const home = get("index")
  if (!home) throw new Error("The vault must include index.md to build the public homepage")
  page(
    "index",
    home.fm.title,
    [
      home.body,
      "## Research",
      cards(research, "index"),
      "## Recent publications",
      publicationList(publications.slice(0, 3), "index"),
      "[[publications/index|View all publications]]",
      "## Recent news",
      cards(news.slice(0, 3), "index"),
      "[[news/index|View all news]]",
    ].join("\n\n"),
    { site_home: true, tags: home.fm.tags, description: home.fm.description },
  )
  // Preserve individual records and resources, adding only presentation metadata.
  for (const record of records) {
    if (
      [
        "index",
        "people/index",
        "people/alumni/index",
        "places/index",
        "research/index",
        "news/index",
        "publications/index",
      ].includes(record.slug) ||
      (record.slug === "onboarding/index" && welcome?.fm.title === "Welcome")
    )
      continue
    const publicPage =
      /^(people|places|research|news|publications)\//.test(record.slug) ||
      ["positions", "theses", "lab-facilities"].includes(record.slug)
    let body = record.body
    if (record.fm.type === "person") {
      const contact = profileContact(record.fm)
      const firstPhoto = body.match(/^!\[\[[^\]]+\]\]/)?.[0]
      body = firstPhoto
        ? body.replace(firstPhoto, firstPhoto + "\n\n" + contact)
        : contact + "\n\n" + body
    }
    write(
      record.slug,
      {
        ...record.fm,
        title: String(record.fm.title ?? record.slug).trim(),
        ...(publicPage ? { site_public: true } : {}),
      },
      body,
    )
  }
  return { stage, output, manifest }
}
