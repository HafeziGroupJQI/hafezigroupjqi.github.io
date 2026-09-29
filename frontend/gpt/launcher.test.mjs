import assert from "node:assert/strict"
import test from "node:test"
import { setLauncherHidden, shortcutAction } from "./launcher.js"

const key = (name, modifiers = {}) => ({
  key: name,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
})

test("ctrl/⌘+j opens the modal, or closes it when it is open", () => {
  assert.equal(shortcutAction(key("j", { ctrlKey: true }), false), "open")
  assert.equal(shortcutAction(key("J", { metaKey: true }), false), "open")
  assert.equal(shortcutAction(key("j", { ctrlKey: true }), true), "close")
})

test("other keys and chords are left alone", () => {
  for (const event of [
    key("j"),
    key("k", { ctrlKey: true }),
    key("j", { ctrlKey: true, shiftKey: true }),
    key("j", { metaKey: true, altKey: true }),
    { ctrlKey: true }, // a keydown without a key, as autofill sends
  ])
    assert.equal(shortcutAction(event, false), null)
})

test("hiding the button, as the scratchpad does over a lab with its own panel, keeps ctrl/⌘+j", () => {
  setLauncherHidden(true)
  assert.equal(shortcutAction(key("j", { ctrlKey: true }), false), "open")
  setLauncherHidden(false)
})
