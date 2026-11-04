# Goal tasklet migration — phase 6

## Status and scope

**6.1: completed and contract approved.** No Goal
execution, storage or public tool behavior has changed. Next is 6.2's approved
new-format storage boundary; there is no legacy conversion project.

This is the tracked phase-6 audit and implementation breakdown. It supplements
the local `ascratch/docs/tasklet-design-and-migration.md` decision record; it does
not override its approved decisions. D32–D34 below record the user's phase-6
approval. The scratch documents remain ignored and are not force-added to Git.

The user authorized sequential work: execute one numbered item, verify it, commit
it, then move to the next. That authorizes the engineering work and commits, not
unspecified legacy-data or product behavior. Relevant tests are authorized by D27.
The fork-compatibility issue is a separate task, not part of Goal migration.

## Established contract — not questions to reopen

- A Goal is the durable root. The coordinator Task owns the existing TaskletHost
  under GoalLoop's lifecycle ownership. Each coordinator or explicit follow-up
  execution can reconstruct a fresh host using the same Goal-root storage.
- Children use the existing Task engine, reserved tasklet IDs and independent
  artifacts at `tasks/<goal-id>/tasklets/<tasklet-id>/`. They have no independent
  top-level history, selection or lock ownership.
- Only root executions delegate. Tasklets cannot recursively spawn children or
  acquire the coordinator's Goal-control capabilities.
- Communication and tool/runtime interactions go through the shared counterparty
  boundary. The parent decides under its current authority; user escalation
  authorizes only the requested operation.
- Closing the root interrupts and settles contained execution and persistence
  before ownership release. Reconstruction does not restart children or replay
  work. Explicit resumption retains the handle and conversation, retires old
  requests, and adds the brief default resumption line plus parent guidance.
- Completion is rejected immediately while a child is active. Goal achievement,
  blocking, objective revisions and pursuit lifecycle remain GoalLoop concerns.
- Explicit Goal follow-up work does not resume pursuit or change the durable Goal
  status. Child completion cannot achieve or block the Goal.
- Keep explicit `verify_goal`; do not restore automatic completion verification.
  Verification assignment construction belongs in its tool module, not a host.
- One host owns supervision. Goal summaries and accounting are projections, not
  a second child registry, event supervisor or accounting service.

## Source audit

References describe checkout `82160f2e`; line numbers may move during migration.
These are source-inspection findings, not runtime reproductions.

| Area | Current source and integration requirement |
|---|---|
| Root identity and construction | `src/core/goal/GoalLoop.ts:214` reconstructs coordinator/follow-up Tasks under the same Goal ID and conversation ULID, but also constructs a separate GoalTaskHost. `src/core/task/index.ts:1070,1746` currently limits TaskletHost ownership to standalone roots. Extend the existing owner binding; remove the parallel Goal child supervisor at cutover. |
| Environment isolation | `src/core/task/index.ts:1105,1984` forwards construction options to children. `src/core/goal/GoalCoordinatorEnvironment.ts:42–65` adds the Goal trait to its environments. A tasklet must not inherit that coordinator factory: `respond complete` would otherwise call the Goal completion path. Use the normal shared private child environment. |
| Shutdown and ownership | `src/core/goal/GoalLoop.ts:281–325` currently releases ownership in a `finally`, including after child shutdown failure. Preserve the shared tasklet guarantee: retain ownership if contained execution/persistence has not retired. Distinguish that from a final Goal metadata-transition error after execution has safely settled. Task's non-standalone settlement path also needs host-aware ordering (`src/core/task/index.ts:1464–1551`). No recovery framework or general drain is needed. |
| Interaction routing | `src/core/goal/GoalTaskEnvironment.ts` wraps cards and retains local auto-approval behavior; `GoalTaskHost.ts:383–420` resolves permission choices without the shared current-parent ceiling. Replace these paths with the existing tasklet messenger/authorization boundary. Keep Goal `working`/`waiting` transitions around genuine user escalation via GoalLoop's existing interaction callback, not child-local waiting. |
| Public controls | `IGoalTrait` in `src/core/task/tools/interfaces/IToolEnvironment.ts:386–408` duplicates spawn/list/steer/cancel/transcript/resolve/wait. Shared TaskletControls already provides these plus same-handle resume and voluntary sleep. The old tools have different status, pagination and cancellation contracts, so retaining or removing them is a public-interface decision. |
| Actual exposure | `TaskExecutionProfile.ts:30`, `OrchestrationTraitBuilder.ts:10`, `use_subagents/tool.ts:15` and parent prompt generation exclude Goal roots. Goal-only discovery currently exposes tools to coordinators, not follow-ups (`discovery/DiscoveredTool.ts:14–17`), despite follow-up instructions promising delegation. Test actual schemas and dispatch, not prompt wording alone. |
| Execution defaults | `GoalTaskFactory.ts:101–116` disables legacy child hooks; `start_task` has no default deadline. Shared tasklets inherit current parent configuration and use the shared 600-second default timeout. D30 already settles interruption at a deadline, but adopting these Goal defaults must be explicit. |
| Legacy identity and artifacts | `GoalTaskHost.ts:40–42,97–135` creates canonical timestamp child Task IDs and separate top-level directories. `src/shared/goal.ts:18–30` lacks the prompt, conversation ULID, configuration and usage needed for a complete tasklet record. Resumable conversion requires actual artifact recovery and historical-ID association; it is not just moving directories. Legacy context can also live under the historical home-data path instead of HostProvider storage (`tools/context/DiracContext.ts:59–67`). |
| Legacy events | Goal events reference private response cards and delivered cursors (`src/shared/goal.ts:48–84`; `GoalTaskHost.ts:188–249,627–661`). Tasklet events retain full communication and request state. A legacy conversion must explicitly preserve or retire unread communications as approved, never replay tools or revive requests. Goal startup recovery currently clears event state; conversion must not destroy required source data first. |
| Accounting | `GoalLoop.ts:225–235,641–729` tracks separate child/verification primary and Utility sources; shared tasklets contribute lifetime snapshots to root metrics. Counting both duplicates spend. Preserve historical incurred usage, known zeroes and unknown fields once across reconstruction and explicit reopening. |
| History and deletion | `TaskHistoryController.ts:33–52` locks/deletes legacy child IDs separately. History repair excludes those IDs via Goal records (`repairMissingTaskHistory.ts:60–69,90–121,155–164`). Preserve that protection while legacy directories exist; tasklet IDs cannot be passed as canonical top-level Task IDs. Nested tasklet deletion falls under the settled Goal root. |
| Schema and display | `validateGoalRecord.ts:303–335` strictly validates the current version-1 Goal record. Deliberately evolve format handling; do not revive already-superseded schemas. GoalViewState/CLI/webview consume child summaries, pending counts and latest verification; derive them from the shared mechanism without another authoritative runtime registry. |

## Approved phase-6 decisions

Approval reference: after reviewing the shared-controls/shared-defaults proposal
and three explicit legacy-data options, the user selected **“Shared contract +
clean break.”** These decisions close P6-Q1–Q3; the other compatibility options
were considered and not selected.

### D32 — Shared public tools and root eligibility

- Use generic/named asynchronous spawning and `tasklets` supervision for
  executing Goal coordinators and explicit follow-up turns, just as for ordinary
  roots. Honor the same `subagentsEnabled` setting for generic/named spawning.
- Remove the seven superseded Goal supervision tools: `start_task`, `list_tasks`,
  `send_task_message`, `cancel_task`, `read_task_transcript`,
  `resolve_task_interaction` and `wait_for_goal_events`. No legacy control adapter.
- Retain Goal-specific `verify_goal`, `update_goal`, `block_goal` and Goal
  completion semantics. Explicit verification remains a Goal operation and starts
  an ordinary contained tasklet through the environment.
- Lift the temporary Goal delegation restriction at the complete public cutover,
  not merely when backend hosting becomes possible. Children still cannot spawn.

### D33 — Shared tasklet execution defaults

Inherit current parent configuration, including hook settings. Use the existing
shared default 600-second per-execution deadline with supported overrides. A
deadline interrupts; resumption is explicit and receives a new execution deadline
(D30). Do not carry forward the legacy disabled-hook/no-default-deadline policy.
Goal pursuit retains its Act-only semantics.

### D34 — Clean break for existing Goal runs

- Support newly created, new-format Goals only. Explicitly reject execution or
  reopening of old Goal records with an actionable compatibility error.
- Leave old Goal files, child directories, transcripts, event state and accounting
  untouched by this migration. No automatic conversion, deletion, event import,
  child resumption or reconstruction of missing legacy conversation data.
- Preserve exclusion of old private children from ordinary top-level history and
  repair. Identifying historical ownership for that exclusion is not execution
  compatibility or a second child supervisor.
- Do not reinterpret old files as a new Goal, automatically mutate them during
  startup recovery, or revive pending requests/work. Existing files are not a
  promise of an in-product legacy inspection/continuation feature.
- The migration itself does not delete old data. Existing explicit user-requested
  deletion semantics remain a separate operation; do not add automatic cleanup.

This supersedes phase 6's earlier unresolved legacy-conversion question. Historical
or full resumable conversion and preservation of the old control protocol are not
part of the approved work. Exact format tags and rejection/ownership-reader
implementation are engineering details within these guarantees.

## Ordered implementation and commit boundaries

| Item | Scope and completion evidence | Status |
|---|---|---|
| 6.1 — Contract/source audit | Source audit and D32–D34 approval; finalized dependent split. Documentation only. | Completed |
| 6.2 — Storage/restoration boundary | Distinguish new-format Goals from old runs; reject legacy execution/reopening and keep startup from rewriting old files. Preserve old child history exclusions and explicit deletion ownership. Verify real temporary-storage preservation/rejection, malformed/current records and new-format storage. No importer, public cutover or legacy child resumption. | Not started; follows the 6.1 commit |
| 6.3 — Execution/lifecycle | Attach coordinator/follow-up Tasks to their own existing host with child-safe environment bindings. Verify pause/stop/resume, follow-up status preservation, completion/block guards, natural failures and lock/shutdown ordering. | Not started; depends on 6.2 |
| 6.4 — Supervision/public cutover | Use shared interactions, events, escalation, controls and accounting; retain Goal-specific verification/objective/lifecycle work and derived presentation. Remove superseded GoalTaskHost/environment ownership. Verify actual inventories and public dispatch. | Not started; depends on 6.3 |
| 6.5 — Integrated acceptance/cleanup | Compose real Goal-root/child scenarios, restored data, permissions, accounting, selection/deletion and frontend behavior; remove remaining dead paths. Record controlled-provider, rendered and application evidence separately. | Not started; depends on 6.4 |

D34 removes the need for legacy artifact, event or accounting conversion. New
contained handles and transcripts reuse existing tasklet storage/restoration; any
Goal-specific projection fields needed by 6.4 remain data, not another owner.

Each implementation item includes focused tests, relevant builds/typechecks/lint,
`npm run check:arch` and a checked diff before committing. Intermediate commits
must compile; they need not expose an independently releasable feature. Do not
weaken architecture baselines or postpone all verification to 6.5.

## Acceptance coverage to retain and extend

- Goal lifecycle/controller/ownership tests: coordinator and follow-up root locks,
  final persistence, selection/disposal/deletion and failure-specific ownership.
- Shared TaskletExecution/Reopening/PublicControls tests: actual Task execution,
  same-handle resume, no automatic restart, retired requests, sibling progress,
  active-child completion rejection and unconditional user-message sleep wake.
- Current-parent authorization, pending permission revocation, operation-scoped
  escalation and runtime recovery; a child cannot obtain Goal-control traits.
- GoalAccounting and TaskletUsage tests: repeated restoration/reopening does not
  lose or duplicate primary/Utility spend or change unknown-field semantics.
- D34 clean break: old Goals cannot execute/reopen, startup does not mutate their
  files, and old private child directories never become top-level history. No
  importer or fabricated restoration. New contained deletion settles writes first.
- Explicit verification objective/focus, role/latest-verification summaries and
  ordinary Goal completion without a hidden verification gate.
- Actual coordinator/follow-up inventories, generic/named dispatch, root-only
  controls and child exclusion. Render existing Goal summary/header and shared
  tasklet cards with stable IDs and parent-first interactions.

## Verification performed for 6.1

Read-only source/test inspection and three focused independent audits against the
same checkout. Retired synchronous-executor names appear only in tests/negative
fixtures in the source audit, not production paths. No tests, builds, application
runs or new architecture-check results are claimed for this documentation-only
item. A follow-up read-only review found no blocking issues; whitespace checks
pass. Existing phase-5 verification is historical evidence, not a new run.
