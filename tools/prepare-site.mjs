// Build a website view of the vault in a disposable directory. Never edit the vault.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cards, peoplePage, publicationList, rewriteLinks, profileContact } from "./site-model.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const walk = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]))
export function prepareSite(source, yaml) {
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
  const config = path.join(path.dirname(input), "_quarto.yml")
  if (fs.existsSync(config)) fs.copyFileSync(config, path.join(stage, "_quarto.yml"))
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
    write(slug, { title, type: "page", site_public: true, ...extra }, body)
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
    page(
      "people/directory/index",
      "Contact directory",
      [
        "[[people/index|People and photos]] · [[onboarding/directions|Who is doing what]]",
        "Contact information, offices, and research interests. Choose a view below to browse current members, projects, or alumni.",
        "> [!warning] Needs verification\n> Office numbers and research interests marked TBD have not yet been confirmed.",
        "![[people/directory/contacts.base]]",
      ].join("\n\n"),
    )
    const oldBase = path.join(output, "people/Directory.base")
    if (fs.existsSync(oldBase)) {
      const base = yaml.parse(fs.readFileSync(oldBase, "utf8"))
      base.views = base.views.filter((v) => v.type !== "cards")
      fs.writeFileSync(path.join(output, "people/directory/contacts.base"), yaml.stringify(base))
      // Keep legacy incoming URLs working without a duplicate sidebar entry.
      fs.unlinkSync(oldBase)
      const canonical = parse(
        fs.readFileSync(path.join(output, "people/directory/index.md"), "utf8"),
      )
      write(
        "people/directory/index",
        { ...canonical.fm, aliases: ["people/Directory"] },
        canonical.body,
      )
    }
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
  const about = get("about")
  if (!about) throw new Error("The vault must include about.md to build the public homepage")
  const hero = about.body.match(/!\[\[[^\]]+\]\]/)?.[0] ?? ""
  const aboutText = about.body
    .replace(hero, "")
    .replace(/\nGroup lead:[\s\S]*$/, "")
    .trim()
  page(
    "index",
    "Hafezi Group",
    [
      hero,
      "## About",
      aboutText,
      "## Research",
      cards(research, "index"),
      "## Research Publications",
      publicationList(publications.slice(0, 3), "index"),
      "[[publications/index|View All Group Publications]]",
      "## News",
      cards(news.slice(0, 3), "index"),
      "[[news/index|View All Group News]]",
    ].join("\n\n"),
    { site_home: true },
  )
  // Preserve individual records and resources, adding only presentation metadata.
  for (const record of records) {
    if (
      ["index", "people/index", "research/index", "news/index", "publications/index"].includes(
        record.slug,
      ) ||
      (record.slug === "onboarding/index" && welcome?.fm.title === "Welcome")
    )
      continue
    const publicPage =
      /^(people|research|news|publications)\//.test(record.slug) ||
      ["about", "positions", "theses", "lab-facilities"].includes(record.slug)
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
