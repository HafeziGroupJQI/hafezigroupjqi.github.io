import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { writeAuthPages } from "./members-pages.mjs"

test("the public build gets three static sign-in pages wired to the members module", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "auth-pages-"))
  try {
    fs.writeFileSync(path.join(out, "index-1234abcd.css"), "")
    writeAuthPages(out)
    for (const [name, run] of [
      ["login", "login"],
      ["callback", "callback"],
      ["logout", "logout"],
    ]) {
      const html = fs.readFileSync(path.join(out, "auth", `${name}.html`), "utf8")
      assert.match(html, new RegExp(`import \\{ ${run} \\} from "/static/members-auth.js"`))
      assert.match(html, /href="\/index-1234abcd.css"/)
      assert.match(html, /name="robots" content="noindex"/)
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
})
