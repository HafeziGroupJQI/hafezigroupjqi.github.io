import { recordChanges } from "../changes"
import type { Env } from "../env"
import { type Page, getScalar, joinPage, setScalar, splitPage } from "./frontmatter"
import { type Field, type PendingRow, fields, photoKey, siteUrl, slugOf } from "./routes"
import { Vault, type VaultFetch, type VaultFile } from "./vault"

// The hourly publish (the Worker's "0 * * * *" cron): every People page edit that is due goes
// into the vault in one commit, so the sites rebuild once for all of them. Edits that aren't due
// yet wait for a later hour; if GitHub refuses the commit, every edit waits for the next hour.

/** Due within this long of now counts as due: the cron fires on the hour, give or take. */
const SLACK_MS = 5 * 60_000

const SITE_AUTHOR = {
  name: "hafezi members site",
  email: "hafezi-members@users.noreply.github.com",
}

export interface PublishResult {
  commit: string | null
  published: string[]
  dropped: string[]
}

/** The page with a pending photo in it, and the vault files the photo change writes. */
function withPhoto(page: Page, slug: string, bytes: Uint8Array): VaultFile[] {
  const photoPath = `assets/people/${slug}.jpg`
  const old = getScalar(page, "photo")
  setScalar(page, "photo", photoPath)
  // The page shows its photo as the first embed (the People card reads `photo`).
  if (old && page.body.includes(`![[${old}]]`))
    page.body = page.body.replace(`![[${old}]]`, `![[${photoPath}]]`)
  else if (!page.body.includes(`![[${photoPath}]]`))
    page.body = `\n![[${photoPath}]]\n` + page.body.replace(/^\n+/, "\n")
  const files: VaultFile[] = [{ path: `content/${photoPath}`, content: bytes }]
  // A photo of this person's own under another extension is replaced, not left behind.
  if (old && old !== photoPath && new RegExp(`^assets/people/${slug}\\.\\w+$`).test(old))
    files.push({ path: `content/${old}`, content: null })
  return files
}

async function auditRow(env: Env, login: string, action: string, target: string, detail: object) {
  await env.DB.prepare(
    "INSERT INTO audit_log (at, login, action, target, detail_json) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(Date.now(), login, action, target, JSON.stringify(detail))
    .run()
}

export async function publishDue(
  env: Env,
  vaultFetch: VaultFetch,
  now = Date.now(),
): Promise<PublishResult> {
  const result: PublishResult = { commit: null, published: [], dropped: [] }
  const vault = new Vault(env, vaultFetch)
  if (!vault.ready) return result
  const { results: due } = await env.DB.prepare(
    "SELECT * FROM profile_pending WHERE due_at <= ? ORDER BY login",
  )
    .bind(now + SLACK_MS)
    .all<PendingRow>()
  if (!due.length) return result

  let used: { row: PendingRow; page: Page; photo: boolean; files: VaultFile[] }[] = []
  let dropped: { row: PendingRow; reason: string }[] = []
  let message = ""
  result.commit = await vault.commit(
    SITE_AUTHOR,
    async () => {
      used = []
      dropped = []
      const files: VaultFile[] = []
      for (const row of due) {
        const text = await vault.read(row.path)
        const page = text === null ? null : splitPage(text)
        if (!page) {
          dropped.push({ row, reason: "the page is gone" })
          continue
        }
        const owner = getScalar(page, "github")
        if (owner && owner.toLowerCase() !== row.login.toLowerCase()) {
          dropped.push({ row, reason: `the page is linked to ${owner}` })
          continue
        }
        if (row.link && !owner) setScalar(page, "github", row.login)
        const wanted = JSON.parse(row.fields_json) as Partial<Record<Field, string | null>>
        for (const [field, value] of Object.entries(wanted)) setScalar(page, field, value ?? null)
        const own: VaultFile[] = []
        if (row.photo_at !== null) {
          const object = await env.ARTIFACTS.get(photoKey(row.login, "pending"))
          if (object)
            own.push(
              ...withPhoto(page, slugOf(row.path), new Uint8Array(await object.arrayBuffer())),
            )
        }
        own.push({ path: row.path, content: joinPage(page) })
        files.push(...own)
        used.push({ row, page, photo: own.length > 1, files: own })
      }
      const slugs = used.map(({ row }) => slugOf(row.path))
      message =
        slugs.length === 1
          ? `update people/${slugs[0]} from the members site settings`
          : `update ${slugs.length} people pages from the members site settings: ${slugs.join(", ")}`
      return {
        files,
        message,
        // One member's edit is theirs; several go in under the site's name.
        author:
          used.length === 1
            ? { name: used[0].row.login, email: `${used[0].row.login}@users.noreply.github.com` }
            : SITE_AUTHOR,
      }
    },
    { skipEmpty: true },
  )

  // The site's activity (src/changes.ts): each member's files in the commit, as theirs, at once.
  // Only a record: the publish stands without it, and the next deploy's import adds the commit.
  const at = Date.now()
  if (result.commit && used.length)
    await recordChanges(
      env,
      used.flatMap(({ row, page, files }) =>
        files.map((file) => ({
          at,
          login: row.login,
          author: getScalar(page, "title") || row.login,
          repo: "vault" as const,
          path: file.path,
          kind: "profile" as const,
          state: "merged" as const,
          summary: message,
          commit_sha: result.commit,
        })),
      ),
    )
      .run()
      .catch((error) => console.error("recording profile publishes failed", error))
  for (const { row, page, photo } of used) {
    // Only the edit that was published: a save made meanwhile stays pending.
    const { meta } = await env.DB.prepare(
      "DELETE FROM profile_pending WHERE login = ? AND saved_at = ?",
    )
      .bind(row.login, row.saved_at)
      .run()
    if (photo) {
      const object = await env.ARTIFACTS.get(photoKey(row.login, "pending"))
      if (object) {
        await env.ARTIFACTS.put(photoKey(row.login, "photo"), await object.arrayBuffer(), {
          httpMetadata: { contentType: "image/jpeg" },
        })
        if (meta.changes) await env.ARTIFACTS.delete(photoKey(row.login, "pending"))
      }
    }
    await env.DB.prepare(
      `UPDATE profiles SET name = ?, photo_url = ?, photo_at = COALESCE(?, photo_at), updated_at = ?
       WHERE login = ?`,
    )
      .bind(
        getScalar(page, "title"),
        siteUrl(getScalar(page, "photo")),
        photo ? row.photo_at : null,
        Date.now(),
        row.login,
      )
      .run()
    await auditRow(env, row.login, "profile.publish", row.path, {
      commit: result.commit,
      fields: Object.keys(fields(page)).filter((f) => f in JSON.parse(row.fields_json)),
      photo,
      link: row.link === 1,
    })
    result.published.push(row.login)
  }
  for (const { row, reason } of dropped) {
    await env.DB.prepare("DELETE FROM profile_pending WHERE login = ?").bind(row.login).run()
    await env.ARTIFACTS.delete(photoKey(row.login, "pending"))
    await auditRow(env, row.login, "profile.dropped", row.path, { reason })
    result.dropped.push(row.login)
  }
  return result
}
