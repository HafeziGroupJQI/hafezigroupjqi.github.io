// /settings, Appearance: a member's own dark mode and themes (worker/src/prefs.ts, D1
// member_prefs). Only the member sees them, on every device they sign in on; the public site and
// signed-out visitors keep the site's own look. Pointing at a theme shows it on the whole page;
// choosing it saves it. The themes are tools/themes/'s, the copy in the browser frontend/theme/'s.
import { h } from "../dashboard/dom.js"
import { DEFAULT_PREFS, applyTheme, readCache, resolve } from "../theme/cache.js"
import { remember, themeData } from "../theme/sync.js"
import { MODES, MORE, groups, matches, slotThemes, summary } from "./theme-model.js"

const deviceDark = () => !!window.matchMedia?.("(prefers-color-scheme: dark)").matches

/** A theme's card: its page color, a line of its text, its accent and four of its code colors. */
function swatch(theme) {
  const [page, text, accent, ...code] = theme.swatch
  return h(
    "span",
    {
      class: "theme-swatch",
      style: `background:${page};border-color:${text}33`,
      "aria-hidden": "true",
    },
    h("span", { class: "theme-swatch__text", style: `background:${text}` }),
    h("span", {
      class: "theme-swatch__text theme-swatch__text--short",
      style: `background:${text}`,
    }),
    h(
      "span",
      { class: "theme-swatch__dots" },
      h("span", { class: "theme-swatch__accent", style: `background:${accent}` }),
      ...code.map((color) => h("span", { style: `background:${color}` })),
    ),
  )
}

/** A sample of the site in the colors showing now: it follows the page, preview included. */
function sample() {
  return h(
    "div",
    { class: "theme-sample", "aria-hidden": "true" },
    h("div", { class: "theme-sample__band", text: "Hafezi Group" }),
    h(
      "div",
      { class: "theme-sample__body" },
      h("strong", { class: "theme-sample__title", text: "Topological photonics" }),
      h(
        "p",
        {},
        "Body text reads like this, with ",
        h("a", { href: "#appearance", tabindex: "-1", text: "a link" }),
        " and ",
        h("span", { class: "theme-sample__muted", text: "quieter notes" }),
        ".",
      ),
      h(
        "pre",
        { class: "theme-sample__code" },
        h("span", { style: "color:var(--syn-keyword, #d73a49)", text: "def " }),
        h("span", { style: "color:var(--syn-function, #6f42c1)", text: "chern" }),
        "(bands):\n    ",
        h("span", { style: "color:var(--syn-keyword, #d73a49)", text: "return " }),
        h("span", { style: "color:var(--syn-constant, #005cc5)", text: "sum" }),
        "(b.berry ",
        h("span", { style: "color:var(--syn-keyword, #d73a49)", text: "for " }),
        "b ",
        h("span", { style: "color:var(--syn-keyword, #d73a49)", text: "in " }),
        "bands)  ",
        h("span", { style: "color:var(--syn-comment, #6a737d)", text: "# an integer" }),
      ),
      h(
        "div",
        { class: "theme-sample__actions" },
        h("span", { class: "theme-sample__button", text: "Save" }),
        h("span", { class: "theme-sample__chip", text: "draft" }),
      ),
    ),
  )
}

export async function showAppearance(section, api) {
  const heading = h("h2", { id: "settings-appearance", text: "Appearance" })
  section.replaceChildren(heading, h("p", { class: "muted", text: "Loading…" }))
  let prefs
  let data
  try {
    ;[{ theme: prefs }, data] = await Promise.all([api("/api/prefs"), themeData()])
    prefs = { ...DEFAULT_PREFS, ...prefs }
  } catch (error) {
    section.replaceChildren(
      heading,
      h("p", { class: "dash-error", role: "status", text: error.message }),
    )
    return
  }
  const byId = new Map(data.themes.map((theme) => [theme.id, theme]))
  const status = h("p", { class: "settings-note", role: "status", "aria-live": "polite" })
  const said = h("p", { class: "theme-summary" })

  // Pointing at a theme shows it on the whole page until the pointer or focus leaves.
  let previewing = null
  let timer = 0
  const restore = () => {
    clearTimeout(timer)
    if (!previewing) return
    previewing = null
    const cache = readCache(localStorage)
    applyTheme(document.documentElement, resolve(cache, deviceDark()), cache?.figures !== false)
  }
  const preview = (theme) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      previewing = theme.id
      applyTheme(document.documentElement, theme, prefs.figures)
    }, 120)
  }

  let saving = Promise.resolve()
  const save = (patch) => {
    const before = prefs
    prefs = { ...prefs, ...patch }
    previewing = null
    render()
    saving = saving
      .then(() => remember(prefs))
      .then(() => api("/api/prefs", { method: "PUT", body: JSON.stringify({ theme: patch }) }))
      .then(
        () => (status.textContent = "Saved. Only you see this, on every device you sign in on."),
      )
      .catch((error) => {
        prefs = before
        render()
        status.textContent = `Not saved: ${error.message}`
        return remember(prefs).catch(() => {})
      })
  }

  // Dark mode: the switch the section leads with.
  const modes = h(
    "fieldset",
    { class: "theme-mode" },
    h("legend", { text: "Dark mode" }),
    h(
      "div",
      { class: "theme-mode__options" },
      MODES.map(([value, label]) =>
        h(
          "label",
          {},
          h("input", {
            type: "radio",
            name: "theme-mode",
            value,
            onchange: () => save({ mode: value }),
          }),
          h("span", { text: label }),
        ),
      ),
    ),
  )

  const figures = h("input", {
    type: "checkbox",
    id: "theme-figures",
    onchange: (event) => save({ figures: event.target.checked }),
  })
  const figuresRow = h(
    "div",
    { class: "theme-figures" },
    figures,
    h(
      "label",
      { for: "theme-figures" },
      h("strong", { text: "Match figures to dark themes" }),
      h("span", {
        class: "muted",
        text: " Plots and drawings on a white background are inverted to suit a dark page. Photos never change, and every figure has an Original colors button.",
      }),
    ),
  )

  const search = h("input", {
    type: "search",
    class: "theme-search",
    placeholder: "Find a theme (Nord, Dracula, Gruvbox…)",
    "aria-label": "Find a theme",
    oninput: () => filter(),
  })

  const pickers = [
    ["light", "Light theme", "Used when dark mode is off."],
    ["dark", "Dark theme", "Used when dark mode is on."],
  ].map(([slot, title, note]) => {
    const cards = []
    const body = groups(slotThemes(data.themes, slot)).map(({ family, themes }) => {
      const grid = h(
        "div",
        { class: "theme-grid", role: "radiogroup", "aria-label": `${title}: ${family}` },
        themes.map((theme) => {
          const input = h("input", {
            type: "radio",
            name: `theme-${slot}`,
            value: theme.id,
            class: "sr-only",
            onchange: () => save({ [slot]: theme.id }),
            onfocus: () => preview(theme),
            onblur: restore,
          })
          const card = h(
            "label",
            {
              class: "theme-card",
              onpointerenter: () => preview(theme),
              onpointerleave: restore,
            },
            input,
            swatch(theme),
            h("span", { class: "theme-card__name", text: theme.name }),
          )
          cards.push({ theme, card, input })
          return card
        }),
      )
      if (family !== MORE)
        return h("div", { class: "theme-group" }, h("h4", { text: family }), grid)
      return h(
        "details",
        { class: "theme-group theme-more" },
        h("summary", { text: `${MORE} (${themes.length})` }),
        grid,
      )
    })
    const picker = h(
      "div",
      { class: "theme-picker" },
      h("h3", { text: title }),
      h("p", { class: "muted", text: note }),
      h("div", { class: "theme-groups" }, body),
    )
    return { slot, picker, cards, body }
  })

  function filter() {
    const query = search.value
    for (const { cards, body } of pickers) {
      for (const { theme, card } of cards) card.hidden = !matches(theme, query)
      for (const group of body) {
        const visible = [...group.querySelectorAll(".theme-card")].some((card) => !card.hidden)
        group.hidden = !visible
        if (query && visible && group.tagName === "DETAILS") group.open = true
      }
    }
  }

  function render() {
    for (const input of modes.querySelectorAll("input")) input.checked = input.value === prefs.mode
    figures.checked = prefs.figures
    for (const { slot, cards } of pickers)
      for (const { theme, card, input } of cards) {
        const chosen = prefs[slot] === theme.id
        input.checked = chosen
        card.classList.toggle("is-chosen", chosen)
        // The chosen theme is never folded away under "More themes".
        if (chosen) {
          const details = card.closest("details")
          if (details) details.open = true
        }
      }
    said.textContent = summary(prefs, data.themes)
  }

  section.replaceChildren(
    heading,
    h("p", {
      class: "muted",
      text: "Choose how the members site looks for you. Only you see this, on every device you sign in on.",
    }),
    modes,
    said,
    h("div", { class: "theme-preview" }, sample(), figuresRow),
    search,
    ...pickers.map(({ picker }) => picker),
    status,
  )
  section.addEventListener("pointerleave", restore)
  render()
  if (!byId.has(prefs.light) || !byId.has(prefs.dark))
    status.textContent = "A theme you chose is no longer offered; the site's own is used instead."
}
