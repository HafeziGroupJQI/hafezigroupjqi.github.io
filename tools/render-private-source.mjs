import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { renderDrawings } from "./render-excalidraw.mjs"

// Render before relocating: Quarto's frozen results are keyed by original source paths.
export async function renderPrivateSource(source) {
  const input = fs.realpathSync(source)
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-private-render-"))
  const content = path.join(stage, "content")
  try {
    const excluded = new Set([
      ".git",
      "node_modules",
      ".venv",
      ".venv312",
      ".cache",
      ".obsidian",
      "_freeze",
    ])
    fs.cpSync(input, content, {
      recursive: true,
      filter: (file) => !excluded.has(path.basename(file)),
    })
    fs.rmSync(path.join(content, ".gitignore"), { force: true })
    fs.copyFileSync(path.join(input, "_quarto.yml"), path.join(stage, "_quarto.yml"))
    if (fs.existsSync(path.join(input, "_freeze"))) {
      fs.mkdirSync(path.join(stage, "_freeze"), { recursive: true })
      fs.cpSync(path.join(input, "_freeze"), path.join(stage, "_freeze", "content"), {
        recursive: true,
      })
    }
    await renderDrawings(content)
    execFileSync(process.execPath, ["tools/render-qmd.mjs"], {
      stdio: "inherit",
      env: { ...process.env, CONTENT_DIR: content },
    })
    return { stage, content }
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
}
