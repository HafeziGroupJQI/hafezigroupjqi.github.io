// Scratchpad ⇄ Hafezi GPT. The gpt-bridge lab extension (compute repo, labextensions/) posts
//   {type: "hafezi-gpt:ask", context: {file, kernel, cell, selection, outputs, neighbors}}
// from the JupyterLab iframe; this turns that into the chat's code context ({label, text}), and
// the chat's "Insert below" / "Replace cell" buttons post {type: "hafezi-gpt:insert", mode, code}
// back. Pure, so node:test covers it.

// The Worker refuses context over 40 000 characters; the lab already truncates each part.
export const MAX_CONTEXT = 39_000

const fence = (code, lang = "") => {
  const ticks = "`".repeat(
    Math.max(3, ...[...String(code).matchAll(/`+/g)].map((m) => m[0].length + 1)),
  )
  return `${ticks}${lang}\n${code}\n${ticks}`
}

const base = (path) => String(path).split("/").pop() || String(path)

/** The fence language for a kernel: python, wolfram, … (empty when unknown). */
export function fenceLang(kernel) {
  const lang = String(kernel?.language ?? "").toLowerCase()
  if (lang.startsWith("wolfram") || lang === "mathematica") return "wolfram"
  return /^[a-z0-9+#-]{1,20}$/.test(lang) ? lang : ""
}

/** {label, text} for the chat from the lab's context, or null when there is nothing to send. */
export function gptContext(ctx) {
  if (!ctx || typeof ctx !== "object") return null
  const lang = fenceLang(ctx.kernel)
  const cell = ctx.cell && typeof ctx.cell.source === "string" ? ctx.cell : null
  const selection = typeof ctx.selection === "string" ? ctx.selection.trim() : ""
  const outputs = Array.isArray(ctx.outputs) ? ctx.outputs.filter((o) => typeof o === "string") : []
  const neighbors = Array.isArray(ctx.neighbors) ? ctx.neighbors : []
  if (!cell?.source.trim() && !selection && !outputs.length) return null

  const kernelName = ctx.kernel?.display_name || ctx.kernel?.name || ""
  const where =
    cell && Number.isInteger(cell.index) ? `cell ${cell.index + 1}` : cell ? "the current cell" : ""
  const label =
    [ctx.file ? base(ctx.file) : "Scratchpad", where].filter(Boolean).join(" · ") +
    (kernelName ? ` (${kernelName})` : "")

  const parts = []
  if (ctx.file || kernelName)
    parts.push(
      [
        ctx.file ? `File: \`${ctx.file}\`` : null,
        kernelName ? `kernel: ${kernelName}${lang ? ` (${lang})` : ""}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    )
  if (selection) parts.push(`Selected text:\n${fence(selection, lang)}`)
  if (cell?.source.trim()) {
    const kind = cell.type && cell.type !== "code" ? ` (${cell.type})` : ""
    parts.push(
      `${where ? where[0].toUpperCase() + where.slice(1) : "Cell"}${kind}:\n${fence(cell.source, cell.type === "code" ? lang : "")}`,
    )
  }
  if (outputs.length) parts.push(`Its outputs (latest last):\n${fence(outputs.join("\n\n"))}`)
  const near = neighbors.filter((n) => n && typeof n.source === "string" && n.source.trim())
  if (near.length)
    parts.push(
      "Nearby cells:\n" +
        near
          .map(
            (n) =>
              `${n.position === "after" ? "After" : "Before"} (${n.type || "code"}):\n${fence(n.source, n.type === "code" ? lang : "")}`,
          )
          .join("\n\n"),
    )
  let text = parts.join("\n\n")
  if (text.length > MAX_CONTEXT)
    text = `${text.slice(0, MAX_CONTEXT)}\n… [${text.length - MAX_CONTEXT} characters truncated]`
  return { label, text }
}

/** The message the chat's code buttons post into the lab iframe. */
export function insertMessage(mode, code) {
  return {
    type: "hafezi-gpt:insert",
    mode: mode === "replace" ? "replace" : "below",
    code: String(code),
  }
}
