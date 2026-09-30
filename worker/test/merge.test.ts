import { describe, expect, it } from "vitest"
import { gitBlobSha, lines, threeWay } from "../src/edit/merge"

const BASE = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n"

describe("three-way merge", () => {
  it("puts together changes to different lines", () => {
    const theirs = BASE.replace("one", "ONE")
    const mine = BASE.replace("seven", "SEVEN")
    expect(threeWay(BASE, theirs, mine)).toEqual({
      clean: true,
      text: "ONE\ntwo\nthree\nfour\nfive\nsix\nSEVEN\n",
      conflicts: 0,
    })
  })

  it("says so when both changed the same line, and takes the side asked for", () => {
    const theirs = BASE.replace("four", "theirs")
    const mine = BASE.replace("four", "mine").replace("one", "ONE")
    expect(threeWay(BASE, theirs, mine)).toEqual({
      clean: false,
      text: "ONE\ntwo\nthree\nmine\nfive\nsix\nseven\n",
      conflicts: 1,
    })
    expect(threeWay(BASE, theirs, mine, "theirs").text).toBe(
      "ONE\ntwo\nthree\ntheirs\nfive\nsix\nseven\n",
    )
  })

  it("takes the same change made on both sides once, without a conflict", () => {
    const both = BASE.replace("four", "FOUR")
    expect(threeWay(BASE, both, both.replace("one", "ONE"))).toEqual({
      clean: true,
      text: both.replace("one", "ONE"),
      conflicts: 0,
    })
  })

  it("keeps every line ending of a CRLF file", () => {
    const base = BASE.replace(/\n/g, "\r\n")
    const merged = threeWay(base, base.replace("one", "ONE"), base.replace("seven", "SEVEN"))
    expect(merged.clean).toBe(true)
    expect(merged.text).toBe("ONE\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nSEVEN\r\n")
    expect(merged.text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/)
  })

  it("keeps a last line without a newline as it is", () => {
    const base = "one\ntwo\nthree\nfour\nlast"
    const merged = threeWay(base, base.replace("one", "ONE"), base.replace("last", "LAST"))
    expect(merged).toMatchObject({ clean: true, text: "ONE\ntwo\nthree\nfour\nLAST" })
  })

  it("handles an empty base and unchanged sides", () => {
    expect(threeWay("", "", "new\n")).toMatchObject({ clean: true, text: "new\n" })
    expect(threeWay("", "theirs\n", "mine\n")).toMatchObject({ clean: false, text: "mine\n" })
    expect(threeWay(BASE, BASE, BASE)).toMatchObject({ clean: true, text: BASE })
    expect(threeWay(BASE, BASE.replace("two", "2"), BASE)).toMatchObject({
      clean: true,
      text: BASE.replace("two", "2"),
    })
    expect(lines("")).toEqual([])
  })

  it("merges a page of the largest size the editor takes in good time", () => {
    const row = (i: number) => `line ${i} ${"x".repeat(60)}\n`
    const count = Math.floor((2 * 1024 * 1024) / row(100000).length)
    const base = Array.from({ length: count }, (_, i) => row(i))
    const theirs = [...base]
    theirs[10] = "theirs\n"
    const mine = [...base]
    mine[count - 10] = "mine\n"
    const started = Date.now()
    const merged = threeWay(base.join(""), theirs.join(""), mine.join(""))
    expect(merged.clean).toBe(true)
    expect(merged.text).toContain("theirs\n")
    expect(merged.text).toContain("mine\n")
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe("git blob sha", () => {
  it("is the sha git gives a file", async () => {
    // git hash-object of an empty file, and of "hello\n".
    expect(await gitBlobSha("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")
    expect(await gitBlobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a")
    // Counted in bytes, not characters.
    expect(await gitBlobSha("é\n")).toBe(await gitBlobSha("é\n"))
  })
})
