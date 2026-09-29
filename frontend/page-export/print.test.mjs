import assert from "node:assert/strict"
import test from "node:test"
import { printHref } from "./print.js"

const page = "https://hafezigroupjqi.github.io/resources/onboarding/git"

test("a link prints its full address after it", () => {
  assert.equal(
    printHref({ href: "../code/", text: "the code index" }, page),
    "https://hafezigroupjqi.github.io/resources/code/",
  )
  assert.equal(
    printHref({ href: "https://git-scm.com/book", text: "Pro Git" }, page),
    "https://git-scm.com/book",
  )
  assert.equal(
    printHref({ href: "mailto:hafezi@umd.edu", text: "email the PI" }, page),
    "hafezi@umd.edu",
  )
  assert.equal(
    printHref({ href: "/resources/code/#setup", text: "setup" }, page),
    "https://hafezigroupjqi.github.io/resources/code/#setup",
  )
})

test("links whose address says nothing new print nothing after them", () => {
  assert.equal(printHref({ href: "#set-up-ssh", text: "Set up SSH" }, page), null)
  assert.equal(
    printHref({ href: "https://git-scm.com/", text: " https://git-scm.com " }, page),
    null,
  )
  assert.equal(printHref({ href: "mailto:hafezi@umd.edu", text: "hafezi@umd.edu" }, page), null)
  assert.equal(printHref({ href: "../../tags/git", text: "git", tag: true }, page), null)
  assert.equal(printHref({ href: "javascript:void(0)", text: "Run" }, page), null)
  assert.equal(printHref({ href: "blob:https://x/1", text: "notebook.ipynb" }, page), null)
})
