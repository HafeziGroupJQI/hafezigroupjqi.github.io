import { HttpError } from "../http"
import type { UsageTotals } from "./models"

// D1 access for Hafezi GPT. Visibility rules live here so every route applies them the same way:
//   projects: 'group' → every member; 'private' → the owner. Only the owner or an admin edits.
//   conversations: the owner, plus anyone it is shared with (a login, or '*' for the lab);
//                  shared readers are read-only and "continue" by forking.

export type Visibility = "private" | "group"

export interface Project {
  id: string
  name: string
  description: string
  instructions: string
  visibility: Visibility
  owner: string
  topics: string[]
  pinned: string[]
  default_model: string | null
  created_at: number
  updated_at: number
}

export interface Conversation {
  id: string
  project_id: string | null
  owner: string
  title: string
  model: string
  origin_slug: string | null
  forked_from: string | null
  // Set when the chat is one of the lab's AI chats (lab-chats.ts): its name there.
  lab_name?: string | null
  created_at: number
  updated_at: number
}

export interface StoredMessage {
  id: number
  conversation_id: string
  role: "user" | "assistant"
  content: unknown[]
  meta: Record<string, unknown>
  created_at: number
}

export interface FileRow {
  id: string
  project_id: string | null
  conversation_id: string | null
  owner: string
  name: string
  mime: string
  size: number
  r2_key: string
  tokens_est: number
  created_at: number
}

export interface SkillRow {
  id: string
  name: string
  description: string
  body: string
  visibility: Visibility
  owner: string
  created_at: number
  updated_at: number
}

export const newId = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`

const parse = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== "string") return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

const toProject = (row: Record<string, unknown>): Project => ({
  id: String(row.id),
  name: String(row.name),
  description: String(row.description ?? ""),
  instructions: String(row.instructions ?? ""),
  visibility: row.visibility === "group" ? "group" : "private",
  owner: String(row.owner),
  topics: parse(row.topics_json, [] as string[]),
  pinned: parse(row.pinned_slugs_json, [] as string[]),
  default_model: (row.default_model as string | null) ?? null,
  created_at: Number(row.created_at),
  updated_at: Number(row.updated_at),
})

const month = (at = Date.now()) => new Date(at).toISOString().slice(0, 7)

export class GptStore {
  constructor(private db: D1Database) {}

  // ---- projects ----

  async listProjects(login: string): Promise<Project[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM gpt_projects WHERE visibility = 'group' OR owner = ? ORDER BY updated_at DESC",
      )
      .bind(login)
      .all<Record<string, unknown>>()
    return results.map(toProject)
  }

  /** A project the member may see, or 404 (never 403: private projects stay invisible). */
  async project(id: string, login: string): Promise<Project> {
    const row = await this.db
      .prepare("SELECT * FROM gpt_projects WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>()
    const project = row ? toProject(row) : null
    if (!project || (project.visibility !== "group" && project.owner !== login))
      throw new HttpError(404, "project not found")
    return project
  }

  async createProject(
    owner: string,
    fields: Omit<Project, "id" | "owner" | "created_at" | "updated_at">,
  ): Promise<Project> {
    const now = Date.now()
    const id = newId("p")
    await this.db
      .prepare(
        `INSERT INTO gpt_projects (id, name, description, instructions, visibility, owner, topics_json,
           pinned_slugs_json, default_model, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        fields.name,
        fields.description,
        fields.instructions,
        fields.visibility,
        owner,
        JSON.stringify(fields.topics),
        JSON.stringify(fields.pinned),
        fields.default_model,
        now,
        now,
      )
      .run()
    return { ...fields, id, owner, created_at: now, updated_at: now }
  }

  async updateProject(project: Project): Promise<Project> {
    const now = Date.now()
    await this.db
      .prepare(
        `UPDATE gpt_projects SET name = ?, description = ?, instructions = ?, visibility = ?, topics_json = ?,
           pinned_slugs_json = ?, default_model = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        project.name,
        project.description,
        project.instructions,
        project.visibility,
        JSON.stringify(project.topics),
        JSON.stringify(project.pinned),
        project.default_model,
        now,
        project.id,
      )
      .run()
    return { ...project, updated_at: now }
  }

  /** Delete a project and its files' rows (returns their R2 keys). Chats keep existing, unfiled. */
  async deleteProject(id: string): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT r2_key FROM gpt_files WHERE project_id = ?")
      .bind(id)
      .all<{ r2_key: string }>()
    await this.db.batch([
      this.db.prepare("DELETE FROM gpt_files WHERE project_id = ?").bind(id),
      this.db
        .prepare("UPDATE gpt_conversations SET project_id = NULL WHERE project_id = ?")
        .bind(id),
      this.db.prepare("DELETE FROM gpt_projects WHERE id = ?").bind(id),
    ])
    return results.map((r) => r.r2_key)
  }

  // ---- conversations ----

  async createConversation(
    fields: Omit<Conversation, "id" | "created_at" | "updated_at">,
  ): Promise<Conversation> {
    const now = Date.now()
    const id = newId("c")
    await this.db
      .prepare(
        `INSERT INTO gpt_conversations (id, project_id, owner, title, model, origin_slug, forked_from, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        fields.project_id,
        fields.owner,
        fields.title,
        fields.model,
        fields.origin_slug,
        fields.forked_from,
        now,
        now,
      )
      .run()
    return { ...fields, id, created_at: now, updated_at: now }
  }

  /** The conversation and how the member may use it; 404 when they have no access at all. */
  async conversation(
    id: string,
    login: string,
  ): Promise<{ conversation: Conversation; access: "owner" | "shared" }> {
    const row = await this.db
      .prepare("SELECT * FROM gpt_conversations WHERE id = ?")
      .bind(id)
      .first<Conversation>()
    if (!row) throw new HttpError(404, "chat not found")
    if (row.owner === login) return { conversation: row, access: "owner" }
    const share = await this.db
      .prepare("SELECT 1 FROM gpt_shares WHERE conversation_id = ? AND grantee IN (?, '*')")
      .bind(id, login)
      .first()
    if (!share) throw new HttpError(404, "chat not found")
    return { conversation: row, access: "shared" }
  }

  async listConversations(
    login: string,
    {
      scope = "mine",
      project,
      origin,
      q,
      before,
      limit = 50,
    }: {
      scope?: string
      project?: string | null
      origin?: string | null
      q?: string | null
      before?: number | null
      limit?: number
    },
  ): Promise<
    Array<Conversation & { shared_by?: string; shared_at?: number; share_count?: number }>
  > {
    const where: string[] = []
    const binds: unknown[] = []
    let from = "gpt_conversations c"
    let select =
      "c.*, (SELECT COUNT(*) FROM gpt_shares s WHERE s.conversation_id = c.id) AS share_count"
    if (scope === "shared") {
      // One row per chat even when it is shared both with the lab and with the member directly.
      from = `gpt_conversations c JOIN (SELECT conversation_id, MIN(shared_by) AS shared_by, MAX(shared_at) AS shared_at
               FROM gpt_shares WHERE grantee IN (?, '*') GROUP BY conversation_id) s ON s.conversation_id = c.id`
      select = "c.*, s.shared_by, s.shared_at"
      binds.push(login)
      where.push("c.owner != ?")
      binds.push(login)
    } else {
      where.push("c.owner = ?")
      binds.push(login)
    }
    if (project === "none") where.push("c.project_id IS NULL")
    else if (project) {
      where.push("c.project_id = ?")
      binds.push(project)
    }
    if (origin) {
      where.push("c.origin_slug = ?")
      binds.push(origin)
    }
    if (q) {
      where.push("c.title LIKE ? ESCAPE '\\'")
      binds.push(`%${q.replace(/[\\%_]/g, (m) => "\\" + m)}%`)
    }
    if (before) {
      where.push("c.updated_at < ?")
      binds.push(before)
    }
    const { results } = await this.db
      .prepare(
        `SELECT ${select} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY c.updated_at DESC LIMIT ?`,
      )
      .bind(...binds, Math.min(limit, 200))
      .all<Conversation & { shared_by?: string; shared_at?: number; share_count?: number }>()
    return results
  }

  async touchConversation(
    id: string,
    fields: { title?: string; model?: string } = {},
  ): Promise<void> {
    const sets = ["updated_at = ?"]
    const binds: unknown[] = [Date.now()]
    if (fields.title) {
      sets.push("title = ?")
      binds.push(fields.title)
    }
    if (fields.model) {
      sets.push("model = ?")
      binds.push(fields.model)
    }
    await this.db
      .prepare(`UPDATE gpt_conversations SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds, id)
      .run()
  }

  async updateConversation(
    id: string,
    fields: { title?: string; project_id?: string | null },
  ): Promise<void> {
    if (fields.title !== undefined)
      await this.db
        .prepare("UPDATE gpt_conversations SET title = ? WHERE id = ?")
        .bind(fields.title, id)
        .run()
    if (fields.project_id !== undefined)
      await this.db
        .prepare("UPDATE gpt_conversations SET project_id = ? WHERE id = ?")
        .bind(fields.project_id, id)
        .run()
  }

  async deleteConversation(id: string): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT r2_key FROM gpt_files WHERE conversation_id = ?")
      .bind(id)
      .all<{ r2_key: string }>()
    await this.db.batch([
      this.db.prepare("DELETE FROM gpt_messages WHERE conversation_id = ?").bind(id),
      this.db.prepare("DELETE FROM gpt_shares WHERE conversation_id = ?").bind(id),
      this.db.prepare("DELETE FROM gpt_files WHERE conversation_id = ?").bind(id),
      this.db.prepare("DELETE FROM gpt_conversations WHERE id = ?").bind(id),
    ])
    return results.map((r) => r.r2_key)
  }

  // ---- the lab's AI chats (lab-chats.ts) ----

  async labChats(
    login: string,
  ): Promise<Array<{ name: string; conversation_id: string; title: string; updated_at: number }>> {
    const { results } = await this.db
      .prepare(
        `SELECT lab_name AS name, id AS conversation_id, title, updated_at FROM gpt_conversations
         WHERE owner = ? AND lab_name IS NOT NULL ORDER BY updated_at DESC LIMIT 500`,
      )
      .bind(login)
      .all<{ name: string; conversation_id: string; title: string; updated_at: number }>()
    return results
  }

  async labChat(login: string, name: string): Promise<Conversation | null> {
    return await this.db
      .prepare("SELECT * FROM gpt_conversations WHERE owner = ? AND lab_name = ?")
      .bind(login, name)
      .first<Conversation>()
  }

  /** Create or update the lab chat's conversation, replacing its messages with the lab's text. */
  async saveLabChat(
    login: string,
    name: string,
    title: string,
    model: string,
    rows: Array<{ role: "user" | "assistant"; content: unknown[]; meta: Record<string, unknown> }>,
  ): Promise<Conversation> {
    const now = Date.now()
    // Two saves of a new chat can race: the unique (owner, lab_name) index keeps one row.
    await this.db
      .prepare(
        `INSERT INTO gpt_conversations (id, project_id, owner, title, model, origin_slug, forked_from,
           lab_name, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT (owner, lab_name) WHERE lab_name IS NOT NULL
         DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
      )
      .bind(newId("c"), login, title, model, name, now, now)
      .run()
    const conversation = (await this.labChat(login, name))!
    await this.db.batch([
      this.db.prepare("DELETE FROM gpt_messages WHERE conversation_id = ?").bind(conversation.id),
      ...rows.map((row) =>
        this.db
          .prepare(
            "INSERT INTO gpt_messages (conversation_id, role, content_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            conversation.id,
            row.role,
            JSON.stringify(row.content),
            JSON.stringify(row.meta),
            now,
          ),
      ),
    ])
    return conversation
  }

  // ---- messages ----

  async messages(conversationId: string): Promise<StoredMessage[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM gpt_messages WHERE conversation_id = ? ORDER BY id")
      .bind(conversationId)
      .all<Record<string, unknown>>()
    return results.map((row) => ({
      id: Number(row.id),
      conversation_id: String(row.conversation_id),
      role: row.role as "user" | "assistant",
      content: parse(row.content_json, [] as unknown[]),
      meta: parse(row.meta_json, {} as Record<string, unknown>),
      created_at: Number(row.created_at),
    }))
  }

  async appendMessages(
    conversationId: string,
    rows: Array<{ role: "user" | "assistant"; content: unknown[]; meta?: Record<string, unknown> }>,
  ): Promise<void> {
    if (!rows.length) return
    const now = Date.now()
    await this.db.batch(
      rows.map((row) =>
        this.db
          .prepare(
            "INSERT INTO gpt_messages (conversation_id, role, content_json, meta_json, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .bind(
            conversationId,
            row.role,
            JSON.stringify(row.content),
            row.meta ? JSON.stringify(row.meta) : null,
            now,
          ),
      ),
    )
  }

  /** Copy a chat's messages into a new chat the member owns (continuing a shared chat). */
  async fork(source: Conversation, login: string): Promise<Conversation> {
    const copy = await this.createConversation({
      project_id: null,
      owner: login,
      title: source.title,
      model: source.model,
      origin_slug: source.origin_slug,
      forked_from: source.id,
    })
    await this.db
      .prepare(
        `INSERT INTO gpt_messages (conversation_id, role, content_json, meta_json, created_at)
         SELECT ?, role, content_json, meta_json, created_at FROM gpt_messages WHERE conversation_id = ? ORDER BY id`,
      )
      .bind(copy.id, source.id)
      .run()
    return copy
  }

  // ---- shares ----

  async shares(
    conversationId: string,
  ): Promise<Array<{ grantee: string; shared_by: string; shared_at: number }>> {
    const { results } = await this.db
      .prepare(
        "SELECT grantee, shared_by, shared_at FROM gpt_shares WHERE conversation_id = ? ORDER BY shared_at",
      )
      .bind(conversationId)
      .all<{ grantee: string; shared_by: string; shared_at: number }>()
    return results
  }

  async share(conversationId: string, grantee: string, by: string): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR IGNORE INTO gpt_shares (conversation_id, grantee, shared_by, shared_at) VALUES (?, ?, ?, ?)",
      )
      .bind(conversationId, grantee, by, Date.now())
      .run()
  }

  async unshare(conversationId: string, grantee: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare("DELETE FROM gpt_shares WHERE conversation_id = ? AND grantee = ?")
      .bind(conversationId, grantee)
      .run()
    return meta.changes > 0
  }

  // ---- files ----

  async addFile(row: FileRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO gpt_files (id, project_id, conversation_id, owner, name, mime, size, r2_key, tokens_est, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.id,
        row.project_id,
        row.conversation_id,
        row.owner,
        row.name,
        row.mime,
        row.size,
        row.r2_key,
        row.tokens_est,
        row.created_at,
      )
      .run()
  }

  async file(id: string): Promise<FileRow | null> {
    return await this.db.prepare("SELECT * FROM gpt_files WHERE id = ?").bind(id).first<FileRow>()
  }

  async projectFiles(projectId: string): Promise<FileRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM gpt_files WHERE project_id = ? ORDER BY name")
      .bind(projectId)
      .all<FileRow>()
    return results
  }

  async conversationFiles(conversationId: string): Promise<FileRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM gpt_files WHERE conversation_id = ? ORDER BY created_at")
      .bind(conversationId)
      .all<FileRow>()
    return results
  }

  async deleteFile(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM gpt_files WHERE id = ?").bind(id).run()
  }

  // ---- skills (member-written; repo skills come from the build manifest) ----

  async listSkills(login: string): Promise<SkillRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM gpt_skills WHERE visibility = 'group' OR owner = ? ORDER BY name")
      .bind(login)
      .all<SkillRow>()
    return results
  }

  async skill(id: string): Promise<SkillRow | null> {
    return await this.db.prepare("SELECT * FROM gpt_skills WHERE id = ?").bind(id).first<SkillRow>()
  }

  async saveSkill(row: SkillRow, create: boolean): Promise<void> {
    try {
      if (create)
        await this.db
          .prepare(
            `INSERT INTO gpt_skills (id, name, description, body, visibility, owner, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            row.id,
            row.name,
            row.description,
            row.body,
            row.visibility,
            row.owner,
            row.created_at,
            row.updated_at,
          )
          .run()
      else
        await this.db
          .prepare(
            "UPDATE gpt_skills SET name = ?, description = ?, body = ?, visibility = ?, updated_at = ? WHERE id = ?",
          )
          .bind(row.name, row.description, row.body, row.visibility, row.updated_at, row.id)
          .run()
    } catch (error) {
      if (String(error).includes("UNIQUE"))
        throw new HttpError(409, `a skill named "${row.name}" already exists`)
      throw error
    }
  }

  async deleteSkill(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM gpt_skills WHERE id = ?").bind(id).run()
  }

  // ---- usage + budgets ----

  async usage(
    login: string,
    at = Date.now(),
  ): Promise<{ used: number; budget: number | null; cost_usd: number }> {
    const row = await this.db
      .prepare(
        `SELECT (SELECT input + output FROM gpt_usage WHERE login = ?1 AND month = ?2) AS used,
                (SELECT cost_usd FROM gpt_usage WHERE login = ?1 AND month = ?2) AS cost_usd,
                (SELECT monthly_tokens FROM gpt_budgets WHERE login = ?1) AS budget`,
      )
      .bind(login, month(at))
      .first<{ used: number | null; budget: number | null; cost_usd: number | null }>()
    return { used: row?.used ?? 0, budget: row?.budget ?? null, cost_usd: row?.cost_usd ?? 0 }
  }

  async addUsage(login: string, totals: UsageTotals, at = Date.now()): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO gpt_usage (login, month, input, output, cache_read, cache_write, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (login, month) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
           cost_usd = cost_usd + excluded.cost_usd`,
      )
      .bind(
        login,
        month(at),
        totals.input,
        totals.output,
        totals.cache_read,
        totals.cache_write,
        totals.cost_usd,
      )
      .run()
  }

  /** Logins seen signing in: who a chat can be shared with. */
  async members(): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT DISTINCT login FROM audit_log WHERE action = 'auth.login' ORDER BY login")
      .all<{ login: string }>()
    return results.map((r) => r.login)
  }
}
