import type Anthropic from "@anthropic-ai/sdk"

// The models members can pick. Sonnet 5 is the everyday default; Opus 5.5 is there for hard
// questions. Prices are USD per million tokens (Anthropic first-party rates).

export interface GptModel {
  id: string
  label: string
  blurb: string
  input: number
  output: number
  cacheRead: number
  /** Opus 5.5 defaults to effort "medium"; we ask for "high" when a member picks it. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
}

export const MODELS: GptModel[] = [
  {
    id: "claude-sonnet-5",
    label: "Sonnet 5",
    blurb: "Fast and capable; the default",
    input: 2,
    output: 10,
    cacheRead: 0.2,
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    blurb: "Deepest reasoning; about 2× the cost",
    input: 4,
    output: 20,
    cacheRead: 0.2,
    effort: "high",
  },
]

export const DEFAULT_MODEL = MODELS[0].id

export function model(id: string | null | undefined): GptModel {
  return MODELS.find((m) => m.id === id) ?? MODELS[0]
}

export interface UsageTotals {
  /** Uncached input + cache writes: what counts against a member's budget with output. */
  input: number
  output: number
  cache_read: number
  cache_write: number
  cost_usd: number
}

export const emptyUsage = (): UsageTotals => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  cost_usd: 0,
})

/** Fold one response's usage (top level + compaction iterations, which are billed on top). */
export function addUsage(
  totals: UsageTotals,
  m: GptModel,
  usage: Anthropic.Beta.BetaUsage,
): UsageTotals {
  const parts: Array<{
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number | null
    cache_creation_input_tokens?: number | null
    cache_creation?: Anthropic.Beta.BetaCacheCreation | null
  }> = [usage, ...(usage.iterations ?? []).filter((i) => i.type === "compaction")]
  for (const u of parts) {
    const read = u.cache_read_input_tokens ?? 0
    const write = u.cache_creation_input_tokens ?? 0
    const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const write5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens : write
    totals.input += u.input_tokens + write
    totals.output += u.output_tokens
    totals.cache_read += read
    totals.cache_write += write
    // Cache writes cost 1.25× input for the 5-minute TTL and 2× for the 1-hour TTL.
    totals.cost_usd +=
      (u.input_tokens * m.input +
        write5m * m.input * 1.25 +
        write1h * m.input * 2 +
        read * m.cacheRead +
        u.output_tokens * m.output) /
      1_000_000
  }
  return totals
}
