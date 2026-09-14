import test from "node:test"
import assert from "node:assert/strict"
import { configuredInternalUrl, internalNav, navigation, publicNav } from "./nav"

test("public navigation adds a configured HTTPS member site", () => {
  process.env.INTERNAL_SITE_URL = "https://members.example.edu/"
  assert.deepEqual(navigation("public").at(-1), {
    label: "Internal",
    href: "https://members.example.edu",
  })
  delete process.env.INTERNAL_SITE_URL
})

test("public navigation omits unsafe member URLs", () => {
  assert.equal(configuredInternalUrl("http://members.example.edu"), undefined)
  assert.deepEqual(navigation("public"), publicNav)
})

test("internal navigation exposes vault tools and logout", () => {
  assert.deepEqual(navigation("internal"), internalNav)
  assert.ok(internalNav.some((item) => item.href === "/instruments"))
  assert.ok(internalNav.some((item) => item.href === "/auth/logout"))
})
