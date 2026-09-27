import assert from "node:assert/strict"
import test from "node:test"
import { present } from "./dom.js"

test("present drops what h() would skip, so replaceChildren never prints null", () => {
  assert.deepEqual(present("a", null, undefined, false, ["b", null], 0, ""), ["a", "b", 0, ""])
})
