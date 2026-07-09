/**
 * @name thermo-nuclear-code-quality-review
 * @description Extremely strict maintainability review of a branch's changes. Acquires the diff, fans out reviewers applying a harsh "code-judo" rubric (abstraction quality, giant files, spaghetti growth, boundary leaks), then aggregates into prioritized findings and an approval verdict. Port of the cursor-team-kit skill.
 */

// --- Rubric (verbatim-faithful to the skill) ---

const REVIEW_RUBRIC = `Perform a deep code quality audit of the assigned changes.
Rethink how to structure / implement the changes to meaningfully improve code quality without impacting behavior.
Work to improve abstractions, modularity, reduce spaghetti code, improve succinctness and legibility.
Be ambitious: if there is a clear path to improving the implementation that involves restructuring some of the codebase, go for it.
Be extremely thorough and rigorous. Measure twice, cut once.

Above all, be AMBITIOUS about code structure. Do not merely identify local cleanup. Actively search for "code judo" moves: restructurings that preserve behavior while making the implementation dramatically simpler, smaller, more direct, and more elegant.

NON-NEGOTIABLE STANDARDS:
0. Be ambitious about structural simplification. Look for reframings that make whole branches, helpers, modes, conditionals, or layers disappear. Prefer deleting complexity over rearranging it.
1. Do not let a PR push a file from under 1k lines to over 1k lines without a very strong reason. Treat crossing 1000 lines as a strong smell; prefer extracting helpers/modules.
2. Do not allow random spaghetti growth. Be suspicious of new ad-hoc conditionals, scattered special cases, or one-off branches bolted into unrelated flows. Push logic into a dedicated abstraction/helper/state machine.
3. Bias toward cleaning the design, not just accepting working code. Prefer removing moving pieces over spreading complexity around.
4. Prefer direct, boring, maintainable code over hacky or magical code. Flag thin abstractions, identity wrappers, pass-through helpers, and brittle "magic".
5. Push on type/boundary cleanliness: question unnecessary optionality, unknown, any, or cast-heavy code; prefer explicit typed models/contracts; flag silent fallbacks papering over unclear invariants.
6. Keep logic in the canonical layer and reuse existing helpers. Flag feature logic leaking into shared paths, implementation leaking through APIs, and bespoke near-duplicates of canonical utilities.
7. Treat unnecessary sequential orchestration and non-atomic updates as design smells when the cleaner structure is obvious.

PRIMARY QUESTIONS: Is there a code-judo move that makes this dramatically simpler? Can it be reframed so fewer concepts/branches/layers are needed? Better or worse local architecture? Did the diff add branching where a better abstraction should exist? Right file/layer? Did a file cross a healthy size boundary? Repeated conditionals signalling a missing model? Direct and legible or special-cased? Is the abstraction earning its keep? Casts/optionality/ad-hoc shapes obscuring the invariant? Boundary leak? More sequential/less atomic than needed?

FLAG AGGRESSIVELY: complicated implementations where a cleaner reframing deletes whole categories of complexity; refactors that move code without reducing concepts; files crossing 1000 lines; conditionals bolted onto unrelated paths; one-off flags/nullable modes; feature logic in general modules; magic handling; thin wrappers; unnecessary casts/any/unknown/optionals; copy-pasted logic; edge cases stuffed mid-function; refactors that pass tests but reduce modularity; "temporary" branching; bespoke helpers duplicating canonical ones; logic in the wrong layer; needless sequential async; partial-update logic.

PREFERRED REMEDIES: delete a layer of indirection rather than polish it; reframe the state model so conditionals disappear; change the ownership boundary; turn special cases into a simpler default flow; extract a helper/pure function; split large files; move feature logic behind a dedicated abstraction; replace condition chains with a typed model/dispatcher; separate orchestration from business logic; collapse duplicate branches; delete unclarifying wrappers; reuse canonical helpers; make type boundaries explicit; move logic to the owning package/module; parallelize independent work when it also simplifies; restructure related updates to be atomic. Do not settle for "maybe rename this" when the issue is structural, nor a cleaner version of the same messy idea when a simpler idea is plausible.

APPROVAL BAR (presumptive blockers unless clearly justified): preserves incidental complexity when a code-judo move would delete it; pushes a file from <1000 to >1000 lines; adds ad-hoc branching that tangles an existing flow; scatters feature checks across shared code; adds an unnecessary abstraction/wrapper/cast-heavy contract; duplicates an existing helper or puts logic in the wrong layer. Do not approve merely because behavior seems correct.

TONE: direct, serious, demanding; not rude. Do not soften major maintainability issues. Prefer a small number of high-conviction findings over a long list of cosmetic nits.`

// --- Schemas (top-level) ---

const ChangedFile = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "other"]),
  added: z.number(),
  removed: z.number(),
  newTotalLines: z.number().optional(),
  crossesThousandLineBoundary: z.boolean().default(false),
})

const DiffInventory = z.object({
  baseRef: z.string(),
  headRef: z.string(),
  files: z.array(ChangedFile),
  summary: z.string(),
})

const Finding = z.object({
  title: z.string(),
  category: z.enum([
    "structural-regression",
    "missed-simplification",
    "spaghetti-growth",
    "boundary-abstraction-type",
    "file-size-decomposition",
    "modularity",
    "legibility",
  ]),
  severity: z.enum(["blocker", "major", "minor"]),
  file: z.string(),
  lineRange: z.object({ start: z.number(), end: z.number() }).optional(),
  problem: z.string(),
  codeJudoSuggestion: z.string(),
})

const ReviewerOutput = z.object({
  findings: z.array(Finding).default([]),
  fileSummary: z.string(),
})

const VerdictOutput = z.object({
  verdict: z.enum(["approve", "request-changes", "block"]),
  blockers: z.array(z.string()).default([]),
  prioritizedFindings: z.array(Finding).default([]),
  summary: z.string(),
})

// --- Prompt builders (top-level) ---

type Group = { path: string; added: number; removed: number; crosses: boolean }

const scopePrompt = (baseRef: string, headRef: string, repoRoot: string) => `You are the diff scoper for a strict code-quality review.

Repository root: ${repoRoot || "(the current working directory)"}
Base ref: ${baseRef}
Head ref: ${headRef}

Produce the inventory of changes between base and head. Run git to get it, e.g.:
  git -C <repo> diff --numstat ${baseRef}...${headRef}
  git -C <repo> diff --name-status ${baseRef}...${headRef}
For each changed source file, report path, status, lines added/removed, and (for modified/added files) the new total line count via e.g. wc -l on the head version. Set crossesThousandLineBoundary = true when the file was under 1000 lines before the change and is at/over 1000 after (use git show ${baseRef}:<path> to get the previous size; if it did not exist before, treat previous size as 0).
Ignore generated/lockfiles/vendored paths where a line-count review is meaningless, but still list them with a note in summary.

Return the DiffInventory.`

const reviewerPrompt = (baseRef: string, headRef: string, repoRoot: string, files: Group[]) => `You are a reviewer performing an unusually strict, ambitious code-quality audit.

Apply this rubric exactly:
${REVIEW_RUBRIC}

Repository root: ${repoRoot || "(the current working directory)"}
Base ref: ${baseRef}
Head ref: ${headRef}

Review ONLY these files (inspect the diff and the surrounding code as needed):
${files.map((f) => `- ${f.path} (+${f.added}/-${f.removed})${f.crosses ? " [crosses 1000-line boundary]" : ""}`).join("\n")}

To see each change: git -C <repo> diff ${baseRef}...${headRef} -- <path>, and read the head version of the file for full context.
Return findings via the structured output. Each finding: title, category, severity (blocker/major/minor), file, optional lineRange, the concrete problem, and a specific "code-judo" restructuring suggestion. Prefer high-conviction structural findings over cosmetic nits.`

const verdictPrompt = (baseRef: string, headRef: string, allFindings: unknown, inventory: unknown) => `You are the lead reviewer aggregating a strict code-quality review.

Base ref: ${baseRef}
Head ref: ${headRef}

Diff inventory:
${JSON.stringify(inventory, null, 2)}

All reviewer findings (may overlap across reviewers):
${JSON.stringify(allFindings, null, 2)}

Tasks:
- Dedupe overlapping findings, keeping the strongest framing.
- Prioritize in this order: structural regressions, missed simplification/code-judo, spaghetti/branching growth, boundary/abstraction/type problems, file-size/decomposition, modularity, legibility.
- Decide the verdict against the approval bar. Presumptive blockers: preserving incidental complexity when a code-judo move would delete it; a file pushed from <1000 to >1000 lines; ad-hoc branching tangling existing flows; feature checks scattered across shared code; unnecessary abstraction/wrapper/cast-heavy contracts; duplicating a canonical helper or logic in the wrong layer.
- verdict = "approve" only if none of the presumptive blockers hold; "block" if unjustified blockers exist; otherwise "request-changes".
- Put each blocker as a concise actionable statement in blockers[].

Return the VerdictOutput.`

// --- Program ---

type Input = {
  baseBranch?: string
  headBranch?: string
  repoRoot?: string
  maxReviewers?: number
}

type Output = {
  baseRef: string
  headRef: string
  verdict: string
  blockers: string[]
  findings: unknown[]
  summary: string
  inventory: unknown
}

const chunk = <T,>(items: T[], groups: number): T[][] => {
  const out: T[][] = Array.from({ length: Math.max(1, Math.min(groups, items.length || 1)) }, () => [])
  items.forEach((item, i) => out[i % out.length].push(item))
  return out.filter((g) => g.length)
}

export default program<Input, Output>(async (ctx) => {
  const baseRef = ctx.input.baseBranch?.trim() || "dev"
  const headRef = ctx.input.headBranch?.trim() || "HEAD"
  const repoRoot = ctx.input.repoRoot?.trim() || ""
  const maxReviewers = ctx.input.maxReviewers ?? 4

  // Phase 1: scope the diff
  const inventory = await run("diff-scoper", {
    type: "general",
    maxSteps: 25,
    prompt: scopePrompt(baseRef, headRef, repoRoot),
    output: DiffInventory,
  })

  const reviewable = inventory.files.filter((f) => f.status !== "deleted")
  if (!reviewable.length) {
    return { baseRef: inventory.baseRef, headRef: inventory.headRef, verdict: "approve", blockers: [], findings: [], summary: "No reviewable changes between the given refs.", inventory }
  }

  // Phase 2: fan out reviewers across file groups
  const groups = chunk(
    reviewable.map((f) => ({ path: f.path, added: f.added, removed: f.removed, crosses: f.crossesThousandLineBoundary })),
    maxReviewers,
  )
  const handles = await Promise.all(
    groups.map((g, i) =>
      spawn(`reviewer-${i + 1}`, {
        type: "general",
        maxSteps: 50,
        prompt: reviewerPrompt(inventory.baseRef, inventory.headRef, repoRoot, g),
        output: ReviewerOutput,
      })
    )
  )
  const results = await Promise.all(handles.map((h) => h.result()))
  const allFindings = results.flatMap((r) => r.findings)

  // Phase 3: aggregate + verdict
  const verdict = await run("lead-reviewer", {
    type: "general",
    maxSteps: 30,
    prompt: verdictPrompt(inventory.baseRef, inventory.headRef, allFindings, inventory),
    output: VerdictOutput,
  })

  return {
    baseRef: inventory.baseRef,
    headRef: inventory.headRef,
    verdict: verdict.verdict,
    blockers: verdict.blockers,
    findings: verdict.prioritizedFindings,
    summary: verdict.summary,
    inventory,
  }
})