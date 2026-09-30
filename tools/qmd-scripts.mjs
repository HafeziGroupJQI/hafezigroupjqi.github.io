// The scripts of a rendered .qmd's header-includes, moved into its body (tools/render-qmd.mjs):
// Quartz renders only a page's body, and raw-HTML widgets (Plotly, htmlwidgets) need their
// scripts there. Pure, so node:test covers it.
//
// Quarto adds RequireJS, jQuery and a `define('jquery', ...)` shim to a page that had a Jupyter
// widget output when it was frozen. On a page where nothing uses them any more they only do harm:
// with an AMD `define` on the page, d3 (the graph view's) registers as an AMD module instead of
// setting window.d3, so the graph never draws. They are left out unless the page uses AMD.

// One script tag, with the line break after it, so taking it out leaves no blank line.
const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script\s*>[ \t]*(?:\r?\n)?/gi
const SRC = /^<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i
// RequireJS and jQuery as Quarto (jsdelivr, cdnjs) and others serve them.
const LOADER =
  /(?:\/(?:requirejs|jquery)@[^/]*\/|\/require(?:\.min)?\.js$|\/jquery(?:-[\d.]+)?(?:\.min)?\.js$)/i
const JQUERY_SHIM = /^\s*define\s*\(\s*(["'])jquery\1/
/** Code or outputs that load modules through AMD: RequireJS's require(), define(), or a widget. */
export const USES_AMD = /\brequire(?:js)?\s*\(|\bdefine\s*\(|application\/vnd\.jupyter\.widget/

/** Whether a script tag is Quarto's RequireJS or jQuery, or its `define('jquery', ...)` shim. */
export function isAmdScript(tag) {
  const src = tag.match(SRC)
  const url = (src?.[1] ?? src?.[2] ?? src?.[3] ?? "").split(/[?#]/)[0]
  if (url) return LOADER.test(url)
  return JQUERY_SHIM.test(tag.replace(/^<script\b[^>]*>/i, ""))
}

/**
 * `body` with the header-includes (a string or a list of them) that hold a script in front of it,
 * as the page's first lines. RequireJS, jQuery and the shim are taken out of them unless the body,
 * or another of the scripts, uses AMD; an include with nothing else in it then goes.
 */
export function hoistScripts(headerIncludes, body) {
  const includes = (Array.isArray(headerIncludes) ? headerIncludes : [headerIncludes]).filter(
    (s) => typeof s === "string" && /<script/i.test(s),
  )
  const others = includes.flatMap((s) => s.match(SCRIPT) ?? []).filter((tag) => !isAmdScript(tag))
  const amd =
    USES_AMD.test(body) || others.some((tag) => USES_AMD.test(tag.replace(/^<script\b[^>]*>/i, "")))
  const kept = includes
    .map((s) => (amd ? s : s.replace(SCRIPT, (tag) => (isAmdScript(tag) ? "" : tag))))
    .filter((s) => s.trim())
  return kept.length ? kept.join("\n") + "\n\n" + body : body
}
