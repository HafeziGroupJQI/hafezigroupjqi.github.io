// /settings: a member's own settings. Their People page (linked once to their GitHub login, then
// edited by a commit to the public vault: src/profile/ in the Worker), their photo, and the Wolfram
// Engine licence their Wolfram code runs on (activated on the compute host: the Worker's
// /api/compute/wolfram/licence, the host's hafezi_compute/wolfram/licences.py).
import { h } from "../dashboard/dom.js"
import {
  FIELDS,
  avatarFor,
  centreSquare,
  changedFields,
  licenceSummary,
  slugName,
} from "./model.js"

const PHOTO_SIZE = 512
const FREE_ENGINE = "https://account.wolfram.com/access/wolfram-engine/free"

export function mountSettings(root, { api, session }) {
  root.replaceChildren()
  root.classList.add("dashboard", "settings-page")
  root.append(
    h(
      "header",
      { class: "dash-header" },
      h("h1", { class: "dash-title", text: "Settings" }),
      h("p", {
        class: "dash-summary",
        text: `Signed in as ${session.user.login}`,
      }),
    ),
  )
  const profile = h("section", { class: "settings-section", "aria-labelledby": "settings-profile" })
  const wolfram = h("section", { class: "settings-section", "aria-labelledby": "settings-wolfram" })
  root.append(profile, wolfram)
  void showProfile(profile, api)
  void showWolfram(wolfram, api)
}

// Tell the navbar (quartz/components/jqi/navScript.ts) about a new name or photo at once.
function announce(identity) {
  window.dispatchEvent(new CustomEvent("hafezi:identity", { detail: identity }))
}

function notice(kind, text) {
  return h("p", { class: kind === "error" ? "dash-error" : "settings-note", role: "status", text })
}

async function showProfile(section, api) {
  const heading = h("h2", { id: "settings-profile", text: "Your People page" })
  section.replaceChildren(heading, h("p", { class: "muted", text: "Loading…" }))
  let profile
  try {
    profile = await api("/api/profile")
  } catch (error) {
    section.replaceChildren(heading, notice("error", error.message))
    return
  }
  if (!profile.vault_ready) {
    section.replaceChildren(
      heading,
      h("p", { text: "Editing People pages from the site isn't set up yet. Ask an admin." }),
    )
    return
  }
  if (!profile.page) {
    section.replaceChildren(heading, ...claimForm(profile, api, () => showProfile(section, api)))
    return
  }
  section.replaceChildren(heading, ...pageForm(profile, api, () => showProfile(section, api)))
}

function claimForm(profile, api, done) {
  const select = h(
    "select",
    { id: "settings-claim", required: true },
    h("option", { value: "", text: "Choose your page…" }),
    profile.claimable.map((page) =>
      h("option", {
        value: page.path,
        text: slugName(page.slug) + (page.alumni ? " (alumni)" : ""),
      }),
    ),
  )
  const status = h("div", { "aria-live": "polite" })
  const form = h(
    "form",
    {
      class: "settings-form",
      onsubmit: async (event) => {
        event.preventDefault()
        if (!select.value) return
        const button = form.querySelector("button")
        button.disabled = true
        try {
          await api("/api/profile/claim", {
            method: "POST",
            body: JSON.stringify({ path: select.value }),
          })
          done()
        } catch (error) {
          status.replaceChildren(notice("error", error.message))
          button.disabled = false
        }
      },
    },
    h("label", { for: "settings-claim", text: "Your People page" }),
    select,
    h("button", { type: "submit", class: "primary", text: "Link it to my GitHub login" }),
  )
  return [
    h("p", {
      text: `Your GitHub login (${profile.login}) isn't linked to a People page yet. Choose yours: the page gets "github: ${profile.login}" in the vault, and then you can edit it here.`,
    }),
    form,
    status,
    h("p", {
      class: "muted",
      text: "Not listed? Your page may be linked to someone else, or not exist yet. Ask an admin.",
    }),
  ]
}

function pageForm(profile, api, done) {
  const { page } = profile
  const status = h("div", { "aria-live": "polite" })
  const inputs = {}
  const rows = FIELDS.map(([key, label, options]) => {
    inputs[key] = h("input", {
      id: `settings-${key}`,
      name: key,
      type: options.type ?? "text",
      value: page.fields[key] ?? "",
      required: options.required,
      autocomplete: options.autocomplete ?? "off",
      placeholder: options.placeholder,
    })
    return h(
      "div",
      { class: "settings-row" },
      h("label", { for: `settings-${key}`, text: label }),
      inputs[key],
    )
  })
  const save = h("button", { type: "submit", class: "primary", text: "Save" })
  const form = h(
    "form",
    {
      class: "settings-form",
      onsubmit: async (event) => {
        event.preventDefault()
        const values = Object.fromEntries(
          Object.entries(inputs).map(([k, input]) => [k, input.value]),
        )
        const changes = changedFields(page.fields, values)
        if (!Object.keys(changes).length) {
          status.replaceChildren(notice("ok", "Nothing changed."))
          return
        }
        save.disabled = true
        status.replaceChildren(notice("ok", "Saving to the vault…"))
        try {
          await api("/api/profile", { method: "PUT", body: JSON.stringify(changes) })
          Object.assign(
            page.fields,
            Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v ?? null])),
          )
          if (changes.title) announce({ display_name: changes.title })
          status.replaceChildren(
            notice(
              "ok",
              "Saved. Your People page shows it after the next site deploy, in a few minutes.",
            ),
          )
        } catch (error) {
          status.replaceChildren(notice("error", error.message))
        } finally {
          save.disabled = false
        }
      },
    },
    rows,
    h(
      "p",
      { class: "muted" },
      `Role: ${page.role ?? "—"} · Group: ${page.group ?? "—"} (changed by the vault's editors).`,
    ),
    save,
  )
  return [
    h(
      "p",
      {},
      "Linked to ",
      h("a", { href: page.url, text: page.url }),
      ". Changes are committed to the public vault, so everyone can see them on the People page.",
    ),
    photoPicker(profile, api, status),
    form,
    status,
  ]
}

function photoPicker(profile, api, status) {
  const image = h("img", {
    class: "settings-avatar",
    src: avatarFor(profile),
    alt: "Your photo",
    width: 128,
    height: 128,
  })
  const input = h("input", {
    id: "settings-photo",
    type: "file",
    accept: "image/*",
    class: "sr-only",
    onchange: async () => {
      const file = input.files?.[0]
      input.value = ""
      if (!file) return
      status.replaceChildren(notice("ok", "Uploading your photo…"))
      try {
        const jpeg = await squareJpeg(file)
        const saved = await api("/api/profile/photo", {
          method: "PUT",
          headers: { "Content-Type": "image/jpeg" },
          body: jpeg,
        })
        image.src = saved.avatar
        announce({ avatar: saved.avatar })
        status.replaceChildren(
          notice("ok", "Photo saved. The People page shows it after the next site deploy."),
        )
      } catch (error) {
        status.replaceChildren(notice("error", error.message))
      }
    },
  })
  return h(
    "div",
    { class: "settings-photo" },
    image,
    h(
      "div",
      {},
      input,
      h("label", { for: "settings-photo", class: "btn", text: "Change photo" }),
      h("p", { class: "muted", text: "Cropped to a square and resized before upload." }),
    ),
  )
}

/** The picture's centred square as a JPEG of at most PHOTO_SIZE pixels a side. */
async function squareJpeg(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't an image this browser can read.")
  })
  const { sx, sy, size } = centreSquare(bitmap.width, bitmap.height)
  const side = Math.min(size, PHOTO_SIZE)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = side
  const context = canvas.getContext("2d")
  context.fillStyle = "#fff"
  context.fillRect(0, 0, side, side)
  context.drawImage(bitmap, sx, sy, size, size, 0, 0, side, side)
  bitmap.close()
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Could not prepare the photo."))),
      "image/jpeg",
      0.88,
    ),
  )
}

async function showWolfram(section, api) {
  const heading = h("h2", { id: "settings-wolfram", text: "Wolfram Engine licence" })
  const summary = h("p", { text: "Checking…" })
  const status = h("div", { "aria-live": "polite" })
  section.replaceChildren(heading, summary, status)
  let licence
  try {
    licence = await api("/api/compute/wolfram/licence")
  } catch (error) {
    licence = { state: "offline", detail: error.message }
  }
  summary.textContent = licenceSummary(licence)
  if (licence.state === "active") {
    const remove = h("button", {
      type: "button",
      class: "danger",
      text: "Remove my licence from the compute host",
      onclick: async () => {
        if (
          !confirm(
            "Remove your Wolfram Engine licence? Wolfram code won't run until you activate it again.",
          )
        )
          return
        remove.disabled = true
        try {
          await api("/api/compute/wolfram/licence", { method: "DELETE" })
          void showWolfram(section, api)
        } catch (error) {
          status.replaceChildren(notice("error", error.message))
          remove.disabled = false
        }
      },
    })
    section.append(remove)
    return
  }
  if (licence.state === "offline") return
  const id = h("input", {
    id: "wolfram-id",
    type: "email",
    required: true,
    autocomplete: "username",
  })
  const password = h("input", {
    id: "wolfram-password",
    type: "password",
    required: true,
    autocomplete: "current-password",
  })
  const activate = h("button", { type: "submit", class: "primary", text: "Activate" })
  const form = h(
    "form",
    {
      class: "settings-form",
      onsubmit: async (event) => {
        event.preventDefault()
        activate.disabled = true
        status.replaceChildren(
          notice("ok", "Activating on the compute host… this takes up to a minute."),
        )
        try {
          await api("/api/compute/wolfram/licence", {
            method: "POST",
            body: JSON.stringify({ wolfram_id: id.value.trim(), password: password.value }),
          })
          password.value = ""
          void showWolfram(section, api)
        } catch (error) {
          password.value = ""
          status.replaceChildren(notice("error", error.message))
          activate.disabled = false
        }
      },
    },
    h(
      "div",
      { class: "settings-row" },
      h("label", { for: "wolfram-id", text: "Wolfram ID (email)" }),
      id,
    ),
    h(
      "div",
      { class: "settings-row" },
      h("label", { for: "wolfram-password", text: "Password" }),
      password,
    ),
    activate,
  )
  section.append(
    h(
      "ol",
      { class: "settings-steps" },
      h(
        "li",
        {},
        "Sign in to your Wolfram account (or create a free Wolfram ID) at ",
        h("a", {
          href: "https://account.wolfram.com",
          target: "_blank",
          rel: "noopener",
          text: "account.wolfram.com",
        }),
        ".",
      ),
      h(
        "li",
        {},
        "While signed in, open ",
        h("a", {
          href: FREE_ENGINE,
          target: "_blank",
          rel: "noopener",
          text: "the free Wolfram Engine licence page",
        }),
        " and click Get your license. You must be signed in there, or it won't issue the licence.",
      ),
      h(
        "li",
        {},
        "Enter your Wolfram ID and password here. The compute host activates the Wolfram Engine with them once. Your password is used only for that and is never stored: the host keeps only the activation file Wolfram gives it.",
      ),
    ),
    form,
    h("p", {
      class: "muted",
      text: "This is the Free Wolfram Engine for Developers, meant for development rather than production use. Wolfram lets you activate it on a limited number of machines, and the compute host counts as one of them.",
    }),
  )
  section.append(status)
}
