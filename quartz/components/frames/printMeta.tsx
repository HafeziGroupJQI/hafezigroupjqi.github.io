import { FullSlug, simplifySlug } from "../../util/path"

// What a printed page (and the PDF the build prints of it, tools/render-pdfs.mjs) says about
// itself, set at build time by JqiFrame under the page's title: a title block that only paper
// shows (.print-meta: the edition, the site's trail to the page, its authors and date, and its
// address), and the strings of the running header and footer on every page after the first
// (--print-brand, --print-title and --print-url on :root, which quartz/styles/print.scss's @page
// margin boxes read).

const SITE = "Hafezi Group"

/**
 * `text` as a CSS string literal: quoted, with quotes, backslashes and line breaks escaped, and
 * every < as \3c, so no text can end the <style> element it is written in.
 */
export function cssString(text: string): string {
  const escaped = text
    .replace(/[\\"]/g, (character) => `\\${character}`)
    .replace(/\r\n?|[\n\f]/g, "\\a ")
    .replace(/</g, "\\3c ")
  return `"${escaped}"`
}

/** The title as the running header shows it: on one line, cut to `max` characters with "…". */
export function printTitle(title: string, max = 70): string {
  const text = title.replace(/\s+/g, " ").trim()
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

/** Front matter authors ("authors" or "author", a list or one name) as "A", "A and B", "A, B and C" or "A, B, C et al.". */
export function authorsText(value: unknown): string | null {
  const names = (Array.isArray(value) ? value : [value])
    .filter((name) => typeof name === "string" || typeof name === "number")
    .map((name) => String(name).trim())
    .filter(Boolean)
  if (!names.length) return null
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} et al.`
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
}

/**
 * A front matter date as the title block writes it ("September 14, 2026"). A date alone is that
 * calendar day wherever it is read; a date with a time is its day in America/New_York, the lab's.
 */
export function dateText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  const text = value instanceof Date ? value.toISOString() : String(value).trim()
  const format = (date: Date, timeZone: string) =>
    new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone }).format(date)
  const day = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z)?$/)
  if (day) return format(new Date(Date.UTC(+day[1], +day[2] - 1, +day[3])), "UTC")
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : format(date, "America/New_York")
}

export interface PrintMetaInput {
  slug: string
  title: string
  /** The breadcrumb's sections between the home page and the page. */
  trail: string[]
  /** quartz.config's baseUrl: the site's host and path, without a scheme. */
  baseUrl?: string
  /** A page of the member edition's private resources. */
  members: boolean
  frontmatter?: Record<string, unknown>
}

/** What the title block and the running header say. Pure. */
export function printMeta({
  slug,
  title,
  trail,
  baseUrl,
  members,
  frontmatter = {},
}: PrintMetaInput) {
  const path = simplifySlug(slug as FullSlug)
  const host = (baseUrl ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "")
  const address = host ? `${host}/${path === "/" ? "" : path}` : ""
  // A publication's page opens with its citation, whose authors and year are the record's; its
  // front matter date is only a month's.
  const publication = frontmatter.type === "publication"
  const authors = publication ? null : authorsText(frontmatter.authors ?? frontmatter.author)
  const date = publication ? null : dateText(frontmatter.date)
  return {
    brand: members ? `${SITE} · Members only` : SITE,
    title: printTitle(title),
    url: address ? `https://${address}` : "",
    address,
    members,
    trail: [SITE, ...trail].join(" › "),
    authors,
    date,
  }
}

/** The title block and the running header's strings, placed right after the page's <h1>. */
export function PrintMeta(input: PrintMetaInput) {
  const meta = printMeta(input)
  const variables = [
    `--print-brand:${cssString(meta.brand)}`,
    `--print-title:${cssString(meta.title)}`,
    `--print-url:${cssString(meta.address)}`,
  ]
  const parts = [meta.trail, meta.authors && `By ${meta.authors}`, meta.date].filter(
    (part): part is string => !!part,
  )
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `:root{${variables.join(";")}}` }} />
      <div class="print-meta">
        {meta.members && (
          <>
            <span class="print-meta__edition">Members only</span>
            {" · "}
          </>
        )}
        {parts.join(" · ")}
        {meta.url && (
          <>
            {" · "}
            <a href={meta.url}>{meta.address}</a>
          </>
        )}
      </div>
    </>
  )
}
