import test from "node:test"
import assert from "node:assert/strict"
import { navigation, publicNav } from "./nav"

test("public navigation preserves the site and exposes GitHub login", () => {
  assert.deepEqual(navigation("public"), [
    ...publicNav,
    { label: "Sign in with GitHub", href: "/auth/login" },
  ])
})

test("members keep public navigation and gain native resource and tool menus", () => {
  const items = navigation("internal")
  assert.deepEqual(items.slice(0, publicNav.length), publicNav)
  const resources = items.find((item) => item.label === "Resources")!
  assert.ok(resources.children?.every((item) => item.href?.startsWith("/resources/")))
  assert.ok(
    items
      .find((item) => item.label === "Lab tools")
      ?.children?.some((item) => item.href === "/calendar"),
  )
  assert.ok(
    items.flatMap((item) => item.children ?? []).some((item) => item.href === "/auth/logout"),
  )
  assert.ok(!items.some((item) => item.href?.startsWith("http")))
})
