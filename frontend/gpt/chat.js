// One Hafezi GPT conversation: the thread, the streaming reply, and the composer (@-mentions of
// site pages and documents, /skills, file uploads, model picker). The /gpt page and the
// per-page "Ask Hafezi GPT" modal both mount this.
import { h } from "../dashboard/dom.js"
import { LoggedOut, streamTurn } from "./api.js"
import { applyEvent, budgetLabel, mentionQuery, removeToken, slashQuery, sources } from "./model.js"
import { enhanceCode, loadKatex, renderMarkdown } from "./render.js"

const ACCEPT =
  ".pdf,.png,.jpg,.jpeg,.gif,.webp,.txt,.md,.qmd,.py,.m,.jl,.c,.h,.cpp,.js,.ts,.json,.ipynb,.csv,.tsv,.yaml,.yml,.toml,.tex,.bib,.log,.spt,.html,.xml,.sh"

/**
 * @param {object} opts
 * @param {ReturnType<import("./api.js").gptApi>} opts.gpt
 * @param {object} opts.boot   /api/gpt/bootstrap
 * @param {object} opts.session
 * @param {HTMLElement} opts.host
 * @param {"page"|"modal"} opts.mode
 * @param {{slug:string,title:string}|null} [opts.origin]   the page a modal chat is about
 * @param {() => string|null} [opts.project]                  current project id (page mode)
 * @param {(event:object) => void} [opts.onChange]
 */
export function createChat({
  gpt,
  boot,
  session,
  host,
  mode,
  origin = null,
  project = () => null,
  onChange = () => {},
}) {
  loadKatex()
  let conversation = null
  let access = "owner"
  let owner = session.user.login
  let turns = []
  let reply = null
  let controller = null
  let usage = boot.usage
  const attachments = { mentions: [], files: [] }
  let skill = null
  let model = boot.default_model
  let originAttached = !!origin

  // ---- DOM ----
  const thread = h("div", {
    class: "gpt-thread",
    role: "log",
    "aria-live": "polite",
    "aria-label": "Conversation",
  })
  const banner = h("div", { class: "gpt-banner", hidden: true })
  const chips = h("div", { class: "gpt-chips" })
  const input = h("textarea", {
    class: "gpt-input",
    rows: 1,
    placeholder: origin
      ? `Ask about “${origin.title}”…  @ to add pages, / for skills`
      : "Ask Hafezi GPT…  @ to add pages, / for skills",
    "aria-label": "Message Hafezi GPT",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
  })
  const popup = h("ul", { class: "gpt-popup", role: "listbox", hidden: true })
  const fileInput = h("input", { type: "file", multiple: true, accept: ACCEPT, hidden: true })
  const attach = h("button", {
    type: "button",
    class: "gpt-icon-button",
    title: "Attach files (PDF, images, text or code)",
    "aria-label": "Attach files",
    onclick: () => fileInput.click(),
  })
  // Paperclip (inline SVG: emoji glyphs are missing on some systems).
  attach.innerHTML =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>'
  const modelSelect = h(
    "select",
    { class: "gpt-model", "aria-label": "Model" },
    boot.models.map((m) => h("option", { value: m.id, text: m.label, title: m.blurb })),
  )
  const meter = h("span", { class: "gpt-meter muted" })
  const sendButton = h("button", { type: "submit", class: "primary gpt-send", text: "Send" })
  const composer = h(
    "form",
    { class: "gpt-composer" },
    chips,
    h("div", { class: "gpt-input-row" }, input, popup),
    h(
      "div",
      { class: "gpt-toolbar" },
      attach,
      fileInput,
      modelSelect,
      h("span", { class: "spacer" }),
      meter,
      sendButton,
    ),
  )
  const error = h("p", { class: "gpt-error", role: "alert", hidden: true })
  host.replaceChildren(thread, banner, error, composer)
  host.classList.add("gpt-chat", `gpt-chat--${mode}`)

  // ---- thread rendering ----
  function renderThread() {
    thread.replaceChildren()
    if (!turns.length && !reply) thread.append(emptyState())
    for (const turn of turns)
      thread.append(turn.role === "user" ? userMessage(turn) : assistantMessage(turn))
    if (reply) {
      reply.node = assistantMessage(reply)
      thread.append(reply.node)
    }
    scrollDown(true)
  }

  function emptyState() {
    const examples = origin
      ? [
          "Summarize this page",
          "What is this used for, and on which setup?",
          "What should I check before using this?",
        ]
      : [
          "How do I set the wavelength on the Santec laser?",
          "What is the topo automation project about?",
          "I'm new to the lab. Where do I start?",
        ]
    return h(
      "div",
      { class: "gpt-empty" },
      h("p", {
        class: "gpt-empty-title",
        text: origin
          ? `Ask about ${origin.title}`
          : `Hi ${session.user.name?.split(" ")[0] || session.user.login}, what are you working on?`,
      }),
      h("p", {
        class: "muted",
        text: "Answers draw on the lab site, including members-only notes, projects, code and equipment documents, and cite their sources.",
      }),
      h(
        "div",
        { class: "gpt-suggestions" },
        examples.map((text) =>
          h("button", {
            type: "button",
            text,
            onclick: () => ((input.value = text), input.focus(), autosize()),
          }),
        ),
      ),
    )
  }

  function userMessage(turn) {
    const meta = [
      ...(turn.mentions ?? []).map((m) => chip(m.title, m.kind === "document" ? "📄" : "@", m.url)),
      ...(turn.files ?? []).map((f) => chip(f.name, "📎", gpt.fileUrl(f.id))),
      turn.skill ? chip(`/${turn.skill}`, "✦") : null,
    ].filter(Boolean)
    return h(
      "article",
      { class: "gpt-msg gpt-msg--user" },
      meta.length ? h("div", { class: "gpt-msg-meta" }, meta) : null,
      turn.text ? h("div", { class: "gpt-msg-text", text: turn.text }) : null,
    )
  }

  function assistantMessage(turn) {
    const body = h("div", { class: "gpt-msg-body" })
    for (const block of turn.blocks ?? []) {
      if (block.type === "text") {
        const div = h("div", { class: "gpt-md" })
        div.innerHTML = renderMarkdown(block.text, block.citations)
        enhanceCode(div)
        body.append(div)
      } else if (block.type === "thinking") {
        const details = h(
          "details",
          { class: "gpt-thinking" },
          h("summary", {
            text:
              turn.streaming && block === turn.blocks[turn.blocks.length - 1]
                ? "Thinking…"
                : "Thought process",
          }),
        )
        const text = h("div", { class: "gpt-md" })
        text.innerHTML = renderMarkdown(block.text)
        details.append(text)
        body.append(details)
      } else if (block.type === "tool") {
        const state = block.pending ? "pending" : block.is_error ? "error" : "done"
        body.append(
          h(
            "div",
            { class: `gpt-tool gpt-tool--${state}` },
            h("span", {
              class: "gpt-tool-icon",
              "aria-hidden": "true",
              text: state === "pending" ? "◌" : state === "error" ? "!" : "✓",
            }),
            h("span", { text: block.summary || block.label }),
          ),
        )
      } else if (block.type === "compaction") {
        body.append(
          h("p", {
            class: "gpt-note muted",
            text: "Earlier messages were summarized to make room.",
          }),
        )
      }
    }
    if (turn.streaming && !(turn.blocks ?? []).some((b) => b.type === "text"))
      body.append(
        h(
          "div",
          { class: "gpt-typing", "aria-label": "Hafezi GPT is working" },
          h("span"),
          h("span"),
          h("span"),
        ),
      )
    const found = sources(turn)
    const foot = h("footer", { class: "gpt-msg-foot" })
    if (found.length)
      foot.append(
        h(
          "div",
          { class: "gpt-sources" },
          h("span", { class: "muted", text: "Sources" }),
          found.slice(0, 8).map((s) => h("a", { href: s.url, text: s.title, title: s.url })),
        ),
      )
    if (!turn.streaming && turn.usage && turn.model && turn.model !== "offline") {
      const u = turn.usage
      const label = boot.models.find((m) => m.id === turn.model)?.label ?? turn.model
      const tokens = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
      foot.append(
        h("span", {
          class: "muted gpt-usage",
          title: `${u.input} input (incl. ${u.cache_write} cache writes) · ${u.cache_read} cached · ${u.output} output · $${(u.cost_usd ?? 0).toFixed(3)}`,
          text: `${label} · ${tokens(u.input + u.cache_read)} in${u.cache_read ? ` (${tokens(u.cache_read)} cached)` : ""} · ${tokens(u.output)} out`,
        }),
      )
    }
    if (turn.stopped) foot.append(h("span", { class: "muted", text: "Stopped" }))
    if (turn.error) foot.append(h("p", { class: "gpt-error", role: "alert", text: turn.error }))
    if (!turn.streaming && (turn.blocks ?? []).some((b) => b.type === "text"))
      foot.append(
        h("button", {
          type: "button",
          class: "gpt-link-button",
          text: "Copy",
          onclick: (event) => {
            navigator.clipboard?.writeText(
              turn.blocks
                .filter((b) => b.type === "text")
                .map((b) => b.text.replace(/\[\^\d+\]/g, ""))
                .join("\n\n"),
            )
            event.target.textContent = "Copied"
          },
        }),
      )
    return h(
      "article",
      { class: "gpt-msg gpt-msg--assistant" },
      body,
      foot.childNodes.length ? foot : null,
    )
  }

  const chip = (label, icon, href) =>
    h(
      href ? "a" : "span",
      {
        class: "gpt-chip",
        ...(href ? { href, target: href.startsWith("/api/") ? "_blank" : null } : {}),
      },
      h("span", { "aria-hidden": "true", text: icon }),
      label,
    )

  let frame = 0
  function renderReply() {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (!reply) return
      const node = assistantMessage(reply)
      reply.node?.replaceWith(node)
      reply.node = node
      scrollDown()
    })
  }

  function scrollDown(force = false) {
    const near = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160
    if (force || near) thread.scrollTop = thread.scrollHeight
  }

  function showBanner(children, kind = "info") {
    banner.hidden = false
    banner.className = `gpt-banner gpt-banner--${kind}`
    banner.replaceChildren(...children)
  }

  function showError(message) {
    error.hidden = !message
    error.textContent = message ?? ""
  }

  // ---- composer: chips ----
  function renderChips() {
    const items = []
    if (origin && originAttached)
      items.push(
        removable(
          `This page: ${origin.title}`,
          "📍",
          () => ((originAttached = false), renderChips()),
        ),
      )
    for (const m of attachments.mentions)
      items.push(
        removable(m.title, m.kind === "document" ? "📄" : "@", () => {
          attachments.mentions = attachments.mentions.filter((x) => x !== m)
          renderChips()
        }),
      )
    for (const f of attachments.files)
      items.push(
        removable(f.uploading ? `${f.name} (uploading…)` : f.name, "📎", async () => {
          attachments.files = attachments.files.filter((x) => x !== f)
          renderChips()
          if (f.id) gpt.deleteFile(f.id).catch(() => {})
        }),
      )
    if (skill) items.push(removable(`/${skill}`, "✦", () => ((skill = null), renderChips())))
    chips.replaceChildren(...items)
    chips.hidden = !items.length
  }

  const removable = (label, icon, remove) =>
    h(
      "span",
      { class: "gpt-chip gpt-chip--removable" },
      h("span", { "aria-hidden": "true", text: icon }),
      label,
      h("button", { type: "button", "aria-label": `Remove ${label}`, text: "×", onclick: remove }),
    )

  // ---- composer: @ and / popups ----
  let options = []
  let active = 0
  let lookup = 0
  let trigger = null

  function closePopup() {
    popup.hidden = true
    options = []
    trigger = null
    input.setAttribute("aria-expanded", "false")
  }

  function showOptions(list) {
    options = list
    active = 0
    popup.hidden = !list.length
    input.setAttribute("aria-expanded", String(!popup.hidden))
    popup.replaceChildren(
      ...list.map((option, i) =>
        h(
          "li",
          {
            role: "option",
            id: `gpt-opt-${i}`,
            class: "gpt-option",
            "aria-selected": String(i === active),
            onmousedown: (event) => (event.preventDefault(), choose(i)),
          },
          h("span", { class: "gpt-option-title", text: option.title }),
          h("span", { class: "gpt-option-hint muted", text: option.hint }),
        ),
      ),
    )
  }

  function highlight(i) {
    active = (i + options.length) % options.length
    popup
      .querySelectorAll("[role=option]")
      .forEach((node, j) => node.setAttribute("aria-selected", String(j === active)))
    popup.children[active]?.scrollIntoView({ block: "nearest" })
    input.setAttribute("aria-activedescendant", `gpt-opt-${active}`)
  }

  function choose(i) {
    const option = options[i]
    if (!option || !trigger) return
    const caret = input.selectionStart
    if (trigger.kind === "mention") {
      if (!attachments.mentions.some((m) => m.ref === option.ref))
        attachments.mentions.push({ ref: option.ref, title: option.title, kind: option.kind })
      const next = removeToken(input.value, trigger.start, caret)
      input.value = next.text
      input.setSelectionRange(next.caret, next.caret)
    } else {
      skill = option.ref
      input.value = input.value.replace(/^\/\S*\s?/, "")
    }
    closePopup()
    renderChips()
    autosize()
    input.focus()
  }

  async function updatePopup() {
    const caret = input.selectionStart
    const slash = slashQuery(input.value, caret)
    if (slash) {
      trigger = { kind: "skill" }
      const q = slash.query
      const list = boot.skills
        .filter((s) => s.name.includes(q) || s.description.toLowerCase().includes(q))
        .slice(0, 8)
        .map((s) => ({ ref: s.name, title: `/${s.name}`, hint: s.description }))
      return showOptions(list)
    }
    const mention = mentionQuery(input.value, caret)
    if (!mention) return closePopup()
    trigger = { kind: "mention", start: mention.start }
    if (!mention.query) {
      options = []
      popup.hidden = false
      popup.replaceChildren(
        h("li", { class: "gpt-option muted", text: "Type to search pages and documents…" }),
      )
      return
    }
    const ticket = ++lookup
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (ticket !== lookup) return
    try {
      const results = await gpt.pages(mention.query)
      if (ticket !== lookup || !trigger) return
      showOptions(
        results.map((r) => ({
          ...r,
          hint: r.kind === "document" ? `document · ${r.hint}` : r.hint,
        })),
      )
    } catch {
      closePopup()
    }
  }

  // ---- composer: files ----
  async function ensureConversation() {
    if (conversation) return conversation
    conversation = await gpt.createConversation({
      project_id: project(),
      origin_slug: origin && originAttached ? origin.slug : null,
      model,
    })
    access = "owner"
    owner = session.user.login
    onChange({ type: "created", conversation })
    return conversation
  }

  async function addFiles(list) {
    showError(null)
    for (const file of list) {
      const entry = { name: file.name, uploading: true }
      attachments.files.push(entry)
      renderChips()
      try {
        const c = await ensureConversation()
        const saved = await gpt.upload(`conversations/${encodeURIComponent(c.id)}/files`, file)
        Object.assign(entry, saved, { uploading: false })
      } catch (err) {
        attachments.files = attachments.files.filter((x) => x !== entry)
        showError(err.message)
      }
      renderChips()
    }
  }

  // ---- sending ----
  async function submit() {
    if (controller) return
    const text = input.value.trim()
    if (!text && !skill) return input.focus()
    if (attachments.files.some((f) => f.uploading)) return showError("Wait for uploads to finish.")
    showError(null)
    closePopup()
    let c
    try {
      c = await ensureConversation()
    } catch (err) {
      return showError(err.message)
    }
    const body = {
      text,
      mentions: attachments.mentions.map((m) => m.ref),
      files: attachments.files.map((f) => f.id),
      skill,
      model,
    }
    turns.push({
      role: "user",
      text,
      mentions: [
        ...(origin && originAttached && !turns.length
          ? [{ ...origin, kind: "page", url: `/${origin.slug}` }]
          : []),
        ...attachments.mentions,
      ],
      files: attachments.files.map((f) => ({ id: f.id, name: f.name, mime: f.mime })),
      skill,
    })
    reply = { role: "assistant", blocks: [], streaming: true }
    input.value = ""
    attachments.mentions = []
    attachments.files = []
    skill = null
    originAttached = false
    renderChips()
    autosize()
    renderThread()
    setBusy(true)
    controller = new AbortController()
    try {
      await streamTurn(c.id, body, {
        signal: controller.signal,
        onEvent: (name, data) => {
          reply = { ...applyEvent(reply, name, data), node: reply.node }
          if (name === "title") {
            conversation = { ...conversation, title: data.title }
            onChange({ type: "title", conversation })
          }
          if (name === "usage") {
            usage = { ...usage, used: data.used, budget: data.budget }
            updateMeter()
          }
          renderReply()
        },
      })
    } catch (err) {
      if (err instanceof LoggedOut)
        return location.assign(
          "/auth/login?next=" + encodeURIComponent(location.pathname + location.search),
        )
      if (err.name === "AbortError") reply = { ...reply, stopped: true }
      else {
        reply = { ...reply, error: err.message }
        // The message never reached the model (e.g. budget, bad mention): give the text back.
        if (!reply.blocks.length) {
          const failed = turns.pop()
          input.value = failed.text
          autosize()
        }
      }
    } finally {
      controller = null
      setBusy(false)
      if (reply) {
        reply = { ...reply, streaming: false }
        if (reply.blocks.length || reply.stopped) turns.push(reply)
        else if (reply.error) showError(reply.error)
      }
      reply = null
      renderThread()
      onChange({ type: "updated", conversation })
    }
  }

  function setBusy(busy) {
    sendButton.textContent = busy ? "Stop" : "Send"
    sendButton.classList.toggle("danger", busy)
    sendButton.classList.toggle("primary", !busy)
    sendButton.type = busy ? "button" : "submit"
    sendButton.onclick = busy ? () => controller?.abort() : null
  }

  function updateMeter() {
    const label = budgetLabel(usage)
    meter.textContent = label ?? ""
    meter.hidden = !label
    const over = usage?.budget != null && usage.used >= usage.budget
    meter.classList.toggle("gpt-meter--over", over)
  }

  function autosize() {
    input.style.height = "auto"
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`
  }

  // ---- events ----
  composer.addEventListener("submit", (event) => {
    event.preventDefault()
    submit()
  })
  input.addEventListener("input", () => {
    autosize()
    updatePopup()
  })
  input.addEventListener("click", updatePopup)
  input.addEventListener("blur", () => setTimeout(closePopup, 150))
  input.addEventListener("keydown", (event) => {
    if (!popup.hidden && options.length) {
      if (event.key === "ArrowDown") return (event.preventDefault(), highlight(active + 1))
      if (event.key === "ArrowUp") return (event.preventDefault(), highlight(active - 1))
      if (event.key === "Enter" || event.key === "Tab")
        return (event.preventDefault(), choose(active))
    }
    if (event.key === "Escape" && !popup.hidden)
      return (event.preventDefault(), event.stopPropagation(), closePopup())
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  })
  input.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])]
    if (files.length) {
      event.preventDefault()
      addFiles(files)
    }
  })
  fileInput.addEventListener("change", () => {
    addFiles([...fileInput.files])
    fileInput.value = ""
  })
  modelSelect.addEventListener("change", () => (model = modelSelect.value))
  for (const name of ["dragenter", "dragover"])
    host.addEventListener(name, (event) => {
      if (![...(event.dataTransfer?.types ?? [])].includes("Files") || access !== "owner") return
      event.preventDefault()
      host.classList.add("gpt-dropping")
    })
  host.addEventListener("dragleave", (event) => {
    if (!host.contains(event.relatedTarget)) host.classList.remove("gpt-dropping")
  })
  host.addEventListener("drop", (event) => {
    host.classList.remove("gpt-dropping")
    if (!event.dataTransfer?.files?.length || access !== "owner") return
    event.preventDefault()
    addFiles([...event.dataTransfer.files])
  })

  function applyAccess() {
    composer.hidden = access !== "owner"
    if (access === "owner") {
      if (!boot.offline) banner.hidden = true
      return
    }
    showBanner(
      [
        h("span", { text: `Shared by ${owner} · read-only` }),
        h("button", {
          type: "button",
          class: "primary",
          text: "Continue in my own chat",
          onclick: async () => {
            try {
              const copy = await gpt.fork(conversation.id)
              onChange({ type: "forked", conversation: copy })
            } catch (err) {
              showError(err.message)
            }
          },
        }),
      ],
      "shared",
    )
  }

  // First paint, once every helper above is defined.
  if (boot.offline)
    showBanner(
      [
        h("span", {
          text: "Hafezi GPT is offline here (no API key): replies only show what context would be sent.",
        }),
      ],
      "info",
    )
  updateMeter()
  renderChips()
  renderThread()

  return {
    /** Open an existing conversation (null → a fresh chat). */
    async open(id) {
      controller?.abort()
      showError(null)
      if (!id) {
        conversation = null
        access = "owner"
        owner = session.user.login
        turns = []
        originAttached = !!origin
        model = boot.default_model
        modelSelect.value = model
        applyAccess()
        renderChips()
        renderThread()
        return null
      }
      thread.replaceChildren(h("p", { class: "muted gpt-loading", text: "Loading chat…" }))
      const data = await gpt.conversation(id)
      conversation = data.conversation
      access = data.access
      owner = data.conversation.owner
      turns = data.turns
      originAttached = false
      model = conversation.model
      modelSelect.value = model
      applyAccess()
      renderChips()
      renderThread()
      return data
    },
    get conversation() {
      return conversation
    },
    focus: () => input.focus(),
    busy: () => !!controller,
    stop: () => controller?.abort(),
  }
}
