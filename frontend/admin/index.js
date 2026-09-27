// /admin: the group-admin console. Audit log (who signed in when, what they did), the admin
// allow-list (org owners are always admins), and Hafezi GPT usage + monthly budgets. The Worker
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
  parseBudget,
} from "./model.js"

const TABS = [
  ["audit", "Audit log"],
  ["admins", "Admins"],
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
      text: "Sign-ins, member activity, admins and Hafezi GPT usage",
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

  const fail = (error) => {
    banner.hidden = false
    banner.textContent = error.message
  }

  function show(id) {
    tab = id
    banner.hidden = true
    for (const button of tabs.children)
      button.setAttribute("aria-selected", String(button.dataset.tab === id))
    const url = new URL(location.href)
    url.searchParams.set("tab", id)
    history.replaceState(history.state, "", url)
    panel.replaceChildren()
    ;({ audit: auditTab, admins: adminsTab, usage: usageTab, conversations: conversationsTab })
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
        " GitHub organization are always admins. Admins can see the audit log, add or remove admins, and set Hafezi GPT budgets. Chat contents are never visible here.",
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

  // ---- usage & budgets ----
  async function usageTab(panel) {
    const month = h("input", { type: "month", value: new Date().toISOString().slice(0, 7) })
    const table = h("table", { class: "bases-table usage-table" })
    panel.append(
      h("div", { class: "dash-toolbar" }, h("label", { class: "dash-field" }, "Month", month)),
      h("p", {
        class: "muted",
        text: "Tokens and estimated cost per member this month. A budget caps a member's input + output tokens per calendar month (UTC); leave it empty for no limit.",
      }),
      h("div", { class: "table-scroll" }, table),
    )
    async function load() {
      const data = await api(`/api/admin/usage?month=${month.value}`)
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
