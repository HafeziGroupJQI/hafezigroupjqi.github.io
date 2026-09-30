// /admin: the group-admin console. Audit log (who signed in when, what they did), the admin
// allow-list (org owners are always admins), members' claims of People pages, members' upload
// drafts, Hafezi GPT usage + monthly budgets, members' Hafezi GPT conversations, and members' code
// (their live sessions, IPython and terminal history and file history; every view is audited).
// The Worker enforces admin access on every /api/admin/* call; this page just shows a notice to
// non-admins.
import { h, present } from "../dashboard/dom.js"
import {
  ACTION_GROUPS,
  CODE_VIEWS,
  auditParams,
  budgetUsed,
  codeQuery,
  describe,
  diffLines,
  formatTokens,
  formatUsd,
  formatWhen,
  nextTab,
  parseBudget,
  sessionRuns,
  tabUrl,
  uploadsWaiting,
  USAGE_SOURCES,
  usageByDay,
} from "./model.js"
import { changeLabel, draftName, settleLabel, statusLabel } from "../uploads/model.js"

const TABS = [
  ["audit", "Audit log"],
  ["admins", "Admins"],
  ["claims", "Profile claims"],
  ["uploads", "Uploads"],
  ["usage", "Usage & budgets"],
  ["conversations", "Conversations"],
  ["code", "Code"],
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
      text: "Sign-ins, member activity, admins, People page claims, uploads, Hafezi GPT usage and members' code",
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
  // So do conflicts between members' edits of a page (worker/src/edit/conflicts.ts).
  const openConflicts = () =>
    api("/api/edit/conflicts?role=all")
      .then((data) => data.conflicts)
      .catch(() => [])
  const countUploads = (drafts, conflicts) => {
    const n = uploadsWaiting(drafts, conflicts)
    uploadsButton.textContent = n ? `Uploads (${n})` : "Uploads"
  }
  Promise.all([api("/api/admin/uploads"), openConflicts()])
    .then(([data, conflicts]) => countUploads(data.drafts, conflicts))
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

  // Deep links of the member views (Conversations, Code): the keys given are set or, when empty,
  // dropped; the others stay.
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
      code: codeTab,
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
        " GitHub organization are always admins. Admins can see the audit log, members' Hafezi GPT conversations and members' code (their sessions and history, each view recorded in the audit log), add or remove admins, and set Hafezi GPT budgets.",
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
    const [data, conflicts] = await Promise.all([api("/api/admin/uploads"), openConflicts()])
    countUploads(data.drafts, conflicts)
    // Conflicts first: each waits for an admin or its first editor to settle it.
    if (conflicts.length)
      panel.append(
        h("h2", { text: `Conflicts (${conflicts.length})` }),
        h("p", {
          class: "muted",
          text: "Two members changed the same lines of a page. The second change waits until its first editor or an admin settles it; an admin who sent the second change can't settle it.",
        }),
        h(
          "ul",
          { class: "admin-list" },
          conflicts.map((conflict) =>
            h(
              "li",
              { class: "cmd-card audit-admin" },
              h(
                "header",
                {},
                h("strong", { text: settleLabel(conflict) }),
                h("span", { class: "spacer" }),
                conflict.can_settle
                  ? h("a", {
                      class: "btn",
                      href: `/edit?${new URLSearchParams({ conflict: conflict.id })}`,
                      text: "Settle it",
                    })
                  : h("span", { class: "muted", text: "Yours: another admin settles it" }),
              ),
            ),
          ),
        ),
        h("h2", { text: "Drafts" }),
      )
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

  // ---- members' code: live sessions, IPython and terminal history, file history ----
  // Read-only, from the compute host; the Worker records every read in the audit log.
  async function codeTab(panel) {
    const view = h("div", { class: "admin-code" })
    panel.append(
      h(
        "p",
        { class: "code-notice", role: "note" },
        "Read-only. Every view here is recorded in the audit log (",
        h("code", { text: "admin.compute.*" }),
        ") with your login, the member and the time.",
      ),
      view,
    )
    // Deep links: ?tab=code&member=<login>&view=<live|ipython|bash|files>&commit=<sha>.
    const when = (iso) => (iso ? formatWhen(Date.parse(iso)) : "—")
    const loading = () => h("p", { class: "muted", text: "Loading…" })

    async function members() {
      setQuery({ member: null, view: null, commit: null })
      const data = await api("/api/admin/compute/members")
      view.replaceChildren(
        ...present(
          data.access
            ? null
            : h("p", {
                class: "dash-error",
                text: "Reading members' code is off: COMPUTE_OWNER_ACCESS isn't on in the Worker.",
              }),
          data.members.length
            ? table(
                ["Member", "Last started a server", "Last signed in"],
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
                        onclick: () => member(m.login).catch(fail),
                      }),
                    ),
                    h("td", { text: m.last_start ? formatWhen(m.last_start) : "—" }),
                    h("td", { text: m.last_login ? formatWhen(m.last_login) : "—" }),
                  ),
                ),
              )
            : h("p", { class: "dash-empty", text: "No one has signed in yet." }),
        ),
      )
    }

    async function member(login, which = "live", commit = null) {
      setQuery({ member: login, view: which, commit })
      const body = h("div", { class: "code-body", "aria-live": "polite" }, loading())
      view.replaceChildren(
        h(
          "div",
          { class: "dash-toolbar" },
          back("← All members", () => members().catch(fail)),
          h("h2", { class: "mono", text: login }),
          h(
            "div",
            { class: "seg", role: "radiogroup", "aria-label": `What of ${login}'s to show` },
            CODE_VIEWS.map(([id, label]) =>
              h("button", {
                type: "button",
                role: "radio",
                "aria-checked": String(id === which),
                text: label,
                onclick: () => member(login, id).catch(fail),
              }),
            ),
          ),
          h("a", {
            href: `?tab=conversations&member=${encodeURIComponent(login)}`,
            text: "Hafezi GPT conversations →",
            onclick: (event) => {
              event.preventDefault()
              show("conversations")
            },
          }),
        ),
        body,
      )
      const views = { live: liveView, ipython: ipythonView, bash: bashView, files: filesView }
      try {
        await views[which](login, body, commit)
      } catch (error) {
        body.replaceChildren(h("p", { class: "dash-empty", text: error.message }))
      }
    }

    /** A history view's frame: a since filter, the list, and Show older (the page's `next`). */
    function historyFrame(body, load) {
      const form = h(
        "form",
        { class: "dash-toolbar admin-filters" },
        h("label", { class: "dash-field" }, "Since", h("input", { name: "since", type: "date" })),
        h("button", { type: "submit", text: "Show" }),
      )
      const list = h("div", { class: "code-history" })
      const more = h("button", { type: "button", hidden: true, text: "Show older" })
      form.onsubmit = (event) => {
        event.preventDefault()
        load(true).catch(fail)
      }
      more.onclick = () => load(false).catch(fail)
      body.replaceChildren(form, list, more)
      return { list, more, since: () => form.elements.namedItem("since").value }
    }

    async function liveView(login, body) {
      const data = await api(`/api/admin/compute/sessions?${codeQuery(login)}`)
      const state =
        data.server === "pending"
          ? data.pending === "stop"
            ? "stopping"
            : "starting"
          : data.server
      const facts = [
        data.profile && `profile ${data.profile}`,
        data.status?.started && `started ${when(data.status.started)}`,
        data.status?.last_activity && `last active ${when(data.status.last_activity)}`,
      ].filter(Boolean)
      body.replaceChildren(
        h(
          "div",
          { class: "dash-toolbar" },
          h("span", {
            class: `status status-${state === "running" ? "running" : state === "stopped" ? "stopped" : "pending"}`,
            text: state,
          }),
          h("span", { class: "muted", text: facts.join(" · ") }),
          h("button", {
            type: "button",
            text: "Refresh",
            onclick: () => liveView(login, body).catch(fail),
          }),
        ),
      )
      if (data.server !== "running") {
        body.append(
          h("p", {
            class: "dash-empty",
            text: `${login}'s server is ${state}, so nothing is running. Their IPython, terminal and file history still show.`,
          }),
        )
        return
      }
      const none = (text) => h("p", { class: "muted", text })
      if (data.truncated)
        body.append(none("Only part of these lists is shown: they're too long to send whole."))
      body.append(
        h("h3", { text: "Notebooks and consoles" }),
        data.sessions.length
          ? table(
              ["Path", "Type", "Kernel", "State", "Last activity"],
              data.sessions.map((s) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "mono", text: s.path ?? "—" }),
                  h("td", { text: s.type ?? "—" }),
                  h("td", { class: "mono", text: s.kernel?.name ?? "—" }),
                  h("td", { text: s.kernel?.execution_state ?? "—" }),
                  h("td", { text: when(s.kernel?.last_activity) }),
                ),
              ),
            )
          : none("None open."),
        h("h3", { text: "Kernels" }),
        data.kernels.length
          ? table(
              ["Kernel", "Id", "State", "Connections", "Last activity"],
              data.kernels.map((k) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "mono", text: k.name ?? "—" }),
                  h("td", { class: "mono", text: (k.id ?? "").slice(0, 8) }),
                  h("td", { text: k.execution_state ?? "—" }),
                  h("td", { text: String(k.connections ?? "—") }),
                  h("td", { text: when(k.last_activity) }),
                ),
              ),
            )
          : none("No kernels running."),
        h("h3", { text: "Terminals" }),
        data.terminals.length
          ? table(
              ["Terminal", "Last activity"],
              data.terminals.map((t) =>
                h(
                  "tr",
                  {},
                  h("td", { class: "mono", text: t.name ?? "—" }),
                  h("td", { text: when(t.last_activity) }),
                ),
              ),
            )
          : none("No terminals open."),
      )
    }

    async function ipythonView(login, body) {
      let before = null
      let last = null // the last session shown, so a run split across pages stays one
      const frame = historyFrame(body, load)
      async function load(reset) {
        if (reset) {
          before = last = null
          frame.list.replaceChildren(loading())
        }
        const page = await api(
          `/api/admin/compute/ipython?${codeQuery(login, { since: frame.since(), before, limit: 200 })}`,
        )
        if (reset) frame.list.replaceChildren()
        if (reset && !page.entries.length)
          frame.list.append(
            h("p", {
              class: "dash-empty",
              text: page.missing ? `${login} has no IPython history yet.` : "No inputs since then.",
            }),
          )
        for (const run of sessionRuns(page.entries)) {
          const inputs = run.entries.map((entry) =>
            h(
              "li",
              { class: "code-entry" },
              h("span", { class: "code-gutter mono", text: `In [${entry.line}]` }),
              h(
                "div",
                {},
                h("pre", { class: "code-block" }, h("code", { text: entry.source })),
                entry.truncated ? h("span", { class: "muted", text: "(cut short)" }) : null,
              ),
            ),
          )
          if (last?.session === run.session) last.list.append(...inputs)
          else {
            const list = h("ol", { class: "code-entries" }, inputs)
            frame.list.append(
              h(
                "section",
                { class: "code-session" },
                h(
                  "h3",
                  {},
                  `Session ${run.session}`,
                  h("span", {
                    class: "muted",
                    text: run.at ? ` · started ${formatWhen(run.at * 1000)}` : "",
                  }),
                ),
                list,
              ),
            )
            last = { session: run.session, list }
          }
        }
        before = page.next
        frame.more.hidden = before == null
      }
      await load(true)
    }

    async function bashView(login, body) {
      let before = null
      const frame = historyFrame(body, load)
      body.insertBefore(
        h("p", {
          class: "muted",
          text: "A terminal's commands show as it runs them, with their times; a shell started before the compute host was updated for this adds its commands only when it exits, without times.",
        }),
        frame.list,
      )
      const commands = h("ol", { class: "code-entries" })
      async function load(reset) {
        if (reset) {
          before = null
          frame.list.replaceChildren(loading())
        }
        const page = await api(
          `/api/admin/compute/bash?${codeQuery(login, { since: frame.since(), before, limit: 200 })}`,
        )
        if (reset) {
          commands.replaceChildren()
          frame.list.replaceChildren(
            page.entries.length
              ? commands
              : h("p", {
                  class: "dash-empty",
                  text: page.missing
                    ? `${login} has no terminal history yet.`
                    : "No commands since then.",
                }),
          )
        }
        for (const entry of page.entries)
          commands.append(
            h(
              "li",
              { class: "code-entry" },
              h("time", {
                class: "code-gutter mono",
                text: entry.at ? formatWhen(entry.at * 1000) : "—",
              }),
              h(
                "div",
                {},
                h("pre", { class: "code-block" }, h("code", { text: entry.command })),
                entry.truncated ? h("span", { class: "muted", text: "(cut short)" }) : null,
              ),
            ),
          )
        before = page.next
        frame.more.hidden = before == null
      }
      await load(true)
    }

    async function filesView(login, body, commit) {
      if (commit) return diffView(login, body, commit)
      let offset = 0
      const frame = historyFrame(body, load)
      const commits = h("ol", { class: "activity-list" })
      async function load(reset) {
        if (reset) {
          offset = 0
          frame.list.replaceChildren(loading())
        }
        const page = await api(
          `/api/admin/compute/files?${codeQuery(login, { since: frame.since(), offset, limit: 50 })}`,
        )
        if (reset) {
          commits.replaceChildren()
          frame.list.replaceChildren(
            page.commits.length
              ? commits
              : h("p", { class: "dash-empty", text: `No saved versions of ${login}'s files.` }),
          )
        }
        for (const c of page.commits)
          commits.append(
            h(
              "li",
              { class: "cmd-card" },
              h(
                "header",
                {},
                h("time", { class: "mono muted", text: formatWhen(c.time * 1000) }),
                h("button", {
                  type: "button",
                  class: "link",
                  text: c.subject,
                  onclick: () => diffView(login, body, c.rev).catch(fail),
                }),
                h("span", { class: "muted", text: c.author }),
              ),
              h(
                "ul",
                { class: "code-files mono" },
                c.files.map((f) => h("li", { text: `${f.status}  ${f.path}` })),
                c.more_files ? h("li", { class: "muted", text: `and ${c.more_files} more` }) : null,
              ),
            ),
          )
        offset = page.next ?? offset
        frame.more.hidden = page.next == null
      }
      await load(true)
    }

    async function diffView(login, body, rev) {
      setQuery({ commit: rev })
      body.replaceChildren(loading())
      const data = await api(
        `/api/admin/compute/files/${encodeURIComponent(rev)}?${codeQuery(login)}`,
      )
      body.replaceChildren(
        h(
          "div",
          { class: "dash-toolbar" },
          back("← All saved versions", () => {
            setQuery({ commit: null })
            filesView(login, body).catch(fail)
          }),
          h("strong", { text: data.subject }),
          h("span", {
            class: "muted",
            text: `${data.author} · ${formatWhen(data.time * 1000)} · ${data.rev.slice(0, 10)}`,
          }),
        ),
        h(
          "pre",
          { class: "code-block diff" },
          diffLines(data.diff).map((line) =>
            h("span", { class: `diff-${line.kind}`, text: line.text }),
          ),
        ),
        ...present(
          data.truncated ? h("p", { class: "muted", text: "The diff is cut short here." }) : null,
        ),
      )
    }

    const query = new URLSearchParams(location.search)
    const login = query.get("member")
    const which = CODE_VIEWS.some(([id]) => id === query.get("view")) ? query.get("view") : "live"
    const commit = /^[0-9a-f]{7,40}$/.test(query.get("commit") ?? "") ? query.get("commit") : null
    if (login) await member(login, which, which === "files" ? commit : null)
    else await members()
  }

  show(tab)
}
