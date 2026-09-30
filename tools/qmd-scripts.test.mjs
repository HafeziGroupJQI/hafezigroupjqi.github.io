import assert from "node:assert/strict"
import test from "node:test"
import { hoistScripts, isAmdScript } from "./qmd-scripts.mjs"

// What Quarto froze for vault-private's code/bend-optimization.qmd (a widget output, since gone).
const REQUIRE =
  '<script src="https://cdn.jsdelivr.net/npm/requirejs@2.3.6/require.min.js" integrity="sha384-c9c+LnTbwQ3aujuU7ULEPVvgLs+Fn6fJUvIGTsuu1ZcCf11fiEubah0ttpca4ntM" crossorigin="anonymous"></script>'
const JQUERY =
  '<script src="https://cdn.jsdelivr.net/npm/jquery@3.5.1/dist/jquery.min.js" integrity="sha384-ZvpUoO/+PpLXR1lu4jmpXWu80pZlYUAfxl5NsBMWOEPSjUn/6Z/hRTt8+pR6L4N2" crossorigin="anonymous" data-relocate-top="true"></script>'
const SHIM =
  "<script type=\"application/javascript\">define('jquery', [],function() {return window.jQuery;})</script>"
const FROZEN = `${REQUIRE}\n${JQUERY}\n${SHIM}\n`
const PLOTLY = '<script src="https://cdn.plot.ly/plotly-2.35.2.min.js" charset="utf-8"></script>'
const BODY = "## What it is\n\nA bend optimizer.\n"

test("quarto's requirejs, jquery and define('jquery') shim stay off a page that doesn't use them", () => {
  assert.equal(hoistScripts(FROZEN, BODY), BODY)
  assert.equal(hoistScripts([FROZEN], BODY), BODY)
  for (const tag of [REQUIRE, JQUERY, SHIM]) assert.ok(isAmdScript(tag), tag)
  assert.ok(isAmdScript('<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>'))
  assert.ok(
    isAmdScript(
      '<script src="https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js?x=1"></script>',
    ),
  )
  assert.ok(!isAmdScript(PLOTLY))
  assert.ok(!isAmdScript("<script>window.PlotlyConfig = {MathJaxConfig: 'local'};</script>"))
})

test("they stay when the page loads modules through amd", () => {
  const body =
    '<div id="w"></div>\n<script>require(["plotly"], (Plotly) => Plotly.newPlot("w"))</script>\n'
  assert.equal(hoistScripts(FROZEN, body), FROZEN + "\n\n" + body)
  const widget = 'Output: <script type="application/vnd.jupyter.widget-view+json">{}</script>\n'
  assert.ok(hoistScripts(FROZEN, widget).startsWith(REQUIRE))
  // Or when another of the page's scripts does.
  const other = `<script>define(["d3"], (d3) => d3)</script>`
  assert.equal(hoistScripts([FROZEN, other], BODY), `${FROZEN}\n${other}\n\n${BODY}`)
})

test("other scripts, plotly's and htmlwidgets', are moved into the body as before", () => {
  const config = "<script>window.PlotlyConfig = {MathJaxConfig: 'local'};</script>"
  assert.equal(hoistScripts([config, PLOTLY], BODY), `${config}\n${PLOTLY}\n\n${BODY}`)
  // Next to quarto's loaders, only the loaders go; a stylesheet in the same include stays with it.
  const widgets = `${REQUIRE}\n<link href="lib/widget.css" rel="stylesheet" />\n${PLOTLY}\n`
  assert.equal(
    hoistScripts(widgets, BODY),
    `<link href="lib/widget.css" rel="stylesheet" />\n${PLOTLY}\n\n\n${BODY}`,
  )
  // Includes without a script are not moved, and a page without includes keeps its body.
  assert.equal(hoistScripts(["\\usepackage{amsmath}", 3, null], BODY), BODY)
  assert.equal(hoistScripts(undefined, BODY), BODY)
})
