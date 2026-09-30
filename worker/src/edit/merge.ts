import { diff3Merge } from "node-diff3"

// Three-way merges of a page's text, line by line, for edits that meet (conflicts.ts, publish.ts):
// what two people changed since a common version goes together when they touched different lines,
// and is a conflict when they touched the same ones. The merge itself is node-diff3
// (https://github.com/bhousel/node-diff3, MIT, 3.2.1, by Bryan Housel), the diff3 of GNU diffutils
// in JavaScript; nothing here decides what overlaps.

type Region = { ok?: string[]; conflict?: { a: string[]; o: string[]; b: string[] } }

export interface Merge {
  /** No line was changed on both sides (or both made the same change). */
  clean: boolean
  /** The merged text; where both sides changed the same lines, `prefer`'s side. */
  text: string
  /** How many places both sides changed. */
  conflicts: number
}

/**
 * A text's lines, each with its own line ending, so a merge puts back exactly the bytes it was
 * given: a CRLF file stays CRLF, and a last line without a newline stays without one.
 */
export const lines = (text: string): string[] => (text === "" ? [] : text.split(/(?<=\n)/))

/**
 * Merge `theirs` and `mine`, both made from `base`. Where both changed the same lines the result
 * takes `prefer`'s side and `clean` is false.
 */
export function threeWay(
  base: string,
  theirs: string,
  mine: string,
  prefer: "mine" | "theirs" = "mine",
): Merge {
  if (theirs === base || theirs === mine) return { clean: true, text: mine, conflicts: 0 }
  if (mine === base) return { clean: true, text: theirs, conflicts: 0 }
  const regions = diff3Merge(lines(mine), lines(base), lines(theirs), {
    excludeFalseConflicts: true,
  }) as Region[]
  let conflicts = 0
  const out: string[] = []
  for (const region of regions) {
    if (region.ok) out.push(...region.ok)
    else if (region.conflict) {
      conflicts++
      out.push(...(prefer === "mine" ? region.conflict.a : region.conflict.b))
    }
  }
  return { clean: conflicts === 0, text: out.join(""), conflicts }
}

/**
 * The git blob sha of a text (SHA-1 of "blob <bytes>\0" and the bytes), as GitHub names a file's
 * version: the base of an edit made on top of a text that is not in the vault yet.
 */
export async function gitBlobSha(text: string): Promise<string> {
  const body = new TextEncoder().encode(text)
  const head = new TextEncoder().encode(`blob ${body.length}\0`)
  const bytes = new Uint8Array(head.length + body.length)
  bytes.set(head)
  bytes.set(body, head.length)
  const digest = await crypto.subtle.digest("SHA-1", bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
