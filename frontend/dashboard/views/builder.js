// Builder tab: the experiment builder form (moved from member-tools.js). buildSpec() is pure.
import { h } from "../dom.js"
import { devicePicker } from "./common.js"

export function familyForDriver(catalog, driver) {
  if (!driver) return null
  const map = { keithley_2450: "Keithley2450", zurich_mfli: "ZurichMFLI" }
  if (map[driver]) return map[driver]
  const hit = catalog.find((c) => c.family.toLowerCase().includes(driver.replace(/_/g, "")))
  return hit ? hit.family : null
}

/** Form values → the Setup.json spec POSTed to /api/devices/:code/experiments. */
export function buildSpec(values, catalog) {
  const selected = values.instruments.map((i) => ({
    device: values.device,
    local_id: i.local_id,
    family: i.family ?? familyForDriver(catalog, i.driver),
    ports: [],
  }))
  if (!selected.length) throw new Error("Select at least one instrument.")
  const dut = values.dut.split(",").map((s) => s.trim()).filter(Boolean)
  const netlist = values.netlist
    .split("\n")
    .map((line) => line.split(/->|→/).map((s) => s.trim()))
    .filter((pair) => pair.length === 2 && pair[0] && pair[1])
    .map(([from, to]) => ({ from, to }))
  return {
    experiment_label: values.label.trim() || "experiment",
    experiment_prompt: values.prompt.trim() || "measure",
    selected_instruments: selected,
    duts: dut.length ? [{ name: "dut1", ports: dut }] : [],
    netlist,
    points: Number(values.points) || 101,
  }
}

export function mountBuilder(panel, ctx, route) {
  const picker = devicePicker(ctx, route)
  const form = h("form", { class: "builder" })
  const notice = h("p", { role: "status", class: "muted" })
  panel.append(h("div", { class: "dash-section-head" }, h("h2", { text: "Experiment builder" }), h("span", { class: "spacer" }), picker.element), form, notice)
  if (!route.code) {
    form.append(h("p", { class: "muted", text: "Pick the device whose instruments the experiment will use." }))
    return { update: picker.fill }
  }
  const code = route.code
  // Static template only; every dynamic value goes through h()/textContent.
  form.innerHTML = `
    <fieldset><legend>Instruments on <code></code></legend><div class="checkbox-list" data-picker><p class="muted">Loading…</p></div></fieldset>
    <label>Experiment label<input name="label" value="iv-sweep" maxlength="64"></label>
    <label>DUT ports (comma-separated, optional)<input name="dut" placeholder="a, b"></label>
    <label>Netlist (one per line, from -&gt; to)<textarea name="netlist" rows="3" placeholder="keithley-2450-1.force_hi -> dut1.a"></textarea></label>
    <label>Points<input name="points" type="number" value="101" min="1" max="100000"></label>
    <label>Experiment prompt<textarea name="prompt" rows="4">Sweep the source and measure the response.</textarea></label>
    <p role="alert"></p>
    <div class="editor-actions"><button type="submit" class="primary">Generate &amp; run</button></div>`
  form.querySelector("legend code").textContent = code
  const list = form.querySelector("[data-picker]")
  const alert = form.querySelector('[role="alert"]')
  let catalog = []
  Promise.all([ctx.api("/api/catalog").catch(() => []), ctx.api(`/api/devices/${encodeURIComponent(code)}/instruments`)])
    .then(([cat, instruments]) => {
      catalog = cat
      list.replaceChildren()
      if (!instruments.length) return list.append(h("p", { class: "muted", text: "No instruments on this device." }))
      for (const inst of instruments)
        list.append(h("label", { class: "check-row" },
          h("input", { type: "checkbox", value: inst.local_id, "data-driver": inst.driver || "" }),
          h("span", { text: `${inst.title || inst.local_id} (${inst.ports?.length || 0} ports)` })))
    })
    .catch((error) => list.replaceChildren(h("p", { role: "alert", text: error.message })))

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    alert.textContent = ""
    const field = (n) => form.elements.namedItem(n).value
    let spec
    try {
      spec = buildSpec({
        device: code,
        instruments: [...list.querySelectorAll("input:checked")].map((b) => ({ local_id: b.value, driver: b.dataset.driver })),
        label: field("label"), dut: field("dut"), netlist: field("netlist"), points: field("points"), prompt: field("prompt"),
      }, catalog)
    } catch (error) {
      alert.textContent = error.message
      return
    }
    const button = form.querySelector("button[type=submit]")
    button.disabled = true
    notice.textContent = "Generating the control script…"
    try {
      const result = await ctx.api(`/api/devices/${encodeURIComponent(code)}/experiments`, { method: "POST", body: JSON.stringify(spec) })
      notice.textContent = ""
      ctx.navigate({ tab: "experiments", code, focus: result.experiment_id })
    } catch (error) {
      notice.textContent = ""
      alert.textContent = error.message
    } finally {
      button.disabled = false
    }
  })
  return { update: picker.fill, streamCode: () => null }
}
