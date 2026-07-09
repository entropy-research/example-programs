**
 * @name goal
 * @description Persistent Codex-style goal: derive and store a requirements string, execute work, verify every requirement independently plus the objective as a whole, and repeat until satisfied or the same blocker recurs three consecutive turns.
 */

const RequirementItem = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  status: z.enum(["pending", "in_progress", "complete", "blocked"]),
  evidence: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
})

const RubricItem = z.object({
  id: z.string(),
  body: z.string(),
  satisfied: z.boolean().default(false),
  evidence: z.array(z.string()).default([]),
})

const Finding = z.object({
  title: z.string(),
  body: z.string(),
  confidence_score: z.number().min(0).max(1),
  priority: z.enum(["P0", "P1", "P2", "P3"]),
  code_location: z
    .object({
      absolute_file_path: z.string(),
      line_range: z.object({ start: z.number(), end: z.number() }),
    })
    .optional(),
})

const PlannerOutput = z.object({
  requirementsString: z.string(),
  requirements: z.array(RequirementItem),
  rubricItems: z.array(RubricItem).default([]),
  summary: z.string(),
})

const WorkerOutput = z.object({
  status: z.enum(["worked", "blocked"]),
  requirementStatus: z.enum(["pending", "in_progress", "complete", "blocked"]),
  summary: z.string(),
  evidence: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
  blocker: z.string().default(""),
  findings: z.array(Finding).default([]),
})

const RequirementCheck = z.object({
  requirementId: z.string(),
  passed: z.boolean(),
  evidence: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  summary: z.string(),
})

const ObjectiveCheck = z.object({
  passed: z.boolean(),
  evidence: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  summary: z.string(),
})

const VerifierOutput = z.object({
  verdict: z.enum(["satisfied", "unsatisfied", "blocked"]),
  requirementChecks: z.array(RequirementCheck),
  objectiveCheck: ObjectiveCheck,
  proofs: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  blocker: z.string().default(""),
  findings: z.array(Finding).default([]),
  summary: z.string(),
})

const asJson = (value: unknown) => JSON.stringify(value, null, 2)

const nowIso = () => new Date().toISOString()

const slugify = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return slug || \`goal-\${Date.now()}\`
}

const safeId = (value: string) => value.replace(/[^a-zA-Z0-9:_-]+/g, "-").slice(0, 180)

const normalizeInputObjective = (input: any) => {
  if (typeof input === "string") return input.trim()
  return String(input?.objective ?? input?.goal ?? "").trim()
}

const normalizeStringArray = (value: unknown) => Array.isArray(value) ? value.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []

const initialRubricItems = (items: string[]) => items.map((body, index) => ({
  id: \`rubric-\${index + 1}\`,
  body,
  satisfied: false,
  evidence: [] as string[],
}))

const plannerPrompt = (state: any) => \`You are the planner for a persistent goal loop.

Your task is to compute the stable verification target before execution begins.

Create:
1. A requirements string in concise Markdown.
2. A requirement item array matching that string.
3. Rubric items sufficient to verify the objective, preserving any caller-provided rubric items.

Derive requirements from:
- the objective,
- caller rubric items,
- explicit named deliverables,
- explicit tests/commands/gates/invariants,
- referenced files/plans/specs/issues when the objective names them,
- constraints already visible from the current repository context.

Rules:
- Do not mark requirements complete during planning.
- Each requirement must be independently verifiable.
- Keep the requirements string stable, concrete, and suitable for use as the goal's stored rubric.
- Include objective-level verification expectations in the requirements string, but do not replace the original objective; the verifier will check both.

Objective:
\${state.objective}

Base branch: \${state.baseBranch}
Repository root: \${state.repoRoot}

Caller rubric items:
\${state.rubricItems.length ? state.rubricItems.map((item: any, index: number) => \`\${index + 1}. \${item.body}\`).join("\n") : "none"}

Current state:
\${asJson(state)}\`

const workerPrompt = (state: any, requirementIndex: number) => {
  const requirement = state.requirements[requirementIndex]
  return \`You are the worker for a persistent goal loop.

Work only on the assigned requirement for this turn, while preserving the original objective.

Iteration: \${state.iteration}
Repository root: \${state.repoRoot}
Base branch: \${state.baseBranch}

Original objective:
\${state.objective}

Stored requirements string:
\${state.requirementsString}

Assigned requirement at requirements[\${requirementIndex}]:
\${asJson(requirement)}

Latest verification gaps to address where relevant:
\${state.latestGaps.length ? state.latestGaps.map((gap: string) => \`- \${gap}\`).join("\n") : "none"}

Instructions:
- Inspect and change the codebase as needed to satisfy the assigned requirement.
- Prefer targeted, idiomatic changes.
- Run focused verification where practical.
- Return concrete evidence: files changed, commands run, test results, or reasoning tied to observed state.
- If blocked, return status "blocked" and an exact blocker string. The same blocker recurring three consecutive turns stops the goal.
- If you discover correctness findings, return them as structured findings.
- Do not claim the whole goal is complete; only report this requirement's progress.\`
}

const verifierPrompt = (state: any) => \`You are the verifier for a persistent goal loop.

You must perform two independent audits:

1. Requirement-by-requirement audit:
   - Check every stored requirement independently.
   - For each requirement, decide passed true/false.
   - Provide concrete evidence for passed requirements.
   - Provide specific actionable gaps for failed requirements.

2. Objective-level audit:
   - Check the completed work against the original objective as a whole.
   - This catches missing or incorrectly-derived requirements.
   - The goal is not satisfied unless the objective-level check also passes.

Completion rule:
- verdict = "satisfied" only if every requirement passes AND the objective-level check passes AND there are no P0/P1 blocking findings.
- verdict = "unsatisfied" if more work can address the gaps.
- verdict = "blocked" only if a concrete blocker prevents progress.

If the objective-level check fails because the stored requirements are incomplete, put those missing objective-level requirements in objectiveCheck.gaps as concrete actionable statements. The program will append them to the stored requirements for the next iteration.

Original objective:
\${state.objective}

Stored requirements string:
\${state.requirementsString}

Current requirements:
\${asJson(state.requirements)}

Rubric items:
\${asJson(state.rubricItems)}

Progress notes:
\${asJson(state.progressNotes)}

Existing findings:
\${asJson(state.findings)}

Latest gaps:
\${asJson(state.latestGaps)}\`

const appendNote = (s: any, source: string, note: string, extra: any = {}) => {
  s.progressNotes.push({ at: nowIso(), source, note, ...extra })
}

const recordBlocker = (s: any, blocker: string) => {
  const text = blocker.trim()
  if (!text) {
    s.audits.blocked.consecutiveTurns = 0
    return
  }
  if (s.audits.blocked.blocker === text) s.audits.blocked.consecutiveTurns += 1
  else {
    s.audits.blocked.blocker = text
    s.audits.blocked.consecutiveTurns = 1
  }
  appendNote(s, "program", \`Observed blocker (\${s.audits.blocked.consecutiveTurns}/3): \${text}\`, { blocker: text })
}

const isBlocked = (s: any) => s.audits.blocked.consecutiveTurns >= 3

const nextObjectiveGapRequirementId = (iteration: number, index: number) => \`objective-gap-\${iteration}-\${index + 1}\`

const appendObjectiveGapRequirements = (s: any, gaps: string[], iteration: number) => {
  const existingBodies = new Set(s.requirements.map((req: any) => req.body.trim().toLowerCase()))
  const added: string[] = []
  gaps.forEach((gap, index) => {
    const body = gap.trim()
    if (!body) return
    const key = body.toLowerCase()
    if (existingBodies.has(key)) return
    const id = nextObjectiveGapRequirementId(iteration, index)
    s.requirements.push({
      id,
      title: \`Objective gap: \${body.slice(0, 80)}\`,
      body,
      status: "pending",
      evidence: [],
      notes: ["Added from objective-level verification gap."],
    })
    existingBodies.add(key)
    added.push(\`- \${body}\`)
  })
  if (added.length) {
    s.requirementsString = \`\${s.requirementsString}\n\n## Objective-level gaps added after verification \${iteration}\n\${added.join("\n")}\`
    appendNote(s, "program", \`Added \${added.length} objective-level verification gap(s) to stored requirements.\`)
  }
}

const applyRequirementChecks = (s: any, checks: any[]) => {
  const byId = new Map(checks.map((check: any) => [check.requirementId, check]))
  s.requirements = s.requirements.map((req: any) => {
    const check = byId.get(req.id)
    if (!check) return { ...req, status: "pending", notes: [...req.notes, "Verifier did not return a check for this requirement."] }
    const evidence = Array.from(new Set([...(req.evidence ?? []), ...(check.evidence ?? [])]))
    const notes = [...(req.notes ?? []), check.summary, ...(check.gaps ?? []).map((gap: string) => \`Gap: \${gap}\`)]
    return { ...req, status: check.passed ? "complete" : "pending", evidence, notes }
  })
}

const hasBlockingFindings = (findings: any[]) => findings.some((finding) => finding.priority === "P0" || finding.priority === "P1")

program(async (ctx) => {
  const input: any = ctx.input ?? {}
  const objective = normalizeInputObjective(input)
  if (!objective) throw new Error("goal requires a non-empty objective")

  const repoRoot = typeof input.repoRoot === "string" && input.repoRoot.trim() ? input.repoRoot.trim() : "/Users/k/workspace/randomlabs"
  const baseBranch = typeof input.baseBranch === "string" && input.baseBranch.trim() ? input.baseBranch.trim() : "dev"
  const callerRubric = normalizeStringArray(input.rubric)
  const runPrefix = safeId(\`goal:\${slugify(objective)}:\${ctx.info.workflowId}\`)

  const s = state({
    threadId: ctx.info.workflowId,
    objective,
    requirementsString: "",
    status: "active",
    iteration: 0,
    repoRoot,
    baseBranch,
    rubricItems: initialRubricItems(callerRubric),
    requirements: [] as any[],
    latestGaps: [] as string[],
    progressNotes: [
      {
        at: ctx.startedAt,
        source: "program",
        note: "Goal created; planner will derive a stored requirements string before execution.",
      },
    ],
    findings: [] as any[],
    audits: {
      completion: {
        verdict: "pending",
        requirementChecks: [] as any[],
        objectiveCheck: { passed: false, evidence: [] as string[], gaps: [] as string[], summary: "pending" },
        proofs: [] as string[],
        gaps: [] as string[],
      },
      blocked: {
        consecutiveTurns: 0,
        blocker: null as string | null,
        blocked: false,
      },
    },
  })

  const planner = await run(\`\${runPrefix}:planner\`, {
    type: "general",
    maxSteps: 40,
    prompt: plannerPrompt(snapshot(s)),
    output: PlannerOutput,
  })

  s.requirementsString = planner.requirementsString
  s.requirements = planner.requirements
  s.rubricItems = planner.rubricItems.length ? planner.rubricItems : s.rubricItems
  appendNote(s, "planner", planner.summary)

  for (let iteration = 1; ; iteration++) {
    s.iteration = iteration
    appendNote(s, "program", \`Starting iteration \${iteration}.\`)
    await checkpoint({ name: "goal.iteration", message: \`Starting goal iteration \${iteration}\`, data: { iteration } })

    const count = snapshot(s).requirements.length
    for (let index = 0; index < count; index++) {
      const snap = snapshot(s)
      const requirement = snap.requirements[index]
      if (!requirement || requirement.status === "complete") continue

      s.requirements[index].status = "in_progress"
      appendNote(s, "program", \`Iteration \${iteration}: working on \${requirement.id}: \${requirement.title}\`)

      const worked = await run(\`\${runPrefix}:worker\`, {
        type: "general",
        maxSteps: 100,
        prompt: workerPrompt(snapshot(s), index),
        output: WorkerOutput,
      })

      s.requirements[index].status = worked.requirementStatus
      s.requirements[index].evidence = Array.from(new Set([...(s.requirements[index].evidence ?? []), ...worked.evidence]))
      s.requirements[index].notes.push(worked.summary, ...worked.notes)
      s.findings.push(...worked.findings)
      appendNote(s, "worker", worked.summary, worked.blocker ? { blocker: worked.blocker } : {})
      recordBlocker(s, worked.status === "blocked" ? worked.blocker : "")

      if (isBlocked(s)) {
        s.audits.blocked.blocked = true
        s.status = "blocked"
        return snapshot(s)
      }
    }

    s.audits.completion.verdict = "pending"
    const verification = await run(\`\${runPrefix}:verifier\`, {
      type: "general",
      maxSteps: 70,
      prompt: verifierPrompt(snapshot(s)),
      output: VerifierOutput,
    })

    s.audits.completion = {
      verdict: verification.verdict,
      requirementChecks: verification.requirementChecks,
      objectiveCheck: verification.objectiveCheck,
      proofs: verification.proofs,
      gaps: verification.gaps,
    }
    s.findings.push(...verification.findings)
    applyRequirementChecks(s, verification.requirementChecks)

    const allRequirementsPassed = snapshot(s).requirements.every((req: any) => req.status === "complete")
    const blockingFindings = hasBlockingFindings(snapshot(s).findings)
    const objectivePassed = verification.objectiveCheck.passed
    const allPassed = allRequirementsPassed && objectivePassed && !blockingFindings && verification.verdict === "satisfied"

    appendNote(
      s,
      "verifier",
      \`\${verification.summary} Requirement checks passed: \${verification.requirementChecks.filter((check: any) => check.passed).length}/\${snapshot(s).requirements.length}. Objective check: \${objectivePassed ? "passed" : "failed"}.\`,
      verification.blocker ? { blocker: verification.blocker } : {},
    )

    recordBlocker(s, verification.verdict === "blocked" ? verification.blocker : "")
    if (isBlocked(s)) {
      s.audits.blocked.blocked = true
      s.status = "blocked"
      return snapshot(s)
    }

    if (allPassed) {
      s.status = "complete"
      appendNote(s, "program", "Goal complete: all stored requirements passed independently and the objective-level check passed.")
      return snapshot(s)
    }

    const requirementGaps = verification.requirementChecks.flatMap((check: any) => check.passed ? [] : check.gaps)
    const objectiveGaps = verification.objectiveCheck.passed ? [] : verification.objectiveCheck.gaps
    const findingGaps = blockingFindings ? snapshot(s).findings.filter((finding: any) => finding.priority === "P0" || finding.priority === "P1").map((finding: any) => \`\${finding.priority}: \${finding.title} — \${finding.body}\`) : []
    s.latestGaps = [...verification.gaps, ...requirementGaps, ...objectiveGaps, ...findingGaps]
    appendObjectiveGapRequirements(s, objectiveGaps, iteration)

    appendNote(
      s,
      "program",
      \`Iteration \${iteration} unsatisfied; continuing. Gaps: \${s.latestGaps.length ? s.latestGaps.join("; ") : "none recorded"}\`,
    )
  }
})
