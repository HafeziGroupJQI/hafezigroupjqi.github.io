// Who may read which file of the private vault (and the restricted vaults mounted in it): the
// members site's access rules. Pure, so the Worker (src/acl/index.ts) and the site's build
// (tools/acl/policy.mjs) decide alike; both pass test/acl-vectors.json.
//
// A rule's pattern is a vault path (no leading slash): a file ("notes/x.md"), a folder with
// everything below it ("projects/optical-rl/"), or a glob ("*" one segment, "**" any depth). The
// most specific rule that matches a path decides it: a file's rule over a folder's (the longer
// folder over the shorter), a folder's over a glob's (the longer glob over the shorter), and of two
// as specific, the lower id. That rule lets a reader in when its allow list is empty or names them,
// and their name is not on its deny list. A path no rule matches is every member's; admins read all.

/** A principal: "group:<name>", "login:<github login>" or "person:people/<slug>". */
export type PrincipalRef = string

export interface AclRule {
  id: string
  pattern: string
  allow: PrincipalRef[]
  deny: PrincipalRef[]
  note?: string
}

export interface AclGroup {
  logins: string[]
  /** People pages, "people/<slug>". */
  people: string[]
}

/** The rules and groups, as D1 holds them and the site's build reads them (.hafezi/acl.json). */
export interface AclSnapshot {
  version: number
  groups: Record<string, AclGroup>
  rules: AclRule[]
}

/** Who reads: their login and, once approved, their People page ("people/<slug>"). */
export interface Reader {
  login: string
  person?: string | null
  admin?: boolean
}

type Kind = "exact" | "folder" | "glob"

interface Compiled extends AclRule {
  kind: Kind
  rank: [number, number]
  regex: RegExp | null
  number: number | null
}

const KIND_RANK: Record<Kind, number> = { exact: 3, folder: 2, glob: 1 }

export const patternKind = (pattern: string): Kind =>
  pattern.includes("*") ? "glob" : pattern.endsWith("/") ? "folder" : "exact"

/** A glob as a regular expression: "**\/" any folders (none too), "**" anything, "*" one segment's
 *  worth. A glob ending in "/" is a folder's: it matches everything below too. */
export function globRegex(pattern: string): RegExp {
  let out = ""
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?"
        i += 2
      } else {
        out += ".*"
        i += 1
      }
    } else if (char === "*") out += "[^/]*"
    else out += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${out}${pattern.endsWith("/") ? ".*" : ""}$`, "s")
}

/** The number in an id like "r12", for ordering ties (r2 before r10). */
const idNumber = (id: string) => {
  const match = /^[a-z]*(\d+)$/i.exec(id)
  return match ? Number(match[1]) : null
}

/** Whether rule a goes before rule b among equally specific ones: the lower id. */
function lowerId(a: Compiled, b: Compiled): boolean {
  if (a.number !== null && b.number !== null && a.number !== b.number) return a.number < b.number
  return a.id < b.id
}

export function compileRule(rule: AclRule): Compiled {
  const kind = patternKind(rule.pattern)
  return {
    ...rule,
    kind,
    rank: [KIND_RANK[kind], rule.pattern.length],
    regex: kind === "glob" ? globRegex(rule.pattern) : null,
    number: idNumber(rule.id),
  }
}

function matches(rule: Compiled, path: string): boolean {
  if (rule.kind === "exact") return path === rule.pattern
  if (rule.kind === "folder") return path.startsWith(rule.pattern)
  return rule.regex!.test(path)
}

/** A snapshot made ready for many questions: the rules compiled, each group's members by name. */
export class AclPolicy {
  readonly version: number
  readonly rules: Compiled[]
  readonly byId: Map<string, Compiled>
  private groupsOf = new Map<string, string[]>()

  constructor(readonly snapshot: AclSnapshot) {
    this.version = snapshot.version
    this.rules = snapshot.rules.map(compileRule)
    this.byId = new Map(this.rules.map((rule) => [rule.id, rule]))
    for (const [name, group] of Object.entries(snapshot.groups ?? {})) {
      for (const login of group.logins ?? []) this.addMember(`login:${login.toLowerCase()}`, name)
      for (const person of group.people ?? []) this.addMember(`person:${person}`, name)
    }
  }

  private addMember(principal: string, group: string) {
    const list = this.groupsOf.get(principal) ?? []
    if (!list.includes(group)) list.push(group)
    this.groupsOf.set(principal, list)
  }

  get empty(): boolean {
    return this.rules.length === 0
  }

  /** The rule that decides a path, or null when none matches it. */
  ruleFor(path: string): Compiled | null {
    let best: Compiled | null = null
    for (const rule of this.rules) {
      if (!matches(rule, path)) continue
      if (
        !best ||
        rule.rank[0] > best.rank[0] ||
        (rule.rank[0] === best.rank[0] &&
          (rule.rank[1] > best.rank[1] || (rule.rank[1] === best.rank[1] && lowerId(rule, best))))
      )
        best = rule
    }
    return best
  }

  /** Every principal a reader stands for: their login, People page and groups. */
  principals(reader: Reader): Set<string> {
    const own = [`login:${reader.login.toLowerCase()}`]
    if (reader.person) own.push(`person:${reader.person}`)
    const out = new Set(own)
    for (const principal of own)
      for (const group of this.groupsOf.get(principal) ?? []) out.add(`group:${group}`)
    return out
  }

  /** Whether a rule lets these principals read what it decides. */
  ruleAdmits(rule: AclRule, principals: Set<string>): boolean {
    const normal = (ref: string) => (ref.startsWith("login:") ? ref.toLowerCase() : ref)
    if (rule.deny.some((ref) => principals.has(normal(ref)))) return false
    return rule.allow.length === 0 || rule.allow.some((ref) => principals.has(normal(ref)))
  }

  /** Whether a reader may read a vault path, and the rule that decided it (null: no rule). */
  decide(reader: Reader, path: string): { readable: boolean; rule: string | null } {
    const rule = this.ruleFor(path)
    if (reader.admin) return { readable: true, rule: rule?.id ?? null }
    if (!rule) return { readable: true, rule: null }
    return { readable: this.ruleAdmits(rule, this.principals(reader)), rule: rule.id }
  }
}

/** One question, for tests and one-off checks: build an AclPolicy to ask many. */
export const decide = (snapshot: AclSnapshot, reader: Reader, path: string) =>
  new AclPolicy(snapshot).decide(reader, path)

/** The empty policy: no rules, every member reads everything. */
export const EMPTY_SNAPSHOT: AclSnapshot = { version: 0, groups: {}, rules: [] }

const PRINCIPAL =
  /^(?:group:[a-z0-9][a-z0-9-]{0,63}|login:[a-z0-9][a-z0-9-]{0,38}|person:people\/[a-z0-9]+(?:-[a-z0-9]+)*)$/

/** Whether a principal is well formed (logins lowercase). */
export const validPrincipal = (ref: string) => PRINCIPAL.test(ref)

/** Whether a pattern is a vault path, folder or glob a rule may name. */
export function validPattern(pattern: string): boolean {
  if (!pattern || pattern.length > 300 || pattern.startsWith("/")) return false
  if (/[\p{Cc}\\]/u.test(pattern)) return false
  const segments = pattern.replace(/\/$/, "").split("/")
  return segments.every((segment) => segment && segment !== "." && segment !== "..")
}
