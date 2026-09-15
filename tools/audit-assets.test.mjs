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
    fs.writeFileSync(path.join(root, "index.html"), '<img src="missing.png" alt="missing"><object data="missing.svg"></object>')
    assert.match((await auditOutput(root)).errors.join("\n"), /emitted asset is missing/)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})

test("output audit accepts streamed documents and enforces static asset limits", async () => {
  const root = fixture()
  try {
    fs.writeFileSync(
      path.join(root, "index.html"),
      '<iframe src="resources/files/manual.pdf" class="pdf"></iframe><a href="resources/files/data.docx">data</a>',
    )
    assert.match((await auditOutput(root)).errors.join("\n"), /manual\.pdf[\s\S]*data\.docx/)
    const external = new Set(["resources/files/manual.pdf", "resources/files/data.docx"])
    assert.deepEqual((await auditOutput(root, { external })).errors, [])
    fs.writeFileSync(path.join(root, "big.bin"), Buffer.alloc(11))
    const errors = (await auditOutput(root, { external, limits: { maxBytes: 10, maxFiles: 1 } })).errors
    assert.match(errors.join("\n"), /big\.bin: exceeds/)
    assert.match(errors.join("\n"), /2 files exceed the 1 file limit/)
  } finally {
    fs.rmSync(root, { recursive: true })
  }
})
