import { type Auditor, isAdmin } from "../audit"
import { requireMutation } from "../auth"
import type { Env } from "../env"
import { HttpError, decodeSegment, json, readJson } from "../http"
import type { Session } from "../session"
import { type GptDeps, displayTurns, postMessage, readTurn } from "./chat"
import { estimateTokens, projectKnowledge, uploadKind } from "./context"
import { loadKnowledge } from "./knowledge"
import { DEFAULT_MODEL, MODELS } from "./models"
import { allSkills, validateSkill } from "./skills"
import { type FileRow, GptStore, type Project, newId } from "./store"

// /api/gpt/* — Hafezi GPT for signed-in members. Returns null for paths it does not own.

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const TAG = /^[a-z0-9][a-z0-9/_-]*$/i
const LOGIN = /^[A-Za-z0-9-]{1,39}$/

const str = (v: unknown, max: number, field: string) => {
  if (v === undefined || v === null) return ""
  if (typeof v !== "string") throw new HttpError(422, `${field} must be text`)
  if (v.length > max) throw new HttpError(422, `${field} is too long (max ${max} characters)`)
  return v.trim()
}

export async function gptRoutes(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  session: Session,
  record: Auditor,
  deps: GptDeps,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/gpt/")) return null
  const path = url.pathname.slice("/api/gpt".length)
  const method = request.method
  const store = new GptStore(env.DB)
  const login = session.login
  const write = () => requireMutation(request, env)

  // ---- bootstrap: everything the composer needs in one call ----
  if (path === "/bootstrap" && method === "GET") {
    const knowledge = await loadKnowledge(env, deps.manifest)
    const skills = await allSkills(deps.skills, store, login)
    return json({
      models: MODELS.map(({ id, label, blurb }) => ({ id, label, blurb })),
      default_model: DEFAULT_MODEL,
      skills: skills.map(({ id, name, description, source, owner, visibility }) => ({
        id,
        name,
        description,
        source,
        owner,
        visibility,
      })),
      topics: knowledge.topics(),
      usage: await store.usage(login),
      members: (await store.members()).filter((m) => m !== login),
      offline: !env.ANTHROPIC_API_KEY,
    })
  }

  // ---- @-mention lookup: titles/slugs/paths of pages and private documents ----
  if (path === "/pages" && method === "GET") {
    const knowledge = await loadKnowledge(env, deps.manifest)
    const q = (url.searchParams.get("q") ?? "").trim().toLowerCase()
    const limit = Math.min(Number(url.searchParams.get("limit")) || 12, 30)
    const out: Array<{ ref: string; title: string; kind: "page" | "document"; hint: string }> = []
    if (!q) return json(out)
    const seen = new Set<string>()
    const push = (ref: string, title: string, kind: "page" | "document", hint: string) => {
      if (seen.has(ref) || out.length >= limit) return
      seen.add(ref)
      out.push({ ref, title, kind, hint })
    }
    // Title/slug prefix and substring matches first, then full-text hits, then documents.
    const pages = [...knowledge.pages.values()]
    for (const p of pages)
      if (p.title.toLowerCase().startsWith(q)) push(p.slug, p.title, "page", p.slug)
    for (const p of pages)
      if (p.title.toLowerCase().includes(q) || p.slug.includes(q))
        push(p.slug, p.title, "page", p.slug)
    for (const hit of knowledge.search(q, { limit })) push(hit.slug, hit.title, "page", hit.slug)
    for (const docPath of Object.keys(knowledge.documents))
      if (docPath.toLowerCase().includes(q))
        push(docPath, docPath.split("/").pop() ?? docPath, "document", docPath)
    return json(out)
  }

  // ---- projects ----
  if (path === "/projects") {
    if (method === "GET") return json(await store.listProjects(login))
    if (method === "POST") {
      write()
      const project = await store.createProject(
        login,
        await readProject((await readJson(request)) as Record<string, unknown>, env, deps),
      )
      record("gpt.project.create", project.id, {
        name: project.name,
        visibility: project.visibility,
      })
      return json(project, 201)
    }
    throw new HttpError(405, "method not allowed")
  }
  const projectMatch = path.match(/^\/projects\/([^/]+)(?:\/(files))?$/)
  if (projectMatch) {
    const project = await store.project(decodeSegment(projectMatch[1]), login)
    const canEdit = project.owner === login || (await isAdmin(env, session))
    if (projectMatch[2] === "files") {
      if (method !== "POST") throw new HttpError(405, "method not allowed")
      write()
      if (!canEdit && project.visibility !== "group") throw new HttpError(403, "not your project")
      const file = await upload(request, env, store, login, {
        project_id: project.id,
        conversation_id: null,
      })
      record("gpt.upload", project.id, { name: file.name, size: file.size, project: project.id })
      return json(file, 201)
    }
    if (method === "GET") {
      const knowledge = await loadKnowledge(env, deps.manifest)
      const files = await store.projectFiles(project.id)
      const corpus = await projectKnowledge(project, knowledge, files, env)
      return json({
        ...project,
        can_edit: canEdit,
        files,
        knowledge: { tokens: corpus.tokens, included: corpus.included, overflow: corpus.overflow },
      })
    }
    write()
    if (!canEdit) throw new HttpError(403, "only the project's owner or an admin can change it")
    if (method === "PUT") {
      const fields = await readProject(
        (await readJson(request)) as Record<string, unknown>,
        env,
        deps,
      )
      const updated = await store.updateProject({ ...project, ...fields })
      record("gpt.project.update", project.id, {
        name: updated.name,
        visibility: updated.visibility,
      })
      return json(updated)
    }
    if (method === "DELETE") {
      const keys = await store.deleteProject(project.id)
      if (keys.length) ctx.waitUntil(env.ARTIFACTS.delete(keys))
      record("gpt.project.delete", project.id, { name: project.name })
      return json({ deleted: project.id })
    }
    throw new HttpError(405, "method not allowed")
  }

  // ---- files ----
  const fileMatch = path.match(/^\/files\/([^/]+)$/)
  if (fileMatch) {
    const file = await store.file(decodeSegment(fileMatch[1]))
    if (!file) throw new HttpError(404, "file not found")
    await requireFileAccess(file, store, login)
    if (method === "GET") {
      const object = await env.ARTIFACTS.get(file.r2_key)
      if (!object) throw new HttpError(404, "file not found")
      return new Response(object.body, {
        headers: {
          "content-type": file.mime,
          "content-disposition": `inline; filename="${file.name.replace(/["\\\r\n]/g, "")}"`,
        },
      })
    }
    if (method === "DELETE") {
      write()
      if (file.owner !== login) {
        const project = file.project_id ? await store.project(file.project_id, login) : null
        if (!project || !(project.owner === login || (await isAdmin(env, session))))
          throw new HttpError(403, "not your file")
      }
      await store.deleteFile(file.id)
      // Keep the bytes while any stored chat still references them; they are tiny next to D1 rows.
      return json({ deleted: file.id })
    }
    throw new HttpError(405, "method not allowed")
  }

  // ---- skills ----
  if (path === "/skills") {
    const skills = await allSkills(deps.skills, store, login)
    if (method === "GET") return json(skills)
    if (method === "POST") {
      write()
      const fields = validateSkill(
        (await readJson(request)) as Record<string, unknown>,
        new Set(deps.skills.skills.map((s) => s.name)),
      )
      const now = Date.now()
      const row = { id: newId("s"), owner: login, created_at: now, updated_at: now, ...fields }
      await store.saveSkill(row, true)
      record("gpt.skill.create", row.name, { visibility: row.visibility })
      return json(row, 201)
    }
    throw new HttpError(405, "method not allowed")
  }
  const skillMatch = path.match(/^\/skills\/([^/]+)$/)
  if (skillMatch) {
    const skill = await store.skill(decodeSegment(skillMatch[1]))
    if (!skill || (skill.visibility !== "group" && skill.owner !== login))
      throw new HttpError(404, "skill not found")
    write()
    if (skill.owner !== login && !(await isAdmin(env, session)))
      throw new HttpError(403, "only the skill's author or an admin can change it")
    if (method === "PUT") {
      const fields = validateSkill(
        (await readJson(request)) as Record<string, unknown>,
        new Set(deps.skills.skills.map((s) => s.name)),
      )
      const row = { ...skill, ...fields, updated_at: Date.now() }
      await store.saveSkill(row, false)
      record("gpt.skill.update", row.name)
      return json(row)
    }
    if (method === "DELETE") {
      await store.deleteSkill(skill.id)
      record("gpt.skill.delete", skill.name)
      return json({ deleted: skill.id })
    }
    throw new HttpError(405, "method not allowed")
  }

  // ---- conversations ----
  if (path === "/conversations") {
    if (method === "GET") {
      const p = url.searchParams
      return json(
        await store.listConversations(login, {
          scope: p.get("scope") === "shared" ? "shared" : "mine",
          project: p.get("project"),
          origin: p.get("origin"),
          q: p.get("q"),
          before: Number(p.get("before")) || null,
          limit: Number(p.get("limit")) || 50,
        }),
      )
    }
    if (method === "POST") {
      write()
      const body = (await readJson(request)) as Record<string, unknown>
      const projectId =
        typeof body.project_id === "string" && body.project_id ? body.project_id : null
      const project = projectId ? await store.project(projectId, login) : null
      let origin: string | null = null
      if (typeof body.origin_slug === "string" && body.origin_slug) {
        const knowledge = await loadKnowledge(env, deps.manifest)
        const hit = knowledge.resolve(body.origin_slug)
        origin = hit ? (hit.kind === "page" ? hit.page.slug : hit.path) : null
      }
      const requested = typeof body.model === "string" ? body.model : null
      const conversation = await store.createConversation({
        project_id: project?.id ?? null,
        owner: login,
        title: str(body.title, 120, "title") || "New chat",
        model: MODELS.some((m) => m.id === requested)
          ? requested!
          : (project?.default_model ?? DEFAULT_MODEL),
        origin_slug: origin,
        forked_from: null,
      })
      return json(conversation, 201)
    }
    throw new HttpError(405, "method not allowed")
  }
  const conv = path.match(
    /^\/conversations\/([^/]+)(?:\/(messages|files|shares|fork)(?:\/([^/]+))?)?$/,
  )
  if (conv) {
    const id = decodeSegment(conv[1])
    const sub = conv[2]
    if (sub === "messages") {
      if (method !== "POST") throw new HttpError(405, "method not allowed")
      write()
      // Recorded by the turn itself (gpt.message, with model and token counts).
      record.recorded = true
      return await postMessage(
        request,
        env,
        ctx,
        session,
        id,
        readTurn((await readJson(request)) as Record<string, unknown>),
        deps,
      )
    }
    const { conversation, access } = await store.conversation(id, login)
    const owner = access === "owner"
    if (sub === "files") {
      if (method !== "POST") throw new HttpError(405, "method not allowed")
      write()
      if (!owner) throw new HttpError(403, "not your chat")
      const file = await upload(request, env, store, login, {
        project_id: null,
        conversation_id: conversation.id,
      })
      record("gpt.upload", conversation.id, { name: file.name, size: file.size })
      return json(file, 201)
    }
    if (sub === "fork") {
      if (method !== "POST") throw new HttpError(405, "method not allowed")
      write()
      const copy = await store.fork(conversation, login)
      record("gpt.fork", copy.id, { from: conversation.id, owner: conversation.owner })
      return json(copy, 201)
    }
    if (sub === "shares") {
      if (!owner) throw new HttpError(403, "only the chat's owner can share it")
      if (method === "GET" && !conv[3]) return json(await store.shares(conversation.id))
      write()
      if (method === "POST" && !conv[3]) {
        const body = (await readJson(request)) as { grantee?: unknown }
        const grantee =
          typeof body.grantee === "string" ? body.grantee.trim().replace(/^@/, "") : ""
        if (grantee !== "*" && !LOGIN.test(grantee))
          throw new HttpError(422, "share with a GitHub login, or * for the whole lab")
        if (grantee === login) throw new HttpError(422, "that's you")
        await store.share(conversation.id, grantee, login)
        record("gpt.share", conversation.id, { grantee })
        return json(await store.shares(conversation.id), 201)
      }
      if (method === "DELETE" && conv[3]) {
        const grantee = decodeSegment(conv[3])
        if (!(await store.unshare(conversation.id, grantee)))
          throw new HttpError(404, "not shared with them")
        record("gpt.unshare", conversation.id, { grantee })
        return json(await store.shares(conversation.id))
      }
      throw new HttpError(405, "method not allowed")
    }
    if (method === "GET") {
      const [rows, files, shares] = await Promise.all([
        store.messages(conversation.id),
        store.conversationFiles(conversation.id),
        owner ? store.shares(conversation.id) : Promise.resolve([]),
      ])
      const project = conversation.project_id
        ? await store.project(conversation.project_id, login).catch(() => null)
        : null
      return json({
        conversation,
        access,
        project: project
          ? { id: project.id, name: project.name, visibility: project.visibility }
          : null,
        turns: displayTurns(rows),
        files,
        shares,
      })
    }
    write()
    if (!owner) throw new HttpError(403, "not your chat")
    if (method === "PATCH") {
      const body = (await readJson(request)) as Record<string, unknown>
      const fields: { title?: string; project_id?: string | null } = {}
      if (body.title !== undefined) fields.title = str(body.title, 120, "title") || "Untitled chat"
      if (body.project_id !== undefined)
        fields.project_id = body.project_id
          ? (await store.project(String(body.project_id), login)).id
          : null
      await store.updateConversation(conversation.id, fields)
      return json({ ...conversation, ...fields })
    }
    if (method === "DELETE") {
      const keys = await store.deleteConversation(conversation.id)
      if (keys.length) ctx.waitUntil(env.ARTIFACTS.delete(keys))
      record("gpt.conversation.delete", conversation.id)
      return json({ deleted: conversation.id })
    }
    throw new HttpError(405, "method not allowed")
  }

  throw new HttpError(404, "not found")
}

async function readProject(
  body: Record<string, unknown>,
  env: Env,
  deps: GptDeps,
): Promise<Omit<Project, "id" | "owner" | "created_at" | "updated_at">> {
  const name = str(body.name, 120, "name")
  if (!name) throw new HttpError(422, "give the project a name")
  const list = (v: unknown, field: string, max: number) => {
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
      throw new HttpError(422, `${field} must be a list`)
    if (v.length > max) throw new HttpError(422, `at most ${max} ${field}`)
    return [...new Set((v as string[]).map((x) => x.trim()).filter(Boolean))]
  }
  const topics = list(body.topics, "topics", 20).map((t) => t.replace(/^#/, ""))
  for (const t of topics) if (!TAG.test(t)) throw new HttpError(422, `"${t}" is not a tag`)
  const knowledge = await loadKnowledge(env, deps.manifest)
  const pinned = list(body.pinned, "pinned pages", 50).map((ref) => {
    const hit = knowledge.resolve(ref)
    if (!hit || hit.kind !== "page") throw new HttpError(422, `no page named "${ref}"`)
    return hit.page.slug
  })
  const model =
    typeof body.default_model === "string" && MODELS.some((m) => m.id === body.default_model)
      ? body.default_model
      : null
  return {
    name,
    description: str(body.description, 500, "description"),
    instructions: str(body.instructions, 20_000, "instructions"),
    visibility: body.visibility === "group" ? "group" : "private",
    topics,
    pinned,
    default_model: model,
  }
}

async function requireFileAccess(file: FileRow, store: GptStore, login: string): Promise<void> {
  if (file.owner === login) return
  if (file.project_id) {
    await store.project(file.project_id, login)
    return
  }
  if (file.conversation_id) {
    await store.conversation(file.conversation_id, login)
    return
  }
  throw new HttpError(404, "file not found")
}

async function upload(
  request: Request,
  env: Env,
  store: GptStore,
  login: string,
  owner: { project_id: string | null; conversation_id: string | null },
): Promise<FileRow> {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    throw new HttpError(422, "upload a file as multipart/form-data")
  }
  const file = form.get("file")
  if (!file || typeof file === "string") throw new HttpError(422, "choose a file")
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "files can be up to 25 MB")
  const name = (file.name || "file").replace(/[\\/\r\n"]/g, "_").slice(0, 200)
  const mime = file.type || "application/octet-stream"
  const kind = uploadKind(mime, name)
  if (!kind)
    throw new HttpError(
      415,
      `${name}: upload PDFs, images, or text/code files (convert Office documents to PDF first)`,
    )
  const id = newId("f")
  const bytes = await file.arrayBuffer()
  const key = `gpt/${login}/${id}/${name}`
  await env.ARTIFACTS.put(key, bytes, { httpMetadata: { contentType: mime } })
  const row: FileRow = {
    id,
    ...owner,
    owner: login,
    name,
    mime,
    size: file.size,
    r2_key: key,
    tokens_est:
      kind === "text"
        ? estimateTokens(new TextDecoder().decode(bytes))
        : kind === "pdf"
          ? Math.round(file.size / 60)
          : 1600,
    created_at: Date.now(),
  }
  await store.addFile(row)
  return row
}
