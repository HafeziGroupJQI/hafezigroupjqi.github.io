import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import sharp from "sharp"
import { auditOutput, auditSource } from "./audit-assets.mjs"

const fixture = () => fs.mkdtempSync(path.join(os.tmpdir(), "hafezi-assets-"))

test("source audit accepts valid local images and rejects missing and remote images", async () => {
  const root = fixture()
  try {
    fs.mkdirSync(path.join(root, "assets"))
    await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } }).png().toFile(path.join(root, "assets", "ok.png"))
    fs.writeFileSync(path.join(root, "page.md"), "---\ntitle: Page\nimage: assets/ok.png\n---\n\n![ok](assets/ok.png)\n")
    assert.deepEqual((await auditSource(root)).errors, [])
    fs.appendFileSync(path.join(root, "page.md"), "![missing](assets/missing.png)\n![remote](https://example.com/image.png)\n")
    const errors = (await auditSource(root)).errors.join("\n")
    assert.match(errors, /missing image/)
    assert.match(errors, /remote image/)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test("output audit rejects an emitted image target that does not exist", async () => {
  const root = fixture()
  try {
    fs.writeFileSync(path.join(root, "index.html"), '<img src="missing.png" alt="missing">')
    assert.match((await auditOutput(root)).errors.join("\n"), /emitted asset is missing/)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})
