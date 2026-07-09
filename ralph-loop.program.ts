/**
 * @name ralph-loop
 * @description Ralph Wiggum-style iterative loop: re-runs the SAME task prompt on a fresh agent each iteration, letting each run build on its own prior work already present in the repo (files + git history), until a truthful completion promise is met or a max-iteration cap is hit.
 */

// --- Schemas (top-level, outside the program) ---

const IterationOutput = z.object({
  done: z.boolean(),
  promise: z.string().default(""),
  summary: z.string(),
  changed: z.array(z.string()).default([]),
})

// --- Prompt builder (top-level, outside the program) ---
// The task prompt is CONSTANT across iterations (faithful to Ralph: the prompt
// never changes, only the code does). Only the iteration header and the
// completion instruction vary.

const iterationPrompt = (task: string, iteration: number, completionPromise: string | null) => {
  const header = completionPromise
    ? `[Ralph loop iteration ${iteration}. When — and ONLY when — the task is genuinely and fully complete, set done=true and set promise to exactly "${completionPromise}". Never claim completion prematurely or output a false promise to escape the loop.]`
    : `[Ralph loop iteration ${iteration}. Set done=true only when the task is genuinely and fully complete.]`

  return `${header}

${task}

You are working iteratively on the task above. Your progress from earlier iterations is already present in the working tree and git history — FIRST inspect the current repository state to see what has already been done, then continue making concrete progress toward completing the task this iteration. Prefer targeted, idiomatic changes and verify your work where practical.

Report via the structured output:
- done: true only if the task is now genuinely and fully complete, otherwise false.
- promise: ${completionPromise ? `set to exactly "${completionPromise}" when (and only when) done is true; otherwise an empty string.` : `leave as an empty string.`}
- summary: a concise account of what you did this iteration.
- changed: the files or areas you changed this iteration.`
}

// --- Program ---

type Input = {
  task: string
  completionPromise?: string
  maxIterations?: number
  freshContext?: boolean
}

type IterationRecord = {
  iteration: number
  summary: string
  changed: string[]
  done: boolean
  promise: string
}

type Output = {
  task: string
  status: "complete" | "max-iterations"
  iterations: number
  completionPromise: string | null
  history: IterationRecord[]
  finalSummary: string
}

export default program<Input, Output>(async (ctx) => {
  const task = ctx.input.task?.trim()
  if (!task) throw new Error("ralph-loop program requires a non-empty task")

  const completionPromise = ctx.input.completionPromise?.trim() || null
  // Default cap 10; an explicit 0 means unlimited (deliberate opt-in escape hatch).
  const maxIterations = typeof ctx.input.maxIterations === "number" ? ctx.input.maxIterations : 10
  // Fresh worker each iteration by default (pure Ralph: clean context, repo carries state).
  const freshContext = ctx.input.freshContext ?? true

  const history: IterationRecord[] = []

  for (let iteration = 1; maxIterations === 0 || iteration <= maxIterations; iteration++) {
    await checkpoint({
      name: "ralph.iteration",
      message: `Ralph loop iteration ${iteration}`,
      data: { iteration, maxIterations },
    })

    // Fresh worker id each iteration gives a clean context that re-orients from
    // the repo; a stable id resumes the same accumulating worker instead.
    const workerId = freshContext ? `ralph-iter-${iteration}` : "ralph-worker"
    const res = await run(workerId, {
      type: "general",
      maxSteps: 100,
      prompt: iterationPrompt(task, iteration, completionPromise),
      output: IterationOutput,
    })

    history.push({
      iteration,
      summary: res.summary,
      changed: res.changed,
      done: res.done,
      promise: res.promise,
    })

    const promiseMet = completionPromise ? res.promise.trim() === completionPromise : true
    if (res.done && promiseMet) {
      return {
        task,
        status: "complete",
        iterations: iteration,
        completionPromise,
        history,
        finalSummary: res.summary,
      }
    }
  }

  const finalSummary = history.length ? history[history.length - 1].summary : ""
  return {
    task,
    status: "max-iterations",
    iterations: history.length,
    completionPromise,
    history,
    finalSummary,
  }
})