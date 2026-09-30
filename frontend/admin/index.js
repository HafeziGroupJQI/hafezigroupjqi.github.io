// /admin: the group-admin console. Audit log (who signed in when, what they did), the admin
// allow-list (org owners are always admins), members' claims of People pages, members' upload
// drafts, and Hafezi GPT usage + monthly budgets. The Worker
// enforces admin access on every /api/admin/* call; this page just shows a notice to non-admins.
import { h } from "../dashboard/dom.js"
import {
  ACTION_GROUPS,
  auditParams,
  budgetUsed,
  describe,
  formatTokens,
  formatUsd,
  formatWhen,
  nextTab,
  parseBudget,
  tabUrl,
  USAGE_SOURCES,
  usageByDay,
} from "./model.js"
import { changeLabel, draftName, statusLabel } from "../uploads/model.js"

const TABS = [
  ["audit", "Audit log"],
  ["admins", "Admins"],
  ["claims", "Profile claims"],
  ["uploads", "Uploads"],
  ["usage", "Usage & budgets"],
  ["conversations", "Conversations"],
]

export function mountAdmin(root, { api, session }) {
  root.replaceChildren()
  root.classList.add("dashboard", "admin-console")
  const header = h(
    "header",
    { class: "dash-header" },
    h("h1", { class: "dash-title", text: "Admin" }),
    h("p", {
      class: "dash-summary",
      text: "Sign-ins, member activity, admins, People page claims, uploads and Hafezi GPT usage",
    }),
  )
  root.append(header)
  if (!session.user?.is_admin) {
    root.append(
      h(
        "div",
        { class: "dash-empty" },
        h("p", { text: "This page is for group admins. Ask an org owner or an admin to add you." }),
      ),
    )
    return
  }
  const tabs = h("div", { class: "dash-tabs", role: "tablist", "aria-label": "Admin sections" })
  const banner = h("div", { class: "dash-error", role: "alert", hidden: true })
  const panel = h("div", {
    class: "dash-panel",
    role: "tabpanel",
    id: "admin-panel",
    tabindex: "-1",
  })
  root.append(tabs, banner, panel)

  const params = new URLSearchParams(location.search)
  let tab = TABS.some(([id]) => id === params.get("tab")) ? params.get("tab") : "audit"
  for (const [id, label] of TABS)
    tabs.append(
      h("button", {
        type: "button",
        role: "tab",
        "data-tab": id,
        "aria-controls": "admin-panel",
        text: label,
        onclick: () => show(id),
      }),
    )
  // Claims wait for an admin, so the tab says how many there are.
  const claimsButton = [...tabs.children].find((button) => button.dataset.tab === "claims")
  const countClaims = (n) =>
    (claimsButton.textContent = n ? `Profile claims (${n})` : "Profile claims")
  api("/api/admin/profile-claims")
    .then((data) => countClaims(data.claims.length))
    .catch(() => {})
  // Drafts with something in them that runs wait for an admin to merge them on GitHub.
  const uploadsButton = [...tabs.children].find((button) => button.dataset.tab === "uploads")
  const countUploads = (drafts) => {
    const n = drafts.filter((draft) => draft.status === "review").length
    uploadsButton.textContent = n ? `Uploads (${n})` : "Uploads"
  }
  api("/api/admin/uploads")
    .then((data) => countUploads(data.drafts))
    .catch(() => {})
  // Arrow keys, Home and End move between tabs; Tab moves into the panel.
  tabs.addEventListener("keydown", (event) => {
    const buttons = [...tabs.children]
    const next = nextTab(buttons.indexOf(document.activeElement), event.key, buttons.length)
    if (next === null) return
    event.preventDefault()
    buttons[next].focus()
    show(buttons[next].dataset.tab)
  })

  const fail = (error) => {
    banner.hidden = false
    banner.textContent = error.message
  }

  function show(id) {
    tab = id
    banner.hidden = true
    for (const button of tabs.children) {
      button.setAttribute("aria-selected", String(button.dataset.tab === id))
      button.tabIndex = button.dataset.tab === id ? 0 : -1
    }
    history.replaceState(history.state, "", tabUrl(location.href, id))
    panel.replaceChildren()
    ;({
      audit: auditTab,
      admins: adminsTab,
      claims: claimsTab,
      uploads: uploadsTab,
      usage: usageTab,
      conversations: conversationsTab,
    })
      [id](panel)
      .catch(fail)
  }

  // ---- audit log ----
  async function auditTab(panel) {
    const form = h(
      "form",
      { class: "dash-toolbar admin-filters" },
      h(
        "label",
        { class: "dash-field" },
        "Member",
        h("input", { name: "login", placeholder: "GitHub login", autocomplete: "off" }),
      ),
      h(
        "label",
        { class: "dash-field" },
        "Action",
        h(
          "select",
          { name: "action" },
          ACTION_GROUPS.map(([value, label]) => h("option", { value, text: label })),
        ),
      ),
      h("label", { class: "dash-field" }, "From", h("input", { name: "since", type: "date" })),
      h("label", { class: "dash-field" }, "To", h("input", { name: "until", type: "date" })),
      h("button", { type: "submit", class: "primary", text: "Filter" }),
      h("button", { type: "button", text: "Export CSV", onclick: () => exportCsv().catch(fail) }),
    )
    const list = h("ol", { class: "activity-list audit-list", "aria-live": "polite" })
    const more = h("button", {
      type: "button",
      hidden: true,
      text: "Show more",
      onclick: () => load(false).catch(fail),
    })
    panel.append(form, list, more)
    const filters = () => Object.fromEntries(new FormData(form))
    let before = null

    async function load(reset) {
      if (reset) {
        before = null
        list.replaceChildren(h("li", { class: "muted", text: "Loading…" }))
      }
      const page = await api(`/api/admin/audit?${auditParams(filters(), before)}`)
      if (reset) list.replaceChildren()
      if (reset && !page.rows.length)
        list.append(h("li", { class: "dash-empty", text: "No matching activity." }))
      for (const row of page.rows) list.append(auditCard(row))
      before = page.next_before_id
      more.hidden = before == null
    }
    async function exportCsv() {
      const response = await fetch(`/api/admin/audit.csv?${auditParams(filters(), null, 0)}`, {
        cache: "no-store",
      })
      if (!response.ok) throw new Error("Export failed")
      const link = h("a", {
        href: URL.createObjectURL(await response.blob()),
        download: `hafezi-audit-${new Date().toISOString().slice(0, 10)}.csv`,
      })
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000)
    }
    form.onsubmit = (event) => {
      event.preventDefault()
      load(true).catch(fail)
    }
    await load(true)
  }

  function auditCard(row) {
    const kind = row.action.split(".")[0]
    return h(
      "li",
      { class: `cmd-card audit-row audit-${kind}` },
      h(
        "header",
        {},
        h("time", {
          class: "mono muted",
          datetime: new Date(row.at).toISOString(),
          text: formatWhen(row.at),
        }),
        h("strong", { class: "mono", text: row.login }),
        h("span", { text: describe(row) }),
        h("span", { class: "spacer" }),
        row.status >= 400
          ? h("span", { class: "status status-failed", text: String(row.status) })
          : null,
      ),
      row.ip || row.user_agent
        ? h("p", {
            class: "muted audit-meta",
            text: [row.ip, row.user_agent].filter(Boolean).join(" · "),
          })
        : null,
    )
  }

  // ---- admins ----
  async function adminsTab(panel) {
    const data = await api("/api/admin/admins")
    const list = h("ul", { class: "admin-list" })
    const form = h(
      "form",
      { class: "dash-toolbar" },
      h(
        "label",
        { class: "dash-field" },
        "Add an admin",
        h("input", {
          name: "login",
          placeholder: "GitHub login",
          required: true,
          autocomplete: "off",
        }),
      ),
      h("button", { type: "submit", class: "primary", text: "Add" }),
    )
    panel.append(
      h(
        "p",
        { class: "muted" },
        "Owners of the ",
        h("code", { text: data.org }),
        " GitHub organization are always admins. Admins can see the audit log and members' Hafezi GPT conversations, add or remove admins, and set Hafezi GPT budgets.",
      ),
      form,
      list,
    )
    const render = (admins) => {
      list.replaceChildren(
        ...(admins.length
          ? admins.map((a) =>
              h(
                "li",
                { class: "cmd-card" },
                h(
                  "header",
                  {},
                  h("strong", { class: "mono", text: a.login }),
                  h("span", {
                    class: "muted",
                    text: `added by ${a.added_by} · ${formatWhen(a.added_at)}`,
                  }),
                  h("span", { class: "spacer" }),
                  a.login === session.user.login
                    ? null
                    : h("button", {
                        type: "button",
                        class: "danger",
                        text: "Remove",
                        onclick: async () => {
                          if (!confirm(`Remove ${a.login} as an admin?`)) return
                          try {
                            await api(`/api/admin/admins/${encodeURIComponent(a.login)}`, {
                              method: "DELETE",
                            })
                            panel.replaceChildren()
                            await adminsTab(panel)
                          } catch (error) {
                            fail(error)
                          }
                        },
                      }),
                ),
              ),
            )
          : [h("li", { class: "dash-empty", text: "No extra admins yet." })]),
      )
    }
    render(data.admins)
    form.onsubmit = async (event) => {
      event.preventDefault()
      try {
        await api("/api/admin/admins", {
          method: "POST",
          body: JSON.stringify({ login: form.elements.namedItem("login").value }),
        })
        panel.replaceChildren()
        await adminsTab(panel)
      } catch (error) {
        fail(error)
      }
    }
  }

  // ---- members' claims of People pages ----
  async function claimsTab(panel) {
    const data = await api("/api/admin/profile-claims")
    countClaims(data.claims.length)
    const decide = (claim, decision) => async () => {
      if (decision === "reject" && !confirm(`Turn down ${claim.login}'s claim of ${claim.url}?`))
        return
      try {
        await api(`/api/admin/profile-claims/${encodeURIComponent(claim.login)}/${decision}`, {
          method: "POST",
        })
        panel.replaceChildren()
        await claimsTab(panel)
      } catch (error) {
        fail(error)
      }
    }
    panel.append(
      h("p", {
        class: "muted",
        text: "Members link their GitHub login to their People page in Settings. Approve a claim only when the page is theirs: its name and photo then show as theirs in the navbar and Hafezi GPT, and their edits go into the public page. A claim turned down frees the page again.",
      }),
      h(
        "ul",
        { class: "admin-list" },
        data.claims.length
          ? data.claims.map((claim) =>
              h(
                "li",
                { class: "cmd-card" },
                h(
                  "header",
                  {},
                  h("strong", { class: "mono", text: claim.login }),
                  h(
                    "span",
                    {},
                    "claims ",
                    h("a", { href: claim.url, target: "_blank", rel: "noopener", text: claim.url }),
                  ),
                  h("span", {
                    class: "muted",
                    text: claim.claimed_at ? formatWhen(claim.claimed_at) : "",
                  }),
                  h("span", { class: "spacer" }),
                  h("button", {
                    type: "button",
                    class: "primary",
                    text: "Approve",
                    onclick: decide(claim, "approve"),
                  }),
                  h("button", {
                    type: "button",
                    class: "danger",
                    text: "Reject",
                    onclick: decide(claim, "reject"),
                  }),
                ),
              ),
            )
          : h("li", { class: "dash-empty", text: "No claims are waiting." }),
      ),
    )
  }

  // ---- members' uploads to the private vault ----
  async function uploadsTab(panel) {
    const data = await api("/api/admin/uploads")
    countUploads(data.drafts)
    const drop = (draft) => async () => {
      if (
        !confirm(`Discard ${draft.login}'s draft "${draftName(draft)}"? Its pull request closes.`)
      )
        return
      try {
        await api(`/api/admin/uploads/${draft.id}/discard`, { method: "POST" })
        panel.replaceChildren()
        await uploadsTab(panel)
      } catch (error) {
        fail(error)
      }
    }
    panel.append(
      h("p", {
        class: "muted",
        text: "Members' drafts of changes to the private vault. A sent draft is a pull request on GitHub, merged by the hourly run once the vault's check passes. A draft with something in it that runs (Quarto code, a Wolfram notebook, HTML in a page or a notebook's outputs) waits for an admin: read its pull request's diff, then merge it on GitHub. Discarding one closes its pull request.",
      }),
      h(
        "ul",
        { class: "admin-list" },
        data.drafts.length
          ? data.drafts.map((draft) =>
              h(
                "li",
                { class: `cmd-card${draft.status === "review" ? " audit-admin" : ""}` },
                h(
                  "header",
                  {},
                  h("strong", { class: "mono", text: draft.login }),
                  h("span", { text: draftName(draft) }),
                  h("span", { class: "spacer" }),
                  draft.pull
                    ? h("a", {
                        href: draft.pull.url,
                        target: "_blank",
                        rel: "noopener",
                        text: `Pull request #${draft.pull.number}`,
                      })
                    : null,
                  h("button", {
                    type: "button",
                    class: "danger",
                    text: "Discard",
                    onclick: drop(draft),
                  }),
                ),
                h("p", { class: "muted", text: statusLabel(draft) }),
                h(
                  "ul",
                  {},
                  draft.changes.map((change) =>
                    h("li", {
                      text:
                        changeLabel(change) + (change.review ? ` (runs: ${change.review})` : ""),
                    }),
                  ),
                ),
              ),
            )
          : h("li", { class: "dash-empty", text: "No drafts are open." }),
      ),
    )
  }

  // ---- usage & budgets ----
  async function usageTab(panel) {
    const month = h("input", { type: "month", value: new Date().toISOString().slice(0, 7) })
    const table = h("table", { class: "bases-table usage-table" })
    const byModel = h("table", { class: "bases-table usage-table" })
    const byDay = h("table", { class: "bases-table usage-table" })
    panel.append(
      h("div", { class: "dash-toolbar" }, h("label", { class: "dash-field" }, "Month", month)),
      h("p", {
        class: "muted",
        text: "Tokens and estimated cost per member this month. A budget caps a member's input + output tokens per calendar month (UTC); leave it empty for no limit.",
      }),
      h("div", { class: "table-scroll" }, table),
      h("h2", { text: "By model and source" }),
      h("p", {
        class: "muted",
        text: "The whole group's spend this month: the site chat (and the lab's Hafezi GPT panel), the lab's coding agent, and its ghost text (inline code completions). Split from when daily counting began: earlier usage is only in the totals above.",
      }),
      h("div", { class: "table-scroll" }, byModel),
      h("h2", { text: "By day" }),
      h("div", { class: "table-scroll" }, byDay),
    )
    async function load() {
      const data = await api(`/api/admin/usage?month=${month.value}`)
      split(data)
      const total = data.members.reduce((sum, m) => sum + m.cost_usd, 0)
      table.replaceChildren(
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            ["Member", "Input", "Output", "Cache reads", "Cost", "Budget", "Used"].map((t) =>
              h("th", { text: t }),
            ),
          ),
        ),
        h(
          "tbody",
          {},
          data.members.map((m) => usageRow(m)),
        ),
        h(
          "tfoot",
          {},
          h(
            "tr",
            {},
            h("th", { text: "Total" }),
            h("td", { colspan: 3 }),
            h("td", { text: formatUsd(total) }),
            h("td", { colspan: 2 }),
          ),
        ),
      )
    }
    function split({ models = [], days = [] }) {
      const heads = (labels) =>
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            labels.map((t) => h("th", { text: t })),
          ),
        )
      const none = (colspan) =>
        h("tr", {}, h("td", { colspan, class: "muted", text: "Nothing counted this month." }))
      byModel.replaceChildren(
        heads(["Model", "Source", "Requests", "Input", "Output", "Cache reads", "Cost"]),
        h(
          "tbody",
          {},
          models.length
            ? models.map((r) =>
                h(
                  "tr",
                  {},
                  h("td", { text: r.label }),
                  h("td", { text: USAGE_SOURCES[r.source] ?? r.source }),
                  h("td", { text: formatTokens(r.requests) }),
                  h("td", { text: formatTokens(r.input) }),
                  h("td", { text: formatTokens(r.output) }),
                  h("td", { text: formatTokens(r.cache_read) }),
                  h("td", { text: formatUsd(r.cost_usd) }),
                ),
              )
            : none(7),
        ),
      )
      const { columns, rows } = usageByDay(days)
      byDay.replaceChildren(
        heads(["Day", ...columns.map((c) => c.label), "Total"]),
        h(
          "tbody",
          {},
          rows.length
            ? rows.map((row) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "mono", text: row.day }),
                  columns.map((c) => {
                    const cell = row.cells[c.key]
                    return cell
                      ? h("td", {
                          text: formatUsd(cell.cost_usd),
                          title: `${formatTokens(cell.input + cell.output)} tokens in ${cell.requests} requests`,
                        })
                      : h("td", { class: "muted", text: "—" })
                  }),
                  h("td", { text: formatUsd(row.cost_usd) }),
                ),
              )
            : none(columns.length + 2),
        ),
      )
    }
    function usageRow(m) {
      const used = budgetUsed(m)
      const input = h("input", {
        class: "budget-input",
        value: m.monthly_tokens == null ? "" : formatTokens(m.monthly_tokens),
        placeholder: "no limit",
        "aria-label": `Monthly token budget for ${m.login}`,
        size: 8,
      })
      input.onchange = async () => {
        try {
          const monthly_tokens = parseBudget(input.value)
          await api(`/api/admin/budgets/${encodeURIComponent(m.login)}`, {
            method: "PUT",
            body: JSON.stringify({ monthly_tokens }),
          })
          input.value = monthly_tokens == null ? "" : formatTokens(monthly_tokens)
          banner.hidden = true
        } catch (error) {
          fail(error)
        }
      }
      return h(
        "tr",
        {},
        h("td", { class: "mono", text: m.login }),
        h("td", { text: formatTokens(m.input) }),
        h("td", { text: formatTokens(m.output) }),
        h("td", { text: formatTokens(m.cache_read) }),
        h("td", { text: formatUsd(m.cost_usd) }),
        h("td", {}, input),
        h(
          "td",
          {},
          used == null
            ? h("span", { class: "muted", text: "—" })
            : h("meter", {
                min: 0,
                max: 1,
                low: 0.7,
                high: 0.9,
                optimum: 0,
                value: used,
                title: `${Math.round(used * 100)}%`,
              }),
        ),
      )
    }
    month.onchange = () => load().catch(fail)
    await load()
  }

  // ---- Hafezi GPT conversations: members → their chats → a transcript ----
  async function conversationsTab(panel) {
    const view = h("div", { class: "admin-conversations" })
    panel.append(view)
    // Deep links: ?tab=conversations&member=<login>&c=<conversation id>.
    const setQuery = (values) => {
      const url = new URL(location.href)
      for (const [key, value] of Object.entries(values))
        value ? url.searchParams.set(key, value) : url.searchParams.delete(key)
      history.replaceState(history.state, "", url)
    }
    const back = (text, onclick) => h("button", { type: "button", class: "link", text, onclick })
    const table = (heads, rows) =>
      h(
        "div",
        { class: "table-scroll" },
        h(
          "table",
          { class: "bases-table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              heads.map((t) => h("th", { text: t })),
            ),
          ),
          h("tbody", {}, rows),
        ),
      )

    async function members() {
      setQuery({ member: null, c: null })
      const data = await api("/api/admin/gpt/members")
      view.replaceChildren(
        data.members.length
          ? table(
              ["Member", "Conversations", "Messages", "Last active"],
              data.members.map((m) =>
                h(
                  "tr",
                  {},
                  h(
                    "td",
                    {},
                    h("button", {
                      type: "button",
                      class: "link mono",
                      text: m.login,
                      onclick: () => chats(m.login).catch(fail),
                    }),
                  ),
                  h("td", { text: String(m.conversations) }),
                  h("td", { text: String(m.messages) }),
                  h("td", { text: m.last_at ? formatWhen(m.last_at) : "—" }),
                ),
              ),
            )
          : h("p", { class: "dash-empty", text: "No Hafezi GPT conversations yet." }),
      )
    }

    async function chats(login) {
      setQuery({ member: login, c: null })
      const data = await api(`/api/admin/gpt/conversations?login=${encodeURIComponent(login)}`)
      view.replaceChildren(
        h(
          "div",
          { class: "dash-toolbar" },
          back("← All members", () => members().catch(fail)),
          h("h2", { class: "mono", text: login }),
        ),
        table(
          ["Conversation", "Project", "Messages", "Updated"],
          data.conversations.map((c) =>
            h(
              "tr",
              {},
              h(
                "td",
                {},
                h("button", {
                  type: "button",
                  class: "link",
                  text: c.title,
                  onclick: () => transcript(login, c.id).catch(fail),
                }),
              ),
              h("td", { text: c.project ?? "—" }),
              h("td", { text: String(c.messages) }),
              h("td", { text: formatWhen(c.updated_at) }),
            ),
          ),
        ),
      )
    }

    async function transcript(login, id) {
      setQuery({ member: login, c: id })
      const [{ renderMarkdown }, data] = await Promise.all([
        import("../gpt/render.js"),
        api(`/api/admin/gpt/conversations/${encodeURIComponent(id)}`),
      ])
      const { conversation } = data
      const markdown = (text, citations) => {
        const div = h("div", { class: "gpt-md" })
        div.innerHTML = renderMarkdown(text, citations)
        return div
      }
      const turn = (t) =>
        t.role === "user"
          ? h(
              "article",
              { class: "gpt-msg gpt-msg--user" },
              h("div", { class: "gpt-msg-meta muted", text: formatWhen(t.at) }),
              t.context ? h("div", { class: "gpt-msg-meta", text: `🧪 ${t.context.label}` }) : null,
              h("div", { class: "gpt-msg-text", text: t.text }),
            )
          : h(
              "article",
              { class: "gpt-msg" },
              h("div", {
                class: "gpt-msg-meta muted",
                text: [formatWhen(t.at), t.model].filter(Boolean).join(" · "),
              }),
              h(
                "div",
                { class: "gpt-msg-body" },
                t.blocks.map((block) =>
                  block.type === "text"
                    ? markdown(block.text, block.citations)
                    : block.type === "thinking"
                      ? h(
                          "details",
                          { class: "gpt-thinking" },
                          h("summary", { text: "Thought process" }),
                          markdown(block.text),
                        )
                      : block.type === "tool"
                        ? h("div", {
                            class: `gpt-tool gpt-tool--${block.is_error ? "error" : "done"}`,
                            text: block.summary || block.label,
                          })
                        : null,
                ),
              ),
            )
      view.replaceChildren(
        h(
          "div",
          { class: "dash-toolbar" },
          back(`← ${login}'s conversations`, () => chats(login).catch(fail)),
        ),
        h("h2", { text: conversation.title }),
        h("p", {
          class: "muted",
          text: [
            conversation.owner,
            conversation.project,
            conversation.model,
            `started ${formatWhen(conversation.created_at)}`,
          ]
            .filter(Boolean)
            .join(" · "),
        }),
        h(
          "div",
          { class: "gpt-thread admin-transcript" },
          data.turns.length
            ? data.turns.map(turn)
            : h("p", { class: "dash-empty", text: "No messages." }),
        ),
      )
    }

    const query = new URLSearchParams(location.search)
    const login = query.get("member")
    const id = query.get("c")
    if (login && id) await transcript(login, id)
    else if (login) await chats(login)
    else await members()
  }

  show(tab)
}
