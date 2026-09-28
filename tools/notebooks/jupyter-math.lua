-- Jupyter writes math in Markdown cells the way MathJax reads it: $…$, $$…$$, \(…\), \[…\], and
-- bare LaTeX math environments (\begin{align}…\end{align}). render-notebooks.mjs reads the first
-- four with Pandoc's tex_math_dollars and tex_math_single_backslash; Pandoc reads an environment as
-- raw TeX, which Markdown output drops. This keeps those environments as display math.
local environments = {
  equation = true, align = true, alignat = true, aligned = true, gather = true, gathered = true,
  multline = true, flalign = true, eqnarray = true, split = true, math = true, displaymath = true,
}

local function math(raw)
  if raw.format ~= "tex" and raw.format ~= "latex" then return nil end
  local name = raw.text:match("^%s*\\begin{(%a+)%*?}")
  if name and environments[name] then return pandoc.Math("DisplayMath", raw.text) end
end

function RawInline(raw)
  return math(raw)
end

function RawBlock(raw)
  local display = math(raw)
  if display then return pandoc.Para({ display }) end
end
