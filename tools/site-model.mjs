// Pure presentation helpers shared by the build and its regression checks.
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  )

export function relativeUrl(from, target) {
  const depth = from.split("/").length - 1
  return "../".repeat(depth) + target.replace(/\/index$/, "/")
}

export const groups = [
  "Group Leads",
  "Postdoctoral Researchers",
  "Graduate Students",
  "Undergraduate Students",
  "High School Students",
  "Alumni",
]
export const groupId = (group) => group.toLowerCase().replace(/[^a-z0-9]+/g, "-")

export function excerpt(body) {
  const paragraph =
    body.split(/\n\s*\n/).find((p) => p.trim() && !/^(?:!|#|>|<|Group lead:)/.test(p.trim())) ?? ""
  return paragraph
    .replace(/\[\[([^|\]]+\|)?([^\]]+)\]\]/g, "$2")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function shorten(value, limit = 36) {
  const words = String(value ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  return words.length > limit ? `${words.slice(0, limit).join(" ")}…` : words.join(" ")
}

export function firstImage(record) {
  return record.fm.photo || record.body.match(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/)?.[1]
}

export function cards(records, from, { people = false } = {}) {
  return (
    `<div class="${people ? "people-grid" : "feature-grid"}">` +
    records
      .map((record) => {
        const title = escapeHtml(String(record.fm.title).trim())
        const href = escapeHtml(relativeUrl(from, record.slug))
        const photo = firstImage(record)
        const picture = photo
          ? `<img src="${escapeHtml(relativeUrl(from, photo))}" alt="${title}" loading="lazy" width="360" height="360">`
          : people
            ? '<div class="person-no-photo">Photo unavailable</div>'
            : ""
        const detail = shorten(
          people
            ? record.fm.role
            : (record.fm.description ?? record.fm.summary ?? excerpt(record.body)),
          people ? 16 : 34,
        )
        const date =
          record.fm.type === "news" && record.fm.date
            ? `<p class="news-date"><time datetime="${escapeHtml(record.fm.date)}">${escapeHtml(record.fm.date)}</time></p>`
            : ""
        return `<article class="${people ? "person-card" : "feature-card"}"><a class="internal card-link" href="${href}">${picture}<h3>${title}</h3></a>${date}${detail ? `<p>${escapeHtml(detail)}</p>` : ""}</article>`
      })
      .join("\n") +
    "</div>"
  )
}

export function peoplePage(records) {
  const people = records.filter((r) => r.fm.type === "person" && r.fm.group !== "Alumni")
  const present = [...new Set([...groups, ...people.map((r) => r.fm.group || "Members")])].filter(
    (g) => people.some((r) => (r.fm.group || "Members") === g),
  )
  return (
    '<nav class="section-links" aria-label="People views"><a class="internal" href="../people/directory/">Contact directory</a><a class="internal" href="../places/">Places</a><a class="internal" href="../people/alumni/">Alumni</a>' +
    present.map((g) => `<a href="#${groupId(g)}">${escapeHtml(g)}</a>`).join("") +
    "</nav>\n\n" +
    present
      .map((g) => {
        const members = people
          .filter((r) => (r.fm.group || "Members") === g)
          .sort((a, b) =>
            String(a.fm.title)
              .trim()
              .split(/\s+/)
              .at(-1)
              .localeCompare(String(b.fm.title).trim().split(/\s+/).at(-1)),
          )
        return `<section class="people-section" aria-labelledby="${groupId(g)}"><h2 id="${groupId(g)}">${escapeHtml(g)}</h2>\n${cards(members, "people/index", { people: true })}</section>`
      })
      .join("\n\n")
  )
}

export function alumniPage(records) {
  const alumni = records
    .filter((r) => r.fm.type === "person" && r.fm.group === "Alumni")
    .sort((a, b) => String(a.fm.title).trim().localeCompare(String(b.fm.title).trim()))
  return (
    '<div class="alumni-list">' +
    alumni
      .map((record) => {
        const title = escapeHtml(String(record.fm.title).trim())
        const role = escapeHtml(shorten(record.fm.role, 22))
        const href = escapeHtml(relativeUrl("people/alumni/index", record.slug))
        return `<article><h2><a class="internal" href="${href}">${title}</a></h2>${role ? `<p>${role}</p>` : ""}</article>`
      })
      .join("\n") +
    "</div>"
  )
}

export function placesPage(data, records) {
  const places = data?.places ?? []
  const byId = new Map(places.map((place) => [place.id, place]))
  const people = new Map(
    records
      .filter((record) => record.fm.type === "person")
      .map((record) => [record.slug.split("/").at(-1), record]),
  )
  const groups = [
    ["building", "Buildings"],
    ["office", "Offices"],
    ["lab", "Laboratories"],
    ["shared", "Shared spaces"],
    ["service", "Services"],
  ]
  return (
    '<div class="places-directory">' +
    groups
      .map(([kind, label]) => {
        const matches = places.filter((place) => place.kind === kind)
        if (!matches.length) return ""
        const cards = matches
          .map((place) => {
            const building = byId.get(place.building)
            const location = [
              building?.short_name ?? building?.name,
              place.room && `Room ${place.room}`,
              place.floor,
            ]
              .filter(Boolean)
              .map(escapeHtml)
              .join(" · ")
            const occupants = (place.occupants ?? [])
              .map((slug) => {
                const person = people.get(slug)
                return person
                  ? `<a class="internal" href="${escapeHtml(relativeUrl("places/index", person.slug))}">${escapeHtml(String(person.fm.title).trim())}</a>`
                  : ""
              })
              .filter(Boolean)
              .join(", ")
            const status =
              place.status === "needs-details"
                ? '<span class="place-status">details needed</span>'
                : ""
            return `<article class="place-card"><div class="place-card__heading"><h3>${escapeHtml(place.name)}</h3>${status}</div>${location ? `<p class="place-location">${location}</p>` : ""}${place.address ? `<address>${escapeHtml(place.address)}</address>` : ""}${place.description ? `<p>${escapeHtml(place.description)}</p>` : ""}${occupants ? `<p class="place-occupants"><strong>People:</strong> ${occupants}</p>` : ""}</article>`
          })
          .join("\n")
        return `<section class="place-group" aria-labelledby="places-${kind}"><h2 id="places-${kind}">${label}</h2><div class="place-grid">${cards}</div></section>`
      })
      .join("\n") +
    "</div>"
  )
}

export function publicationList(records, from) {
  return (
    '<ul class="publication-list">' +
    records
      .map((r) => {
        const authors = Array.isArray(r.fm.authors)
          ? r.fm.authors.length > 6
            ? `${r.fm.authors.slice(0, 5).join(", ")}, et al.`
            : r.fm.authors.join(", ")
          : shorten(r.fm.authors, 24)
        const meta = [authors, r.fm.venue, r.fm.year].filter(Boolean).join(" · ")
        return `<li><h3><a class="internal" href="${escapeHtml(relativeUrl(from, r.slug))}">${escapeHtml(r.fm.title)}</a></h3><p>${escapeHtml(meta)}</p></li>`
      })
      .join("\n") +
    "</ul>"
  )
}

export function profileContact(fm) {
  const fields = [
    ["Role", fm.role],
    ["Email", fm.email],
    ["Building", fm.building],
    ["Office", fm.office],
    ["Ask me about", fm.scope],
  ].filter(([, value]) => value && value !== "TBD")
  if (!fields.length) return ""
  return (
    '<section class="profile-contact"><h2>Contact Information</h2><dl>' +
    fields
      .map(
        ([label, value]) =>
          `<div><dt>${label}</dt><dd>${label === "Email" && /^[^\s@]+@[^\s@]+$/.test(value) ? `<a href="mailto:${escapeHtml(value)}">${escapeHtml(value)}</a>` : escapeHtml(value)}</dd></div>`,
      )
      .join("") +
    "</dl></section>"
  )
}

// Rewrite known legacy destinations only, including wiki links and Markdown links.
export function rewriteLinks(text) {
  return text
    .replace(/\[\[people\/Directory(?:\.base)?(?=[|\]#])/g, "[[people/directory/index")
    .replace(/\[\[people\/index\|Directory\]\]/g, "[[people/directory/index|Contact directory]]")
    .replace(/\[\[welcome(?=[|\]#])/g, "[[onboarding/index")
    .replace(/\]\((?:\.\/)?people\/Directory(?:\.base)?(?=[)#])/g, "](people/directory/index")
}
