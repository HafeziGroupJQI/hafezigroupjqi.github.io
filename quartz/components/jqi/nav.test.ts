import test from "node:test"
import assert from "node:assert/strict"
import { navigation, publicNav } from "./nav"
import { navScript, shortNameSource } from "./navScript"

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
  // The Wolfram Language guide is part of Code, not an entry of its own.
  assert.ok(!resources.children?.some((item) => /wolfram/i.test(item.label)))
  // Top-level member links beside the menus.
  assert.deepEqual(
    items.filter((item) => item.member && item.slug).map((item) => [item.label, item.slug]),
    [
      ["Recently modified", "recent"],
      ["Leaderboard", "leaderboard"],
      ["Announcements", "announcements"],
    ],
  )
  const tools = items.find((item) => item.label === "Tools")!
  // The devices dashboard's tabs (experiments, the builder) are one entry: Command Center.
  assert.deepEqual(
    tools.children?.map((item) => [item.label, item.href]),
    [
      ["Hafezi GPT", "/gpt"],
      ["Scratchpad", "/scratchpad"],
      ["Command Center", "/devices"],
      ["Uploads", "/uploads"],
      ["Settings", "/settings"],
      ["Admin", "/admin"],
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

test("the header shows a member's first name only as a stand-in for the full one", () => {
  const shortName = new Function(`${shortNameSource}; return shortName`)() as (
    name?: string | null,
  ) => string
  assert.equal(shortName("Anish Goyal"), "Anish")
  assert.equal(shortName("  Mohammad  Hafezi "), "Mohammad")
  assert.equal(shortName("Jean-Luc Picard de la Tour"), "Jean-Luc")
  assert.equal(shortName("anishgoyal1108"), "anishgoyal1108")
  assert.equal(shortName(""), "")
  assert.equal(shortName(null), "")
  // The inlined script carries that function, keeps the full name for the tooltip and screen
  // readers, and never cuts a name with an ellipsis.
  assert.ok(navScript.includes(shortNameSource))
  assert.match(navScript, /chip\.dataset\.full = full/)
  assert.match(navScript, /setAttribute\("aria-label", label\)/)
  assert.doesNotThrow(() => new Function(navScript))
})
