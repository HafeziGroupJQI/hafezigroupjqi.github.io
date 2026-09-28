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
  assert.ok(resources.children?.some((item) => item.href === "/calendar"))
  assert.ok(resources.children?.some((item) => item.href === "/resources/equipment/"))
  // The Wolfram Language guide follows Equipment in the Resources menu.
  const hrefs = resources.children?.map((item) => item.href) ?? []
  assert.equal(
    hrefs.indexOf("/resources/code/wolfram-guide/"),
    hrefs.indexOf("/resources/equipment/") + 1,
  )
  const tools = items.find((item) => item.label === "Tools")!
  assert.deepEqual(
    tools.children?.map((item) => item.href),
    [
      "/gpt",
      "/scratchpad",
      "/devices",
      "/devices?tab=experiments",
      "/devices?tab=builder",
      "/admin",
    ],
  )
  assert.deepEqual(
    tools.children?.filter((item) => item.admin).map((item) => item.href),
    ["/admin"],
  )
  assert.ok(items.some((item) => item.label === "Sign out" && item.href === "/auth/logout"))
  assert.ok(
    !items.flatMap((item) => item.children ?? []).some((item) => /add event/i.test(item.label)),
  )
  assert.ok(!items.some((item) => item.href?.startsWith("http")))
})
