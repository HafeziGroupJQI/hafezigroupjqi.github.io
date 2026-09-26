// The dashboard's URL: one /devices page, tabs and selection in the query string (the site's
// existing convention). Pure — parseRoute/buildHref round-trip canonical URLs.

export const TABS = ["overview", "device", "instruments", "experiments", "activity", "builder"]
export const LAYOUTS = ["grid", "list", "focus", "wall"]
export const TAB_LABELS = {
  overview: "Overview",
  device: "Device",
  instruments: "Instruments",
  experiments: "Experiments",
  activity: "Activity",
  builder: "Builder",
}

const CODE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const LOCAL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/
const FOCUS = /^[A-Za-z0-9._:-]{1,128}$/

const valid = (pattern, value) => (value && pattern.test(value) ? value : null)

export function parseRoute(search) {
  const q = new URLSearchParams(search)
  let tab = TABS.includes(q.get("tab")) ? q.get("tab") : "overview"
  let layout = LAYOUTS.includes(q.get("layout")) ? q.get("layout") : "grid"
  if (layout === "wall") tab = "overview"
  if (tab !== "overview") layout = "grid"
  return {
    tab,
    code: valid(CODE, q.get("code")),
    id: tab === "instruments" ? valid(LOCAL_ID, q.get("id")) : null,
    layout,
    focus: tab === "experiments" ? valid(FOCUS, q.get("focus")) : null,
  }
}

export function buildHref(route, base = "/devices") {
  const q = new URLSearchParams()
  const tab = route.layout === "wall" ? "overview" : (route.tab ?? "overview")
  if (tab !== "overview") q.set("tab", tab)
  if (route.code) q.set("code", route.code)
  if (tab === "instruments" && route.id) q.set("id", route.id)
  if (tab === "overview" && route.layout && route.layout !== "grid") q.set("layout", route.layout)
  if (tab === "experiments" && route.focus) q.set("focus", route.focus)
  const s = q.toString()
  return s ? `${base}?${s}` : base
}

/** The legacy per-view pages forward here: /device?code=x → /devices?tab=device&code=x. */
export function legacyRedirect(pathname, search) {
  const q = new URLSearchParams(search)
  const page = pathname.replace(/\.html$/, "").replace(/\/$/, "")
  const code = q.get("code")
  const map = {
    "/device": { tab: "device", code },
    "/instrument": { tab: "instruments", code, id: q.get("id") },
    "/experiments": { tab: "experiments", code, focus: q.get("focus") },
    "/experiment-builder": { tab: "builder", code },
  }
  const route = map[page]
  return route ? buildHref(parseRoute("?" + new URLSearchParams(clean(route)))) : "/devices"
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ""))
