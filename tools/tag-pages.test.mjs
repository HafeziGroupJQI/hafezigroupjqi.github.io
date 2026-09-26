import assert from "node:assert/strict"
import test from "node:test"
import { tagTarget } from "./tag-pages.mjs"

test("tags resolve to the note they name, public records first", () => {
  const slugs = new Set([
    "people/lida-xu",
    "equipment/bktel-2",
    "resources/equipment/bktel-2",
    "resources/projects/topo-automation-plan",
    "resources/projects/reservoir-computing-microrings",
    "resources/code/topological-photonics-gds-design-lida",
    "resources/code/topological-photonics-gds-design-supratik",
    "resources/library/index",
    "resources/library/device-data",
    "resources/code/index",
    "research/topological-photonics",
  ])
  assert.equal(tagTarget("people/lida-xu", slugs), "people/lida-xu")
  assert.equal(tagTarget("equipment/bktel-2", slugs), "equipment/bktel-2")
  assert.equal(
    tagTarget("project/topo-automation", slugs),
    "resources/projects/topo-automation-plan",
  )
  assert.equal(
    tagTarget("project/reservoir-computing", slugs),
    "resources/projects/reservoir-computing-microrings",
  )
  // Two notes share the prefix, so neither is the one the tag names.
  assert.equal(tagTarget("code/topological-photonics-gds-design", slugs), undefined)
  assert.equal(tagTarget("library", slugs), "resources/library/index")
  assert.equal(tagTarget("library/device-data", slugs), "resources/library/device-data")
  assert.equal(tagTarget("code", slugs), "resources/code/index")
  assert.equal(tagTarget("research/topological-photonics", slugs), "research/topological-photonics")
  assert.equal(tagTarget("equipment/laser", slugs), undefined)
  assert.equal(tagTarget("tool/python", slugs), undefined)
})
