/**
 * @name council
 * @description Ensemble code review: fans the same read-only review out to one reviewer per model (caller-supplied list of models), running them in parallel, then synthesizes all reviews into one report — deduplicating findings, taking the higher severity on conflicts, preserving unique findings, and hiding which model found what.
 */

// --- Schemas (top-level, outside the program) ---

const Severity = z.enum(["critical", "medium", "low"])
const LineRef = z.union([z.string(), z.number()]).optional()
const Confidence = z.union([z.number(), z.string()]).optional()

const Issue = z.object({
  severity: Severity,
  confidence: Confidence,
  file: z.string().default(""),
  line: LineRef,
  description: z.string(),
})

const ReviewOutput = z.object({
  summary: z.string(),
  issues: z.array(Issue).default([]),
  suggestions: z.array(z.string()).default([]),
  verdict: z.string(),
})

const SynthIssue = z.object({
  file: z.string().default(""),
  line: LineRef,
  description: z.string(),
  confidence: Confidence,
})

const SynthesisOutput = z.object({
  summary: z.string(),
  critical: z.array(SynthIssue).default([]),
  medium: z.array(SynthIssue).default([]),
  low: z.array(SynthIssue).default([]),
  suggestions: z.array(z.string()).default([]),
  verdict: z.string(),
})

// --- Prompt builders (top-level, outside the program) ---

const reviewerPrompt = (target: string, baseRef: string | null, instructions: string | null) => `You are one reviewer on a code-review council. Perform a THOROUGH, READ-ONLY code review.

Review target: ${target}
${baseRef ? `Diff base: review the changes relative to \`${baseRef}\` — inspect the real diff of the current state against ${baseRef}.` : ""}
${instructions ? `Focus / instructions: ${instructions}` : ""}

Rules:
- You are READ-ONLY. Do NOT modify, stage, or commit any files — investigation only.
- Inspect the ACTUAL code/diff before judging: read the relevant files and the real diff; never review from assumptions.
- Be thorough but calibrated. Report real issues only; avoid nitpicks, pure-style comments, and duplicate findings.
- Cover at least: bugs, security, performance, error handling, test coverage, and API design.

Report via the structured output:
- summary: overall assessment of what you reviewed.
- issues: each with severity ("critical" | "medium" | "low"), confidence (0..1), file, line (a line number or range as a string; "" if not applicable), and a clear description.
- suggestions: concrete improvements that are not themselves issues.
- verdict: a short overall verdict.`

const synthesizerPrompt = (target: string, reviewsJson: string) => `You are the synthesizer for a code-review council. Several independent reviewers each produced a JSON review of the SAME target. Merge them into ONE coherent report.

Review target: ${target}

Synthesis rules:
- Deduplicate identical or substantially-overlapping findings into a single entry.
- When reviewers disagree on the severity of the same issue, use the HIGHER severity.
- Preserve unique findings that only one reviewer raised.
- Do NOT mention which reviewer or model found which issue — present it as one unified review.
- Group issues by severity into critical, medium, and low.
- Merge and deduplicate the suggestions too.

Reviews (anonymous, order is not meaningful):
${reviewsJson}

Report via the structured output:
- summary: overall assessment.
- critical / medium / low: arrays of issues (file, line, description, optional confidence).
- suggestions: merged, deduplicated list.
- verdict: one overall verdict for the whole council.`

// --- Program ---

const DEFAULT_MODELS = [
  "anthropic/claude-sonnet-5",
  "openai/gpt-5.5",
  "google/gemini-3-flash-preview",
  "z-ai/glm-5",
  "moonshotai/kimi-k2.6",
]

type Input = {
  models?: string[]
  target?: string
  baseRef?: string
  instructions?: string
  synthesisModel?: string
}

type Output = {
  target: string
  modelsRun: string[]
  modelsFailed: { model: string; error: string }[]
  summary: string
  critical: z.infer<typeof SynthIssue>[]
  medium: z.infer<typeof SynthIssue>[]
  low: z.infer<typeof SynthIssue>[]
  suggestions: string[]
  verdict: string
}

export default program<Input, Output>(async (ctx) => {
  const models = (ctx.input.models && ctx.input.models.length ? ctx.input.models : DEFAULT_MODELS)
    .map((m) => m.trim())
    .filter(Boolean)
  if (!models.length) throw new Error("council program requires at least one model")

  const target = ctx.input.target?.trim() || "the current working-tree changes in this repository"
  const baseRef = ctx.input.baseRef?.trim() || null
  const instructions = ctx.input.instructions?.trim() || null

  await checkpoint({
    name: "council.start",
    message: `Council review across ${models.length} model(s)`,
    data: { models, target },
  })

  // Fan out one read-only reviewer per model, in parallel. Resilient to
  // individual reviewer failures (e.g. a model that can't run a read agent).
  const outcomes = await Promise.all(
    models.map(async (model, i) => {
      try {
        const handle = await spawn(`reviewer-${i + 1}`, {
          type: "read",
          model,
          maxSteps: 40,
          prompt: reviewerPrompt(target, baseRef, instructions),
          output: ReviewOutput,
        })
        const review = await handle.result()
        return { model, review }
      } catch (err) {
        return { model, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )

  const reviews: z.infer<typeof ReviewOutput>[] = []
  const modelsRun: string[] = []
  const modelsFailed: { model: string; error: string }[] = []
  for (const o of outcomes) {
    if ("review" in o) {
      reviews.push(o.review)
      modelsRun.push(o.model)
    } else {
      modelsFailed.push({ model: o.model, error: o.error })
    }
  }

  if (!reviews.length) {
    throw new Error(
      `council: all ${models.length} reviewers failed: ${modelsFailed
        .map((f) => `${f.model} (${f.error})`)
        .join("; ")}`
    )
  }

  await checkpoint({
    name: "council.synthesize",
    message: `Synthesizing ${reviews.length} review(s)`,
    data: { modelsRun, modelsFailed },
  })

  // Anonymize before synthesis so the synthesizer can't attribute findings to models.
  const synth = await run("synthesizer", {
    type: "general",
    maxSteps: 30,
    ...(ctx.input.synthesisModel?.trim() ? { model: ctx.input.synthesisModel.trim() } : {}),
    prompt: synthesizerPrompt(target, JSON.stringify(reviews, null, 2)),
    output: SynthesisOutput,
  })

  return {
    target,
    modelsRun,
    modelsFailed,
    summary: synth.summary,
    critical: synth.critical,
    medium: synth.medium,
    low: synth.low,
    suggestions: synth.suggestions,
    verdict: synth.verdict,
  }
})