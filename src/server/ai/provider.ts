/*
  Model access for the AI endpoint (#212).

  One interface, one implementation. The interface exists so the runtime
  decision in docs/AI-ARCHITECTURE.md §5.1 stays reversible — swapping Workers
  AI for an HTTP provider means writing a second `complete()` and nothing else —
  not because several providers are expected to coexist.

  Workers AI is reached through a platform-authenticated binding (`env.AI`), so
  there is no credential in this file, in the repo, or in any environment
  variable. That is most of why it was chosen; see §4.4.
*/

/** Which class of model a call needs. Never a model id at the call site. */
export type Tier = 'cheap' | 'reasoning'

/**
 * Tier → model. Kept in one place so a model change is one edit, and so call
 * sites have to say *why* they want a tier rather than picking a name.
 *
 * `cheap` handles extraction: measured against a French forwarded hotel
 * confirmation with year-less dates, a model of this class returned every field
 * correctly (§4.4). `reasoning` exists for #213 and is not yet used.
 */
export const MODELS: Record<Tier, string> = {
  cheap: '@cf/meta/llama-3.1-8b-instruct-fp8',
  reasoning: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
}

export interface CompleteArgs {
  system: string
  user: string
  /** JSON Schema the model must satisfy. Not a prompt instruction — a constraint. */
  schema: Record<string, unknown>
  /** Bounded in code, not only in the schema: output is the expensive side. */
  maxOutputTokens: number
  tier: Tier
}

export interface CompleteResult {
  /** Whatever the model returned, still untrusted — the caller validates it. */
  json: unknown
  inputTokens: number
  outputTokens: number
}

export interface ModelProvider {
  complete(args: CompleteArgs): Promise<CompleteResult>
}

/** The shape of the Workers AI binding this module uses. */
export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

/**
 * Workers AI, via the `env.AI` binding.
 *
 * Uses JSON mode (`response_format` with a `json_schema`), which is
 * OpenAI-compatible — the model is constrained to the schema rather than asked
 * politely to follow it. That removes the largest failure class in a
 * propose-then-approve design; what it does not remove — a well-formed object
 * that is semantically wrong — is caught by zod and then by the user reviewing
 * the form.
 */
export function workersAiProvider(ai: AiBinding): ModelProvider {
  return {
    async complete({ system, user, schema, maxOutputTokens, tier }: CompleteArgs) {
      const raw = (await ai.run(MODELS[tier], {
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: schema },
        max_tokens: maxOutputTokens,
      })) as {
        // Workers AI returns the parsed object under `response` when JSON mode
        // is used, and the raw text under choices[].message.content. Prefer the
        // parsed form; fall back to parsing the text ourselves.
        response?: unknown
        choices?: { message?: { content?: string } }[]
        usage?: { prompt_tokens?: number; completion_tokens?: number }
      }

      let json: unknown = raw?.response
      if (json === undefined) {
        const text = raw?.choices?.[0]?.message?.content
        try {
          json = typeof text === 'string' ? JSON.parse(text) : undefined
        } catch {
          // Leave undefined — an unparseable body is a failed call, and the
          // caller degrades rather than guessing at what was meant.
          json = undefined
        }
      }

      return {
        json,
        inputTokens: raw?.usage?.prompt_tokens ?? 0,
        outputTokens: raw?.usage?.completion_tokens ?? 0,
      }
    },
  }
}
