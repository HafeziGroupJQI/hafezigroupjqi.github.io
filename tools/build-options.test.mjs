import assert from "node:assert/strict"
import test from "node:test"
import { parseBuildOptions } from "./build-options.mjs"

test("internal builds select private content and isolate Quartz arguments", () => {
  const options = parseBuildOptions([
    "--mode", "internal",
    "--content", "../private",
    "--output", "public-internal",
    "--base-url", "https://internal.example.edu",
    "--serve",
  ], {})
  assert.equal(options.mode, "internal")
  assert.equal(options.content, "../private")
  assert.equal(options.quartzBaseUrl, "internal.example.edu")
  assert.deepEqual(options.quartzArgs, ["--serve", "--output", "public-internal"])
})

test("non-local internal builds require HTTPS", () => {
  assert.throws(() => parseBuildOptions(["--base-url", "http://internal.example.edu"], {}), /HTTPS/)
})
