/**
 * @name workflow-from-chats
 * @description Mine recent Slate sessions to infer durable working preferences, then propose new Slate PROGRAMS and SKILLS (proposals only, no files written). Fans out extractors over recent session transcripts, rates confidence, clusters by workflow shape, and synthesizes adopt/consider/dismissed plus concrete program/skill proposals. Port of the cursor-team-kit workflow-from-chats skill.
 */

// --- Storage facts (how Slate persists sessions on disk) ---

const STORAGE_NOTE = `Slate stores sessions as plain JSON files (NOT SQLite).
Data root resolves to the first writable of: \${XDG_DATA_HOME}/slate/data, ~/.slate/data, /tmp/slate/data.
The channel renames the app dir: SLATE_CHANNEL=latest -> "slate", otherwise "slate-\${SLATE_CHANNEL}" (e.g. "slate-local"). So also check ~/.local/share/slate*/data and ~/.slate*/data.
Under the data root, everything lives in <data>/storage/.
- Session records: <data>/storage/session/<projectID>/<sessionID>.json  (files named ses_*.json)
- Message records: <data>/storage/message/<sessionID>/<messageID>.json  (files named msg_*.json)
Session JSON fields: id, title, task, type, projectID, parentID, rootSessionID, forkedFromID, createdByWorkflowID, alias, time:{created,updated,archived?}.
Message JSON fields: id, sessionID, parentId, role ("user"|"assistant"|"system"|"tool_response"|"custom"), content[] (text lives in content[].text), timestamp.
There is NO durable session status field; use time.updated / time.created for the window and time.archived as a completion-ish signal.
Parent (human-facing) conversations are sessions with no parentID (or where rootSessionID === id); sub-agent sessions carry parentID/rootSessionID pointing at their parent.`

const PRIVACY_NOTE = `PRIVACY: Never expose local transcript file paths, secrets, credentials, customer data, or raw private chat content in the output. Cite evidence ONLY by parent session id + title. Do not quote tool outputs, customInstructions content, share.secret, or workspace directory paths.`

// --- Schemas (top-level) ---

const SessionRef = z.object({
  sessionID: z.string(),
  title: z.string().default(""),
  type: z.string().default(""),
  created: z.string().default(""),
  updated: z.string().default(""),
  messageCount: z.number().default(0),
  isParent: z.boolean().default(true),
})

const Inventory = z.object({
  dataDir: z.string(),
  projectScope: z.string(),
  windowDays: z.number(),
  sessions: z.array(SessionRef),
  notes: z.string().default(""),
})

const PreferenceAtom = z.object({
  trigger: z.string(),
  workflowStep: z.string(),
  decisionRule: z.string(),
  qualityBar: z.string().default(""),
  stopCondition: z.string().default(""),
  evidence: z.array(z.string()).default([]),
  confidence: z.enum(["strong", "medium", "weak", "contradicted"]),
})

const ExtractorOutput = z.object({
  atoms: z.array(PreferenceAtom).default([]),
})

const ProgramProposal = z.object({
  name: z.string(),
  description: z.string(),
  rationale: z.string(),
  sketch: z.string(),
  confidence: z.enum(["strong", "medium", "weak"]),
})

const SkillProposal = z.object({
  name: z.string(),
  description: z.string(),
  whenToUse: z.string(),
  rationale: z.string(),
  confidence: z.enum(["strong", "medium", "weak"]),
})

const SynthesisOutput = z.object({
  targetWorkflow: z.string(),
  evidenceCorpus: z.array(z.string()).default([]),
  preferenceProfile: z.string(),
  adopt: z.array(z.string()).default([]),
  consider: z.array(z.string()).default([]),
  dismissed: z.array(z.string()).default([]),
  proposedPrograms: z.array(ProgramProposal).default([]),
  proposedSkills: z.array(SkillProposal).default([]),
  openQuestions: z.array(z.string()).default([]),
})

// --- Prompt builders (top-level) ---

const inventoryPrompt = (windowDays: number, scope: string, projectId: string, dataDir: string, maxSessions: number) => `You are the transcript inventory builder for a preference-mining program over Slate's own session store.

${STORAGE_NOTE}

${PRIVACY_NOTE}

Task:
- Locate the Slate session store on disk. ${dataDir ? `Prefer this data root: ${dataDir}.` : "Resolve the data root per the notes above (try the XDG and ~/.slate candidates and pick the one that actually contains storage/session)."}
- Project scope: ${scope}. ${scope === "project"
    ? projectId
      ? `Restrict to project id "${projectId}".`
      : "Restrict to a single project: choose the storage/session/<projectID> directory with the most recent activity (latest session time.updated). Report which projectID you picked in notes."
    : "Include sessions across ALL project directories under storage/session."}
- Consider only PARENT (human-facing) sessions: no parentID, or rootSessionID === id. Exclude pure sub-agent sessions from the inventory (their content is still readable later as evidence).
- Filter to sessions whose time.updated (fall back to time.created) is within the last ${windowDays} days.
- Cap the inventory at the ${maxSessions} most recently updated matching sessions.
- For each, read the session json for title/type/time and count its message files under storage/message/<sessionID>/.

Return the Inventory (dataDir, projectScope, windowDays, sessions[], notes). Do NOT include file paths in titles or notes.`

const extractorPrompt = (windowDays: number, sessions: { sessionID: string; title: string }[], dataDir: string) => `You are a preference extractor. Read the assigned Slate session transcripts and extract DURABLE working preferences. Do not summarize the chats; extract reusable workflow guidance.

${STORAGE_NOTE}

${PRIVACY_NOTE}

Data root: ${dataDir}
Assigned parent sessions (read their messages, and their sub-agent sessions' messages as supporting evidence):
${sessions.map((s) => `- ${s.sessionID}  "${s.title}"`).join("\n")}

For each session, read messages from <data>/storage/message/<sessionID>/*.json in timestamp order. Sub-agent sessions are those whose session json has parentID/rootSessionID pointing at one of the assigned sessions; use their content as evidence but cite only the parent session.

Scan for explicit preferences, corrections, and workflow markers such as: "I prefer", "always", "never", "not what I asked", "stop", "review", "PR", "CI", "logs", "skill", "program", "in parallel", "verbatim", plus repeated instructions and things the user redirected.

Extract preference ATOMS. Each atom: trigger (when it applies), workflowStep, decisionRule, qualityBar, stopCondition, evidence (cite ONLY parent session ids+titles), and confidence:
- strong: explicit user preference, workflow-changing correction, repeated across parent chats, or a direct request to encode behavior.
- medium: accepted workflow, repeated tool/model/validation preference, or subagent consensus the parent used successfully.
- weak: agent-chosen behavior with no user feedback, one ambiguous transcript, or a likely task-specific correction.
- contradicted: evidence points in incompatible directions.

Return ExtractorOutput with the atoms. Filter anecdotes that will not help future tasks.`

const synthesisPrompt = (windowDays: number, atoms: unknown, corpus: unknown) => `You are the synthesizer for a preference-mining program. Turn extracted preference atoms into a synthesis plus proposals for new Slate PROGRAMS and SKILLS.

${PRIVACY_NOTE}

Context:
- Window: last ${windowDays} days of Slate sessions.
- Evidence corpus (parent sessions, cite by these only):
${JSON.stringify(corpus, null, 2)}
- Preference atoms extracted:
${JSON.stringify(atoms, null, 2)}

Do this:
1. State the target workflow / preference surface in one paragraph.
2. Cluster atoms by workflow SHAPE (shipping, review, simplification, debugging, capture, communication, delegation, validation), not by transcript.
3. Build a preference profile, and split observations into adopt (strong), consider (medium), dismissed (weak/contradicted/stale).
4. Choose artifacts and produce PROPOSALS ONLY (write no files):
   - A Slate PROGRAM proposal fits a recurring MULTI-STEP orchestration with clear triggers (something worth an agent pipeline: planner/worker/verifier, fan-out, loops). Give name, description, rationale, a concrete orchestration sketch (agents/phases/structured outputs), and confidence.
   - A Slate SKILL proposal fits durable guidance/conventions that should shape how an agent behaves within its domain (not a multi-step pipeline). Give name, description, whenToUse, rationale, and confidence.
   - Prefer a small number of high-conviction proposals grounded in strong/medium atoms. Do not propose artifacts from weak or contradicted evidence.
5. List open questions ONLY if they block deciding an artifact.

Return the SynthesisOutput.`

// --- Program ---

type Input = {
  windowDays?: number
  scope?: "project" | "all"
  projectId?: string
  dataDir?: string
  maxSessions?: number
  maxExtractors?: number
}

type Output = SynthesisResult

type SynthesisResult = {
  windowDays: number
  dataDir: string
  projectScope: string
  sessionsConsidered: number
  synthesis: unknown
}

const chunk = <T,>(items: T[], groups: number): T[][] => {
  const out: T[][] = Array.from({ length: Math.max(1, Math.min(groups, items.length || 1)) }, () => [])
  items.forEach((item, i) => out[i % out.length].push(item))
  return out.filter((g) => g.length)
}

export default program<Input, Output>(async (ctx) => {
  const windowDays = ctx.input.windowDays ?? 7
  const scope = ctx.input.scope ?? "project"
  const projectId = ctx.input.projectId?.trim() || ""
  const dataDirInput = ctx.input.dataDir?.trim() || ""
  const maxSessions = ctx.input.maxSessions ?? 40
  const maxExtractors = ctx.input.maxExtractors ?? 4

  // Phase 1: locate the store and build the transcript inventory
  const inventory = await run("transcript-inventory", {
    type: "general",
    maxSteps: 30,
    prompt: inventoryPrompt(windowDays, scope, projectId, dataDirInput, maxSessions),
    output: Inventory,
  })

  if (!inventory.sessions.length) {
    return {
      windowDays,
      dataDir: inventory.dataDir,
      projectScope: inventory.projectScope,
      sessionsConsidered: 0,
      synthesis: { targetWorkflow: "n/a", evidenceCorpus: [], preferenceProfile: `No parent sessions found in the last ${windowDays} days.`, adopt: [], consider: [], dismissed: [], proposedPrograms: [], proposedSkills: [], openQuestions: [] },
    }
  }

  // Phase 2: fan out extractors across session batches
  const batches = chunk(
    inventory.sessions.map((s) => ({ sessionID: s.sessionID, title: s.title })),
    maxExtractors,
  )
  const handles = await Promise.all(
    batches.map((b, i) =>
      spawn(`extractor-${i + 1}`, {
        type: "general",
        maxSteps: 40,
        prompt: extractorPrompt(windowDays, b, inventory.dataDir),
        output: ExtractorOutput,
      })
    )
  )
  const results = await Promise.all(handles.map((h) => h.result()))
  const atoms = results.flatMap((r) => r.atoms)

  // Phase 3: synthesize + propose programs/skills
  const corpus = inventory.sessions.map((s) => ({ sessionID: s.sessionID, title: s.title, updated: s.updated }))
  const synthesis = await run("synthesizer", {
    type: "general",
    maxSteps: 30,
    prompt: synthesisPrompt(windowDays, atoms, corpus),
    output: SynthesisOutput,
  })

  return {
    windowDays,
    dataDir: inventory.dataDir,
    projectScope: inventory.projectScope,
    sessionsConsidered: inventory.sessions.length,
    synthesis,
  }
})