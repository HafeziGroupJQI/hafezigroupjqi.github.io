import test from "node:test"
import assert from "node:assert/strict"
import {
  applyEvent,
  budgetLabel,
  citationChips,
  groupConversations,
  mentionQuery,
  pageSlug,
  protectMath,
  removeToken,
  restoreMath,
  slashQuery,
  sources,
} from "./model.js"

test("composer triggers", () => {
  assert.deepEqual(mentionQuery("ask about @sant", 15), { start: 10, query: "sant" })
  assert.deepEqual(mentionQuery("@", 1), { start: 0, query: "" })
  assert.equal(mentionQuery("mail me@example", 15), null)
  assert.equal(mentionQuery("done @page then", 15), null)
  assert.deepEqual(slashQuery("/scpi", 5), { query: "scpi" })
  assert.equal(slashQuery("hi /scpi", 8), null)
  assert.deepEqual(removeToken("ask @sant now", 4, 9), { text: "ask now", caret: 4 })
})

test("stream events build the reply", () => {
  let r = { blocks: [], streaming: true }
  for (const [name, data] of [
    ["thinking", { text: "Let me " }],
    ["thinking", { text: "look." }],
    ["tool", { id: "t1", name: "search_site", label: "Searching" }],
    ["tool_result", { id: "t1", summary: "Found 2 pages", is_error: false }],
    ["delta", { text: "Hello" }],
    ["delta", { text: " world" }],
  ])
    r = applyEvent(r, name, data)
  assert.deepEqual(
    r.blocks.map((b) => b.type),
    ["thinking", "tool", "text"],
  )
  assert.equal(r.blocks[0].text, "Let me look.")
  assert.equal(r.blocks[1].summary, "Found 2 pages")
  assert.equal(r.blocks[2].text, "Hello world")
  const final = applyEvent(r, "turn", {
    role: "assistant",
    blocks: [{ type: "text", text: "Hello world[^1]", citations: [{ title: "T", url: "u" }] }],
  })
  assert.equal(final.blocks.length, 1)
  assert.equal(applyEvent(final, "done", {}).streaming, false)
  assert.equal(applyEvent(r, "error", { detail: "boom" }).error, "boom")
})

test("chats group by project, then page chats, then the rest", () => {
  const groups = groupConversations(
    [
      { id: "a", project_id: "p1" },
      { id: "b", origin_slug: "equipment/x" },
      { id: "c" },
      { id: "d", project_id: "p1" },
    ],
    [{ id: "p1", name: "Topo" }],
  )
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((c) => c.id)]),
    [
      ["Topo", ["a", "d"]],
      ["Page chats", ["b"]],
      ["Chats", ["c"]],
    ],
  )
})

test("math survives Markdown and comes back rendered", () => {
  const { text, math } = protectMath(
    "Energy $E = mc^2$ and $$\\sum_{i} a_i$$ but `$not$` and costs $5 or $10.",
  )
  assert.equal(math.length, 2)
  assert.ok(text.includes("`$not$`"))
  assert.ok(text.includes("costs $5 or $10"))
  const html = restoreMath(text, math, (tex, display) => `<m${display ? "d" : ""}>${tex}</m>`)
  assert.ok(html.includes("<m>E = mc^2</m>"))
  assert.ok(html.includes("<md>\\sum_{i} a_i</m>"))
  assert.ok(restoreMath(text, math, null).includes('<code class="gpt-math">E = mc^2</code>'))
})

test("citation markers become chips and sources are listed once", () => {
  const html = citationChips("Use WA.[^1][^2]", [
    { title: "Santec", url: "https://x/santec", cited_text: "WA" },
    { title: "Doc", url: "" },
  ])
  assert.match(html, /<a class="gpt-cite" href="https:\/\/x\/santec" title="Santec — “WA”">1<\/a>/)
  assert.match(html, /<span class="gpt-cite" title="Doc">2<\/span>/)
  assert.deepEqual(
    sources({
      blocks: [
        {
          citations: [
            { title: "A", url: "u1" },
            { title: "A", url: "u1" },
          ],
        },
      ],
      opened: [
        { title: "B", url: "u2" },
        { title: "F", url: "" },
      ],
    }),
    [
      { title: "A", url: "u1" },
      { title: "B", url: "u2" },
    ],
  )
})

test("page slugs and budget labels", () => {
  assert.equal(pageSlug("/equipment/santec-tsl/"), "equipment/santec-tsl")
  assert.equal(pageSlug("/"), "index")
  assert.equal(pageSlug("/resources/notes.html"), "resources/notes")
  assert.equal(budgetLabel({ used: 0, budget: null }), null)
  assert.equal(budgetLabel({ used: 1500, budget: 2_000_000 }), "2k of 2.0M tokens this month")
})
