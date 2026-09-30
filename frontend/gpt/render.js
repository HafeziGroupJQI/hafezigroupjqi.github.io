// Markdown → safe HTML for Hafezi GPT replies: marked (GFM), math via KaTeX (loaded from the same
// jsDelivr build whose CSS every page already includes), citation chips, DOMPurify last.
import DOMPurify from "dompurify"
import { marked } from "marked"
import { citationChips, escapeHtml, protectMath, restoreMath } from "./model.js"

const KATEX_URL = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.mjs"
let katex = null
let katexLoading = null

/** Start loading KaTeX; resolves once it can render (or never blocks rendering if it fails). */
export function loadKatex() {
  katexLoading ??= import(/* webpackIgnore: true */ KATEX_URL)
    .then((module) => (katex = module.default ?? module))
    .catch(() => null)
  return katexLoading
}

const renderTex = (tex, display) => {
  if (!katex) return null
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: "html" })
  } catch {
    return null
  }
}

marked.use({ gfm: true, breaks: false })

const SITE = location.origin

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.getAttribute("href")) {
    let external = true
    try {
      const url = new URL(node.getAttribute("href"), SITE)
      // Links to the lab site stay in this tab's origin; hafezigroupjqi.github.io is this site.
      external = url.origin !== SITE && !/hafezigroupjqi\.github\.io$/.test(url.hostname)
      if (!external && url.origin !== SITE)
        node.setAttribute("href", url.pathname + url.search + url.hash)
    } catch {
      /* leave relative links alone */
    }
    if (external) {
      node.setAttribute("target", "_blank")
      node.setAttribute("rel", "noopener noreferrer")
    }
  }
})

/** Render one text block (with its citations) to sanitized HTML. */
export function renderMarkdown(text, citations = []) {
  const { text: guarded, math } = protectMath(text)
  let html = marked.parse(guarded, { async: false })
  html = restoreMath(html, math, renderTex)
  html = citationChips(html, citations)
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"], FORBID_TAGS: ["style", "form", "input"] })
}

/** Add copy buttons to code blocks inside `root`. */
export function enhanceCode(root) {
  for (const pre of root.querySelectorAll("pre:not([data-copy])")) {
    if (pre.classList.contains("gpt-math")) continue
    pre.dataset.copy = ""
    const codeOf = () => pre.querySelector("code")?.textContent ?? pre.textContent
    const button = document.createElement("button")
    button.type = "button"
    button.className = "gpt-copy"
    button.textContent = "Copy"
    button.onclick = async () => {
      await navigator.clipboard?.writeText(codeOf())
      button.textContent = "Copied"
      setTimeout(() => (button.textContent = "Copy"), 1500)
    }
    pre.append(button)
  }
}

export { escapeHtml }
