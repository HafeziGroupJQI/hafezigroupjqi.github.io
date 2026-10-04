import type { Env } from "../env"
import { json } from "../http"
import { VAULTS } from "../vaults"
import { aclPolicy, peopleOf, viewerFor } from "./index"

// GET /api/compute/acl (the compute host, with its host key: src/compute/routes.ts): who may read
// what, for the Scratchpad's ~/published mounts, and the rules' version, which the host polls to
// start a rebuild of the members site. The host binds a member's restricted vaults and
// the folders of rules they may read at their server's start.
//   {version, vaults: [{repo, prefix}], rules: [{id, pattern}],
//    members: {<login>: {admin, vaults: [<repo>…], rules: [<rule id>…]}}}
// ?login=<login> answers for that member alone. Members are everyone the site knows: those who
// signed in, admins, People page links and group members. An admin is an org owner (as their last
// sign-in said) or a member of D1 admins.

const LOGIN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/

export async function computeAcl(url: URL, env: Env): Promise<Response> {
  // The version is acl_meta.version as it is now: the host polls it to rebuild the members site.
  const policy = await aclPolicy(env, Date.now(), { fresh: true })
  const asked = url.searchParams.get("login")?.trim().toLowerCase() || null
  if (asked !== null && !LOGIN.test(asked))
    return json({ detail: "login must be a GitHub login" }, 422)
  const { results } = await env.DB.prepare(
    `WITH known AS (
       SELECT DISTINCT lower(login) AS login FROM audit_log WHERE action = 'auth.login'
       UNION SELECT lower(login) FROM admins
       UNION SELECT lower(login) FROM profiles
       UNION SELECT lower(login) FROM acl_group_members WHERE login IS NOT NULL
     )
     SELECT k.login,
       EXISTS (SELECT 1 FROM admins a WHERE a.login = k.login COLLATE NOCASE)
       OR (SELECT role FROM audit_log l WHERE l.action = 'auth.login' AND l.login = k.login
           ORDER BY l.id DESC LIMIT 1) = 'owner' AS admin
     FROM known k WHERE ?1 IS NULL OR k.login = ?1 ORDER BY k.login`,
  )
    .bind(asked)
    .all<{ login: string; admin: number }>()
  const rows = asked && !results.length ? [{ login: asked, admin: 0 }] : results
  // Their People pages in one query, however many they are.
  const people = await peopleOf(env)
  const members: Record<string, { admin: boolean; vaults: string[]; rules: string[] }> = {}
  for (const row of rows) {
    const admin = Boolean(row.admin) && !row.login.startsWith("probe-")
    const person = people.get(row.login) ?? null
    const viewer = viewerFor(policy, { login: row.login, person, admin })
    members[row.login] = {
      admin,
      vaults: VAULTS.filter((vault) => vault.prefix && viewer.canRead(vault.prefix)).map(
        (vault) => vault.repo,
      ),
      rules: policy.rules.filter((rule) => viewer.canReadRule(rule.id)).map((rule) => rule.id),
    }
  }
  return json({
    version: policy.version,
    vaults: VAULTS.map(({ repo, prefix }) => ({ repo, prefix })),
    rules: policy.rules.map(({ id, pattern }) => ({ id, pattern })),
    members,
  })
}
