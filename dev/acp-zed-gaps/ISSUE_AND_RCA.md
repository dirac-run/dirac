# Issue & Root Cause Analysis: Dirac ACP Exposes Too Few Session Items to Zed

## Symptom
In Zed's agent panel, Dirac (as an external ACP agent) shows fewer controls and items than it supports internally: the past-threads drawer is hidden, `inference_speed` shares the `"model"` category slot with the model selector, OpenAI-compatible (`openai`) models are unavailable in `master`'s ACP session config, and "Fork thread" (`session/fork`) is not supported.

## Architecture & ACP Handshake Flow

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                                 Zed Editor                                   │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌────────────────────┐  │
│  │ Threads Sidebar      │  │ ConfigOptionsView    │  │ Slash Popup (`/`)  │  │
│  │ (session/list,       │  │ (category: mode,     │  │ (available_        │  │
│  │  session/load,       │  │  _provider, model,   │  │  commands_update,  │  │
│  │  session/fork)       │  │  model_config,       │  │  input.hint)       │  │
│  │                      │  │  thought_level)      │  │                    │  │
│  └──────────▲───────────┘  └──────────▲───────────┘  └─────────▲──────────┘  │
└─────────────┼─────────────────────────┼────────────────────────┼─────────────┘
              │ JSON-RPC over stdio     │                        │
              │ (initialize / session/*)│                        │
┌─────────────┼─────────────────────────┼────────────────────────┼─────────────┐
│             │            Dirac CLI (`dirac --acp`)             │             │
│  ┌──────────┴───────────┐  ┌──────────┴───────────┐  ┌─────────┴──────────┐  │
│  │ AcpAgent +           │  │ SessionConfigManager │  │ sendAvailable      │  │
│  │ DiracAgent           │  │ (sessionConfig.ts)   │  │ Commands           │  │
│  │ (initialize,         │  │                      │  │ (DiracAgent.ts)    │  │
│  │  listSessions,       │  │ • mode (cat: mode)   │  │                    │  │
│  │  loadSession,        │  │ • provider (_provider│  │                    │  │
│  │  resumeSession,      │  │ • model (cat: model) │  │                    │  │
│  │  forkSession [GAP])  │  │ • inference_speed    │  │                    │  │
│  │                      │  │   (cat: model [BUG]  │  │                    │  │
│  │ sessionCapabilities: │  │    -> model_config)  │  │                    │  │
│  │  resume, close,      │  │ • reasoning_effort   │  │                    │  │
│  │  delete              │  │ • thinking_budget    │  │                    │  │
│  │  (missing list [BUG] │  └──────────────────────┘  └────────────────────┘  │
│  │   and fork [GAP])    │                                                    │
│  └──────────────────────┘                                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Evidence from Persisted ACP Traffic

Inspection of `~/.dirac/data/acp-session-updates/99d8d0e0….jsonl` confirms Dirac already emits the runtime `sessionUpdate` types Zed renders:

```text
sessionUpdate kinds emitted:
  config_option_update ×5
  available_commands_update ×2

configOptions sent to Zed:
  mode             cat=mode           select   cur=act             opts=[plan|act]
  auto_approve     cat=mode           boolean  cur=false
  yolo             cat=mode           boolean  cur=false
  provider         cat=_provider      select   cur=deepseek        opts=[22 providers]
  model            cat=model          select   cur=deepseek-flash  opts=[deepseek-flash|deepseek-v4-pro]
  reasoning_effort cat=thought_level  select   cur=high            opts=[none|minimal|low|medium|high|xhigh|max]

availableCommands sent to Zed (20):
  newtask, smol, newrule, askDirac, help, reloadtools,
  audit, caveman, caveman-commit, caveman-review,
  commit-driven-doc-sync, dirac-pr-flow, find-skills,
  hallmark, new-tool, web-search, delete-tool,
  /review, /review-branch, /review-commit
```

## Root Causes

### 1. `sessionCapabilities.list` Is Implemented but Not Advertised
`DiracAgent.unstable_listSessions` (`cli/src/agent/DiracAgent.ts:2318–2343`) and `AcpAgent.unstable_listSessions` (`cli/src/acp/AcpAgent.ts:375–378`) are already implemented and unit-tested (`cli/src/acp/AcpAgent.test.ts:276–286`), yet `initialize` in `cli/src/agent/DiracAgent.ts:1198–1202` omits `list: {}`:

```ts
sessionCapabilities: {
	resume: {},
	close: {},
	delete: {},
},
```

An existing test in `cli/src/agent/DiracAgent.worktree.test.ts:140` explicitly asserted `{ resume: {}, close: {}, delete: {} }`. Per the ACP specification, clients only enable `session/list` when `sessionCapabilities.list` is advertised, so Zed hides its past-threads list for Dirac.

```text
BEFORE (master):
  Zed ──initialize──► DiracAgent
  Zed ◄─────────────  sessionCapabilities: { resume: {}, close: {}, delete: {} }
  Zed: "list" capability absent ──► Hides Past Threads / History button

AFTER (fix):
  Zed ──initialize──► DiracAgent
  Zed ◄─────────────  sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} }
  Zed ──session/list► AcpAgent.unstable_listSessions() ──► Returns persisted + active sessions
```

### 2. `inference_speed` Uses `category: "model"` Instead of `"model_config"`
In `cli/src/agent/sessionConfig.ts:227–241`, the `inference_speed` select option declares `category: "model"`, colliding with the primary `model` selector (`id: "model", category: "model"`).

In Zed (`crates/agent_ui/src/config_options.rs`), `first_config_option_id(category)` binds category pickers and shortcuts to the first option matching each semantic category. The ACP v2 schema (`SessionConfigOptionCategory = "mode" | "model" | "model_config" | "thought_level" | string`) defines `"model_config"` for model parameters such as inference speed/tier so clients render them alongside the model selector without colliding with `"model"`.

### 3. OpenAI-Compatible (`openai`) Provider Has No Model Catalog in `master`'s ACP `SessionConfigManager`
In `99d8d0e0….jsonl`, `provider` lists `openai` among the 22 providers, but on `master`, `SessionConfigManager.getProviderModelCandidates()` (`cli/src/agent/sessionConfig.ts:535–555`) only queries dynamic catalogs for `openrouter`, `huggingface`, and `github-copilot`, then falls through to `hasStaticModels(provider)` (which is `false` for `openai`). Selecting `openai` in Zed's ACP provider dropdown therefore throws `Provider openai has no usable models`.
- *Note*: This is fixed on branch `dev/modelsapi` (PR #274), which wires `getOpenAiModels()` into `SessionConfigManager.getProviderModelCandidates()`.

### 4. Slash-Command `input.hint` Duplicates `cmd.description` (Cosmetic)
In `cli/src/agent/DiracAgent.ts:2271–2277`, `sendAvailableCommands` sets `input: { hint: cmd.description }` on every slash command, causing Zed's slash-command popup to display the full description sentence a second time as the input argument placeholder.

### 5. `session/fork` (`sessionCapabilities.fork` / `unstable_forkSession`) Is Not Implemented
The ACP SDK defines `unstable_forkSession` (`session/fork`), gated by `sessionCapabilities.fork`. Dirac does not implement or advertise it, so Zed's "Fork thread" action is unavailable.

#### Architectural Constraints for Implementing `session/fork` Safely
A naive `fs.cp(tasks/<srcTaskId>, tasks/<newTaskId>)` + `replayLoadedSessionHistory` has three bugs that must be avoided if `session/fork` is implemented:
1. **Embedded task/session IDs and concurrency locking**: Copying a task directory while a prompt is in flight or without holding `withTaskHistoryInventoryLock` risks partial writes, and `newTaskId = String(Date.now())` can collide under rapid calls. Forking must synchronize with active session mutations (`runSessionRuntimeMutation`), allocate a collision-free task ID, and update the cloned `HistoryItem` (`id: newTaskId, ulid: newSessionId, ts: now`) under `withTaskHistoryInventoryLock`.
2. **Pre-first-prompt sessions**: A newly created ACP session has no backing `tasks/<taskId>` directory until the first prompt runs (`session.taskId` and `runtimeConfig.taskId` are `undefined`). Forking an unstarted session must simply clone `sessionOverrides` and `cwd` into a fresh `newSession`-style runtime record without attempting a task-directory copy.
3. **No `replayLoadedSessionHistory` on `session/fork`**: Per the ACP specification, `session/fork` returns `ForkSessionResponse` (`{ sessionId, modes, configOptions }`) and—like `session/resume`—does **not** stream historical `session/update` chunks back to the client (unlike `session/load`). Calling `replayLoadedSessionHistory` inside `AcpAgent.unstable_forkSession` would duplicate messages in the client's forked thread view; the journal should be copied on disk (`copySessionUpdates`) so a subsequent `session/load` on the forked session can replay it later, while `AcpAgent.unstable_forkSession` only subscribes to live events and schedules setup updates (matching `unstable_resumeSession`).

```text
SAFE session/fork LIFECYCLE:

  Zed ──session/fork({ sessionId: S1, cwd })──► AcpAgent.unstable_forkSession()
                                                  │
                                                  ▼
                                        DiracAgent.unstable_forkSession()
                                                  │
                    ┌─────────────────────────────┴─────────────────────────────┐
                    │ Has backing task T1?                                      │
                    ├─ YES ──► withTaskHistoryInventoryLock:                    │
                    │           1. Copy tasks/T1 -> tasks/T2                    │
                    │           2. Upsert HistoryItem { id: T2, ulid: S2, ts }  │
                    │           3. copySessionUpdates(S1 -> S2) on disk         │
                    │           4. setSessionRuntimeConfig(S2, { taskId: T2 })  │
                    │                                                           │
                    └─ NO  ──► setSessionRuntimeConfig(S2, { settings, cwd })   │
                                                  │
                                                  ▼
                                  Hydrate S2 via unstable_resumeSession(S2)
                                                  │
                                                  ▼
                         AcpAgent: subscribeToSessionEvents(S2)
                                   scheduleSessionSetupUpdates(S2)
                                   (NO replayLoadedSessionHistory!)
                                                  │
                                                  ▼
  Zed ◄──ForkSessionResponse({ sessionId: S2, modes, configOptions })───────────┘
```

## Zed-Side Caveat

Zed enabled `config_option_update` rendering by default in `zed-industries/zed#48350` ("acp: Remove feature flag for session config options", merged Feb 4, 2026). Zed builds older than that only render modes and slash commands regardless of what the agent sends.

## Fix Plan

Branch: `dev/acp-zed-gaps` (based on `origin/master`).

### Phase 1 — Low-Risk Capability & Category Fixes
1. **Advertise `sessionCapabilities.list: {}`** (`cli/src/agent/DiracAgent.ts:1198–1202`, `cli/src/agent/DiracAgent.worktree.test.ts:140`)
   - Add `list: {}` to `sessionCapabilities` in `DiracAgent.initialize()`.
   - Update the capability snapshot assertion in `DiracAgent.worktree.test.ts`.
2. **Recategorize `inference_speed` to `"model_config"`** (`cli/src/agent/sessionConfig.ts:234`, `cli/src/agent/sessionConfig.runtime.test.ts`)
   - Change `category: "model"` on `inference_speed` to `category: "model_config"`.
   - Assert `speed.category === "model_config"` in `sessionConfig.runtime.test.ts`.

### Phase 2 — Optional `session/fork` Support
3. **Implement `unstable_forkSession` and advertise `sessionCapabilities.fork: {}`** (`cli/src/acp/acp-session-updates.ts`, `cli/src/agent/DiracAgent.ts`, `cli/src/acp/AcpAgent.ts`)
   - Add `copySessionUpdates(sourceSessionId, targetSessionId)` in `acp-session-updates.ts` using per-session locks.
   - Implement `DiracAgent.unstable_forkSession(params)` handling both unstarted sessions (no `taskId`) and persisted sessions (cloning `tasks/<srcTaskId>` → `tasks/<newTaskId>`, upserting `TaskHistoryItem` with `ulid: newSessionId` under `withTaskHistoryInventoryLock`, and copying the session update journal).
   - In `AcpAgent.unstable_forkSession(params)`, delegate to `this.diracAgent.unstable_forkSession(params)`, call `this.subscribeToSessionEvents(response.sessionId)`, and `this.scheduleSessionSetupUpdates(response.sessionId)` (without replaying history).

## Testing Plan (Unit, Integration, and User Acceptance)

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Testing Pyramid                                 │
├──────────────────────┬───────────────────────────────────────────────────────┤
│ 1. Unit Tests        │ • sessionConfig.runtime.test.ts:                      │
│    (Vitest)          │   - inference_speed option has category "model_config"│
│                      │   - model option retains category "model"             │
│                      │ • DiracAgent.worktree.test.ts:                        │
│                      │   - initialize() advertises sessionCapabilities.list  │
│                      │     (and fork if Phase 2 is enabled)                  │
│                      │ • AcpAgent.test.ts:                                   │
│                      │   - delegates unstable_listSessions                   │
│                      │   - (Phase 2) delegates unstable_forkSession,         │
│                      │     subscribes to events, schedules setup updates,    │
│                      │     and does NOT call replayLoadedSessionHistory      │
├──────────────────────┼───────────────────────────────────────────────────────┤
│ 2. Integration Tests │ • DiracAgent.continuity.test.ts /                     │
│    (ACP Lifecycle)   │   acp-session-updates.test.ts:                        │
│                      │   - newSession -> prompt -> unstable_listSessions     │
│                      │     returns session with title, cwd, updatedAt        │
│                      │   - (Phase 2) fork unstarted session clones settings  │
│                      │     into independent sessionId                        │
│                      │   - (Phase 2) fork persisted session copies task dir, │
│                      │     journal, and HistoryItem; subsequent loadSession  │
│                      │     on forked sessionId replays copied journal        │
├──────────────────────┼───────────────────────────────────────────────────────┤
│ 3. User Testing      │ • Rebuild CLI (`npm run protos && npm run cli:build`) │
│    (Live in Zed)     │ • Open Zed Agent Panel -> Dirac External Agent        │
│                      │   - Verify Past Threads / History list opens & loads  │
│                      │   - Verify Mode, Provider, Model, Inference Speed,    │
│                      │     and Reasoning Effort selectors appear             │
│                      │   - (Phase 2) Click "Fork thread" and verify new      │
│                      │     independent session continues from forked point   │
└──────────────────────┴───────────────────────────────────────────────────────┘
```

### 1. Unit Tests
- **`cli/src/agent/DiracAgent.worktree.test.ts`**:
  - Verify `initialize()` returns `sessionCapabilities` containing `list: {}`, `resume: {}`, `close: {}`, `delete: {}` (and `fork: {}` if Phase 2 is included).
  - Command: `npm --prefix cli run test:run -- src/agent/DiracAgent.worktree.test.ts`
- **`cli/src/agent/sessionConfig.runtime.test.ts`**:
  - Verify `selectOption(options, "model").category === "model"` and `selectOption(options, "inference_speed").category === "model_config"`.
  - Command: `npm --prefix cli run test:run -- src/agent/sessionConfig.runtime.test.ts`
- **`cli/src/acp/AcpAgent.test.ts`** (Phase 2):
  - Verify `AcpAgent.unstable_forkSession` delegates to `DiracAgent.unstable_forkSession`, subscribes to the forked `sessionId`, schedules setup updates, and does **not** invoke `replayLoadedSessionHistory`.
  - Command: `npm --prefix cli run test:run -- src/acp/AcpAgent.test.ts`

### 2. Integration Tests
- **End-to-End Session Listing & Config Propagation (`cli/src/agent/DiracAgent.continuity.test.ts`)**:
  - Create a session via `newSession`, run a prompt turn, and invoke `unstable_listSessions({ cwd })`; verify the returned `SessionInfo` list includes the session with its summarized `title` and `updatedAt`.
  - Switch `inference_speed` via `setSessionConfigOption` and verify the emitted `config_option_update` preserves `category: "model_config"`.
- **Session Fork Isolation (`cli/src/agent/DiracAgent.continuity.test.ts`, Phase 2)**:
  - Fork an unstarted session (before first prompt) and verify mutating config options on the forked session does not mutate the parent session.
  - Fork a persisted session (with task history and `acp-session-updates` journal), verify `tasks/<newTaskId>` and `acp-session-updates/<newSessionId>.jsonl` are created on disk, and verify calling `loadSession({ sessionId: newSessionId })` replays the forked journal independently.
- **Static & Architecture Gate**:
  - `npm run typecheck:cli && npm run check:arch && npm run lint`

### 3. User Acceptance Testing (Live in Zed)
1. **Build the CLI bundle used by Zed**:
   - Run `npm run protos && npm run cli:build` so `cli/dist/cli.mjs` includes the changes.
2. **Verify Past Threads / Session List (`sessionCapabilities.list`)**:
   - In Zed, open the Agent Panel with the **Dirac** external agent and open the **History / Past Threads** drawer.
   - Confirm your past Dirac ACP sessions for the workspace are listed with their titles and timestamps, and clicking a past thread loads its conversation history.
3. **Verify Config Selectors (`inference_speed` category `"model_config"`)**:
   - Select a provider/model that supports inference speed (`openai-codex` or `anthropic` with a fast-capable model).
   - Confirm **Inference Speed** renders alongside the model configuration controls without colliding with the primary **Model** selector.
4. **Verify Thread Forking (`sessionCapabilities.fork`, if Phase 2 is enabled)**:
   - In an active Dirac thread in Zed, trigger **Fork Thread**.
   - Confirm a new thread opens immediately without duplicating existing message bubbles, and sending a follow-up prompt in the forked thread does not alter the original thread.

## Follow-Up Fixes Required on Current Implementation

### Blocking Bugs in `DiracAgent.unstable_forkSession` and `copySessionUpdates`

| # | Location | Bug | Required Fix |
|---|---|---|---|
| **1** | `DiracAgent.ts:1514` | `const newSessionId = params.sessionId ?? crypto.randomUUID()` reuses the **source** `params.sessionId` (which is always defined in `ForkSessionRequest`), overwriting the source session in `this.sessions`, `this.acpSessionOverrides`, `acp-session-runtime-configs`, and self-appending `copySessionUpdates(S1, S1)`. | Always allocate a fresh UUID: `const newSessionId = crypto.randomUUID()`. |
| **2** | `DiracAgent.ts:183–185` | `taskDirectory(taskId)` resolves `path.join(process.cwd(), "..", "..", "..", "..", "..", "data", "tasks", taskId)` instead of `this.ctx.DATA_DIR`. Under Zed, `process.cwd()` is the user workspace, causing `fs.cp` to fail with `ENOENT`. | Resolve via `path.join(this.ctx.DATA_DIR, "tasks", taskId)` (or `getTaskDirectoryPath(this.ctx.DATA_DIR, taskId)`). |
| **3** | `DiracAgent.ts:1569–1585` | `unstable_forkSession` never registers `this.sessionStates.set(newSessionId, { sessionId: newSessionId, status: AcpSessionStatus.Idle, pendingToolCalls: new Map() })` and never persists `writeSessionRuntimeConfig` for unstarted sessions. Any subsequent `prompt()`, `emitConfigOptionsUpdate()`, or `setSessionConfigOption()` on the forked session either silently no-ops or throws `Session not found` in `runSessionRuntimeMutation`. | Register `this.sessionStates.set(newSessionId, ...)` and call `this.persistSessionOverrides(newSessionId)` on both the persisted-task and unstarted-session paths. |
| **4** | `DiracAgent.ts:1569–1575` | Even after copying `tasks/<srcTaskId>` to `tasks/<newTaskId>`, `session` is constructed without `isLoadedFromHistory: true`, `loadedTaskId: newTaskId`, or `taskId: newTaskId`. On the first prompt in the forked session, `prompt()` (`DiracAgent.ts:1828–1898`) takes the `else` branch and calls `controller.initTask(...)`, creating a **brand-new empty task** and discarding the forked conversation history. | When `newTaskId` is created, set `isLoadedFromHistory: true, loadedTaskId: newTaskId, taskId: newTaskId` on `session` and call `await controller.getTaskWithId(newTaskId)`. |
| **5** | `acp-session-updates.ts:680–698` | **Two defects in `copySessionUpdates`**:<br>1. `readJournalEntries(journalFilePath(sourceSessionId))` runs **without** holding `sessionLockDirectory(sourceSessionId)`.<br>2. The renumbering formula `nextSequence - sourceEntries.length + entry.sequenceNumber` uses raw `entry.sequenceNumber` (not the 0-based `index`) and leaves inner `entry.update._meta["dev.dirac/seq"]` / `entry.annotation._meta["dev.dirac/seq"]` un-updated. If the source journal was ever compacted (`compactIfNeeded` drops leading entries so `sourceEntries[0].sequenceNumber > 1`) or `existingLastSequence > 0`, the formula produces out-of-order or gapped sequences and inner `_meta["dev.dirac/seq"]` diverges from outer `entry.sequenceNumber`. | 1. Read `sourceEntries` inside `withLock(sessionLockDirectory(sourceSessionId), ...)` (releasing before acquiring the target lock to avoid lock-order deadlock, and guarding `if (sourceSessionId === targetSessionId) throw`).<br>2. Renumber by array `index` (`const seq = existingLastSequence + index + 1`) and stamp `[SEQUENCE_META_KEY]: seq` onto both the outer `entry.sequenceNumber` and the inner `entry.update._meta` / `entry.annotation._meta`. |

### Secondary Refinements, Test Coverage & Hygiene

- **Synchronize fork against active source mutations (`DiracAgent.ts:1502`)**:
  - Wrap the source read/copy in `this.runSessionRuntimeMutation(sourceSessionId, async () => ...)` and reject if `this.sessionStates.get(sourceSessionId)?.status === AcpSessionStatus.Processing` so `fs.cp` cannot copy a half-written task directory mid-turn.
- **Include `modes` in `ForkSessionResponse` (`DiracAgent.ts:1582`)**:
  - Return `modes: this.sessionConfig.getSessionModeState(session.mode, newOverrides)` alongside `sessionId` and `configOptions` so Zed initializes the mode selector on the forked thread.
- **Fix untitled session fork label (`DiracAgent.ts:1535`)**:
  - `sourceSession.title ?? \`Fork of ${sourceSession.title ?? sourceSessionId.slice(0, 8)}\`` evaluates inner `sourceSession.title` when it is already known to be `undefined`. Use `sourceSession.title ? \`Fork of ${sourceSession.title}\` : \`Fork of ${sourceSessionId.slice(0, 8)}\``.
- **Support forking persisted (unloaded) sessions (`DiracAgent.ts:1504`)**:
  - Fall back to `getSessionRuntimeConfig(this.ctx.DATA_DIR, sourceSessionId)` and `resolveHistorySession(sourceSessionId, ...)` when `this.sessions.get(sourceSessionId)` is undefined so users can fork a past session directly from Zed's history list without loading it first.
- **Add missing `unstable_forkSession` mock & unit tests**:
  - `cli/src/acp/AcpAgent.test.ts` (`mocks.diracAgentInstance`) does not yet mock `unstable_forkSession` or test `AcpAgent.unstable_forkSession`.
  - `cli/src/acp/acp-session-updates.test.ts` has no test for `copySessionUpdates` (including compacted source journals where `sequenceNumber` starts > 1).
  - `cli/src/agent/DiracAgent.continuity.test.ts` has no test for `DiracAgent.unstable_forkSession`.
- **Revert unrelated Biome formatting drift before committing**:
  - Approximately 300 unrelated files have staged formatting/import-order changes; reset the index and stage only the functional files (`cli/src/agent/DiracAgent.ts`, `cli/src/agent/sessionConfig.ts`, `cli/src/acp/AcpAgent.ts`, `cli/src/acp/acp-session-updates.ts`, their unit tests, and `dev/acp-zed-gaps/ISSUE_AND_RCA.md`).


