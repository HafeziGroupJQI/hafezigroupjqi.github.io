import { describe, expect, it } from "vitest"
import {
  cleanCompletion,
  completionContext,
  looksLikeProse,
  postProcessSuggestion,
} from "../src/gpt/completion"

// Ghost text's answers: jupyter-ai's post-processing (ported), then the prose guard.

const fence = "```"
/** hafezi-lab's completer: jupyter-ai's COMPLETION_DEFAULT_TEMPLATE, filled in. */
function template(prefix: string, { language = "python", suffix = "", history = "" } = {}) {
  let text = `The document is called \`Console 1\` and written in ${language}.\n`
  text += "The kernel is ENEE graduate courses.\n"
  if (history) text += `\nThe console's earlier inputs:\n\n${fence}\n${history}\n${fence}\n`
  if (suffix)
    text += `\nThe code after the completion request is:\n\n${fence}\n${suffix}\n${fence}\n`
  return `${text}\nComplete the following code:\n\n${fence}\n${prefix}`
}
const asked = (text: string) => [{ role: "user", content: [{ type: "text", text }] }]

describe("what a completion is for", () => {
  it("reads the language and the code before the cursor from jupyter-ai's template", () => {
    const history = `import numpy as np\n${fence}python\nnot the prefix\n${fence}`
    expect(completionContext(asked(template("psi = ", { history, suffix: "print(psi)" })))).toEqual(
      { language: "python", prefix: "psi = ", guard: true },
    )
    expect(completionContext(asked(template("", { language: "wolfram language 14.3" })))).toEqual({
      language: "wolfram language 14.3",
      prefix: "",
      guard: true,
    })
  })

  it("reads jupyterlite-ai's notebook prompt, and its console's bare prefix", () => {
    const notebook =
      "# Code before cursor:\n\n# Cell 1:\nimport numpy as np\n\n# Current cell:\nx = np.\n\n" +
      "# Complete the code at cursor position\n\n# Code after cursor:\n\nprint(x)\n\n"
    expect(completionContext(asked(notebook))).toEqual({ prefix: "x = np.", guard: true })
    expect(completionContext([{ role: "user", content: "psi =" }])).toEqual({
      prefix: "psi =",
      guard: true,
    })
  })

  it("expects words, not code, in Markdown, a comment, a string or a docstring", () => {
    const guard = (prefix: string, language?: string) =>
      completionContext(asked(template(prefix, { language }))).guard
    expect(guard("psi = ")).toBe(true)
    expect(guard("# The ", "markdown")).toBe(false)
    expect(guard("x = 1  # the ground state ")).toBe(false)
    expect(guard('title = "Energy of the ')).toBe(false)
    expect(guard("def f():\n    '''Return the ")).toBe(false)
    expect(guard('print("done")\nx = ')).toBe(true)
  })
})

describe("jupyter-ai's post_process_suggestion", () => {
  it("strips a fence and the prefix it restates", () => {
    const prefix = "import numpy as np\nx = np."
    expect(postProcessSuggestion("```python\nx = 1\n```", { prefix: "" })).toBe("x = 1")
    expect(
      postProcessSuggestion(`  ${fence}python\n${prefix}linspace(0, 1)\n${fence}`, { prefix }),
    ).toBe("linspace(0, 1)")
    expect(postProcessSuggestion("```py\nfoo()```", { language: "ipython", prefix: "" })).toBe(
      "foo()",
    )
    // Without a fence, a restated prefix is left (cleanCompletion takes it off).
    expect(postProcessSuggestion("x + 1", { prefix: "y = " })).toBe("x + 1")
  })

  it("drops the tag of a fence in another language", () => {
    expect(
      postProcessSuggestion("```wolfram\nPlot[Sin[x], {x, 0, Pi}]\n```", {
        language: "wolfram language",
        prefix: "",
      }),
    ).toBe("Plot[Sin[x], {x, 0, Pi}]")
    expect(postProcessSuggestion("```\nfoo\nbar\n```", { prefix: "" })).toBe("foo\nbar")
  })
})

describe("the prose guard", () => {
  it("knows an answer that talks to the member", () => {
    for (const prose of [
      "I need more context to complete this code fragment. Could you tell me:\n1. What programming language this is?",
      "Could you provide more context?",
      "What programming language is this?",
      "Sure! Here's the completion:",
      "It looks like you're defining a wavefunction.",
      "Without more context, I can only guess.",
      "1. What programming language this is?",
      "This computes the norm of the vector.",
      "(no completion)",
      // Seen live in an empty console prompt after a cell ran: a sentence, then more of them.
      "This code has already been executed. If you want to run it again or modify it, you could continue with something like:",
      "This cell was already run, so",
    ])
      expect(looksLikeProse(prose), prose).toBe(true)
  })

  it("never takes code for prose, even code that starts with a word or a comment", () => {
    for (const code of [
      "import numpy as np",
      "# Compute the eigenvalues\nw, v = np.linalg.eigh(H)",
      "return psi / np.linalg.norm(psi)",
      "print('I need more context')",
      "I = np.eye(3)",
      "Hello()",
      "Note: int = 5",
      "let me = 1",
      "Plot[Sin[x], {x, 0, 2 Pi}]",
      "None",
      "for i in range(10):",
      "SELECT name FROM users WHERE id = 1",
      "x = 1.5; y = x ** 2",
      "Print[Integrate[Exp[-x^2], {x, -Infinity, Infinity}]]",
      "",
    ])
      expect(looksLikeProse(code), code).toBe(false)
  })
})

describe("a completion's text as it goes back", () => {
  const psi = completionContext(asked(template("psi = ")))

  it("is nothing for prose, and the code alone otherwise", () => {
    expect(cleanCompletion("I need more context to complete this code fragment…", psi)).toBe("")
    expect(cleanCompletion("```python\npsi = np.sqrt(2)\n```", psi)).toBe("np.sqrt(2)")
    expect(cleanCompletion("1 / np.sqrt(2)", psi)).toBe("1 / np.sqrt(2)")
    // The current line restated without a fence, and a paragraph about the code after it.
    expect(cleanCompletion("psi = 1 / np.sqrt(2)\n\nThis normalises the state.", psi)).toBe(
      "1 / np.sqrt(2)",
    )
    const bare = completionContext([{ role: "user", content: "psi =" }])
    expect(cleanCompletion("What programming language is this?", bare)).toBe("")
    expect(cleanCompletion("psi = 1 / np.sqrt(2)", bare)).toBe(" 1 / np.sqrt(2)")
  })

  it("keeps words where words belong", () => {
    const comment = completionContext(asked(template("x = 1  # ")))
    expect(cleanCompletion("This is the ground state.", comment)).toBe("This is the ground state.")
    const markdown = completionContext(asked(template("", { language: "markdown" })))
    expect(cleanCompletion("It looks like a resonance.", markdown)).toBe(
      "It looks like a resonance.",
    )
  })
})
