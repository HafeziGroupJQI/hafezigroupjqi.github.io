// Pure presentation helpers shared by the build and its regression checks.
export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c])

export function relativeUrl(from, target) {
  const depth = from.split("/").length - 1
  return "../".repeat(depth) + target.replace(/\/index$/, "/")
}

export const groups = ["Group Leads", "Postdoctoral Researchers", "Graduate Students", "Undergraduate Students", "High School Students", "Alumni"]
export const groupId = (group) => group.toLowerCase().replace(/[^a-z0-9]+/g, "-")

export function excerpt(body) {
  const paragraph = body.split(/\n\s*\n/).find((p) => p.trim() && !/^(?:!|#|>|<|Group lead:)/.test(p.trim())) ?? ""
  return paragraph.replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim()
}

export function firstImage(record) {
  return record.fm.photo || record.body.match(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/)?.[1]
}

export function cards(records, from, { people = false } = {}) {
  return `<div class="${people ? "people-grid" : "feature-grid"}">` + records.map((record) => {
    const title = escapeHtml(String(record.fm.title).trim())
    const href = escapeHtml(relativeUrl(from, record.slug))
    const photo = firstImage(record)
    const picture = photo ? `<img src="${escapeHtml(relativeUrl(from, photo))}" alt="${title}" loading="lazy" width="360" height="360">` : people ? '<div class="person-no-photo">Photo unavailable</div>' : ""
    const detail = people ? record.fm.role : record.fm.description ?? record.fm.summary ?? excerpt(record.body)
    const date = record.fm.type === "news" && record.fm.date ? `<p class="news-date"><time datetime="${escapeHtml(record.fm.date)}">${escapeHtml(record.fm.date)}</time></p>` : ""
    return `<article class="${people ? "person-card" : "feature-card"}"><a class="internal card-link" href="${href}">${picture}<h3>${title}</h3></a>${date}${detail ? `<p>${escapeHtml(detail)}</p>` : ""}</article>`
  }).join("\n") + "</div>"
}

export function peoplePage(records) {
  const people = records.filter((r) => r.fm.type === "person")
  const present = [...new Set([...groups, ...people.map((r) => r.fm.group || "Members")])]
    .filter((g) => people.some((r) => (r.fm.group || "Members") === g))
  return '<nav class="section-links" aria-label="People views"><a class="internal" href="../people/directory/">Contact directory</a><a class="internal" href="../onboarding/directions">Who is doing what</a>' + present.map((g) => `<a href="#${groupId(g)}">${escapeHtml(g)}</a>`).join("") + "</nav>\n\n" + present.map((g) => {
    const members = people.filter((r) => (r.fm.group || "Members") === g)
      .sort((a, b) => String(a.fm.title).trim().split(/\s+/).at(-1).localeCompare(String(b.fm.title).trim().split(/\s+/).at(-1)))
    return `<section class="people-section" aria-labelledby="${groupId(g)}"><h2 id="${groupId(g)}">${escapeHtml(g)}</h2>\n${cards(members, "people/index", { people: true })}</section>`
  }).join("\n\n")
}

export function publicationList(records, from) {
  return '<ul class="publication-list">' + records.map((r) => `<li><h3><a class="internal" href="${escapeHtml(relativeUrl(from, r.slug))}">${escapeHtml(r.fm.title)}</a></h3><p>${escapeHtml([Array.isArray(r.fm.authors) ? r.fm.authors.join(", ") : r.fm.authors, r.fm.venue, r.fm.year].filter(Boolean).join(" · "))}</p></li>`).join("\n") + "</ul>"
}

export function profileContact(fm) {
  const fields = [["Email", fm.email], ["Building", fm.building], ["Office", fm.office], ["Ask me about", fm.scope]]
    .filter(([, value]) => value && value !== "TBD")
  if (!fields.length) return ""
  return '<section class="profile-contact"><h2>Contact Information</h2><dl>' + fields.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${label === "Email" && /^[^\s@]+@[^\s@]+$/.test(value) ? `<a href="mailto:${escapeHtml(value)}">${escapeHtml(value)}</a>` : escapeHtml(value)}</dd></div>`).join("") + "</dl></section>"
}

// Rewrite known legacy destinations only, including wiki links and Markdown links.
export function rewriteLinks(text) {
  return text.replace(/\[\[people\/Directory(?:\.base)?(?=[|\]#])/g, "[[people/directory/index")
    .replace(/\[\[people\/index\|Directory\]\]/g, "[[people/directory/index|Contact directory]]")
    .replace(/\[\[welcome(?=[|\]#])/g, "[[onboarding/welcome")
    .replace(/\]\((?:\.\/)?people\/Directory(?:\.base)?(?=[)#])/g, "](people/directory/index")
}
