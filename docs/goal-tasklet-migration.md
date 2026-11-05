# Goal tasklet migration — phase 6

## Status and scope

**Phase 6 complete.** 6.1: `6606ef65`; 6.2: `481d1858`; 6.3: `26b5ada9`;
6.4: `d3a16d56`; 6.5: integrated acceptance and cleanup recorded in this commit.
Goal coordinators/follow-ups use their Task-owned shared host and public controls.
The legacy Goal supervisor, private child environment and seven superseded tools
are removed. D32–D34 are implemented and verified within the evidence boundaries
below; no live-provider or launched-VS-Code acceptance is claimed.

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
| 6.1 — Contract/source audit | Source audit and D32–D34 approval; finalized dependent split. Documentation only. | Committed `6606ef65` |
| 6.2 — Storage/restoration boundary | Version-2-only execution; read-only legacy ownership; rejection and byte preservation through startup, history/prompt reconstruction and selection; explicit root/private-child deletion. No importer or public cutover. Evidence below. | Committed `481d1858` |
| 6.3 — Execution/lifecycle | Attach coordinator/follow-up Tasks to their own existing host with child-safe environment bindings. Verify pause/stop/resume, follow-up status preservation, completion/block guards, natural failures and lock/shutdown ordering. | Committed `26b5ada9` |
| 6.4 — Supervision/public cutover | Use shared interactions, events, escalation, controls and accounting; retain Goal-specific verification/objective/lifecycle work and derived presentation. Remove superseded GoalTaskHost/environment ownership. Verify actual inventories and public dispatch. | Committed `d3a16d56` |
| 6.5 — Integrated acceptance/cleanup | Compose real Goal-root/child scenarios, restored data, permissions, accounting, selection/deletion and frontend behavior; remove remaining dead paths. Record controlled-provider, rendered and application evidence separately. | Complete; evidence below |

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

## Verification performed for 6.2

- New `GoalLegacyBoundary` real temporary-storage tests cover version-2
  creation/mutation/recovery; actionable version-1 and superseded-schema rejection;
  unchanged Goal, event/accounting, transcript and binary-context bytes; startup,
  repair, direct reconstruction and corrupt-index recovery; prompt-history reads;
  actual indexed-history selection; non-disruption of an existing coordinator;
  explicit legacy/nested deletion and child-lock failure; malformed/unsafe ownership.
- Historical ownership discovery retains safe private siblings even when another
  reference is invalid, reports the failure, and keeps explicit deletion strict
  and all-or-nothing before any file removal. Discovery never loads transcripts.
- Shared history deletion and ACP session deletion still acquire the complete
  ownership set before removing storage/worktrees. Existing indexed private runs
  are rejected before retiring the current foreground execution.
- **102 backend tests pass**, no failures/skips: every Goal suite, task-history
  repair/containment, workspace history/prompt handling and TaskController lifecycle.
  **20 CLI tests pass**, no failures/skips: session deletion/worktrees and prompt
  history. These include 14 new backend boundary tests, two new ACP deletion tests,
  and a current-format Goal prompt regression. Logs:
  `/tmp/dirac-62-tests.log`, `/tmp/dirac-62-cli-tests.log`.
- `npm run compile` (protobufs, four typechecks, lint/proto lint, extension build),
  `npm run cli:build`, `npm run check:arch` and `git diff --check` pass. Architecture
  baselines remain unchanged, with zero new violations. Logs:
  `/tmp/dirac-62-{compile,cli-build,arch}.log`.
- Independent review found and prompted the safe-sibling fix, updated prompt-test
  dependencies and the indexed-selection preflight. Focused follow-up review found
  no remaining blockers; its evidence is source inspection, not another test run.
- Separate accounting transport selection: two pass, one unchanged
  `unavailable accounting` assertion fails on undefined properties versus `{}`.
  The same failure was reproduced using the HEAD test loaded in memory with
  unchanged production dependencies (`/tmp/dirac-62-transport-baseline.log`). It is
  not counted as passing coverage or fixed by this storage item.
- No child runtime migration, provider/application execution, rendered UI, live
  network, data importer or automatic legacy cleanup is claimed. New-format Goal
  execution still uses the interim runtime until 6.3/6.4 complete the cutover.

## Verification performed for 6.3

- Coordinator/follow-up Tasks construct the existing shared host, storing private
  child conversations beneath the Goal root. Goal environment factories are never
  inherited by those children; ordinary standalone test/custom bindings remain
  unchanged. The shared default deadline remains 600 seconds.
- GoalLoop joins actual coordinator persistence retirement as well as interim
  legacy-host shutdown before releasing ownership. A failed contained outcome write
  retains the runtime/root lock; a final Goal metadata transition failure after safe
  retirement still releases it. Removed the legacy host's redundant blanket Goal
  cleanup write; registered child outcomes/interactions still settle normally.
- Goal completion and blocking reject active and acceptance-pending children.
  Successful terminal commits synchronously close shared admission, including a
  tested start racing the intervening legacy guard. Ordinary root follow-up behavior
  is unchanged.
- **223 backend tests pass**, no failures/skips: all Goal suites plus real Tasklet
  execution, host and persistence-ownership suites. New composed real GoalLoop,
  GoalTaskFactory and Task cases verify safe child environments, pause/stop waiting
  for final writes, failed-write ownership retention, fresh-host reconstruction with
  no automatic child restart, explicit same-handle child resumption, paused/achieved
  follow-up status preservation and terminal guards/admission. Focused ownership
  tests separately cover natural failure, failed retirement and metadata failure.
  Provider/checkpoint/host resources are controlled, not live-network or application
  evidence. Log: `/tmp/dirac-63-tests.log`.
- Unit-test TypeScript checking, full `npm run compile`, `npm run cli:build`,
  `npm run check:arch` and `git diff --check` pass. Architecture baselines are
  unchanged with zero new violations. Logs: `/tmp/dirac-63-unit-types.log`,
  `/tmp/dirac-63-{compile,cli-build,arch}.log`.
- Independent review identified the redundant cleanup-write and block/start race;
  both were fixed with regressions. A focused follow-up review found no remaining
  blockers; that review was source inspection, not an extra test run.
- Public Goal delegation/inventories, shared user escalation/status callbacks,
  accounting/projections and removal of GoalTaskHost/Goal child environments remain
  6.4. No rendered UI, CLI application/PTY or live-provider execution is claimed for
  this backend lifecycle item. The separately baseline-confirmed accounting transport
  assertion from 6.2 remains outside this passing selection.

## Verification performed for 6.4

- Coordinator and explicit follow-up inventories/dispatch use shared generic or
  named asynchronous spawning and `tasklets` supervision. Disabling subagents
  rejects generic/named spawn dispatch as well as hiding schemas; existing handles
  remain supervisable. Private tasklets have neither delegation nor Goal controls.
- Removed GoalTaskHost, GoalTaskEnvironment, the `goal_child` execution profile and
  all seven old control-tool modules. Goal records contain lifecycle/objective and
  replaceable accounting projections, not a second children/events registry. Raw
  read-only historical ownership remains for D34 privacy and explicit deletion.
- `verify_goal` builds its objective/revision, existing-handle and focus assignment
  in its own module and accepts an ordinary tasklet with an atomic purpose marker.
  Completion has no implicit verification gate. Goal summaries derive live or
  disk-only tasklet data without reconstructing a host or inventing live status,
  durations or successful settlement. All pending requests are counted.
- Genuine shared user escalation updates pursuing Goal waiting/working status;
  private child questions do not. Paused/achieved follow-up status never changes.
  Current-parent permission revocation and operation-scoped escalation remain in
  the shared boundary. Terminal admission and failed-retirement ownership remain
  covered after removal of the legacy host.
- Root metrics include each child's replaceable lifetime primary/Utility snapshot
  once; root Utility remains per-execution. Durable usage knowledge distinguishes
  unavailable values from known zeroes, survives stale transcript restoration and
  same-ID resumption, and does not fabricate zero usage from unobserved retries or
  checkpoint archives. Legacy shared records do not acquire invented knowledge.
- Independent review found silent child termination could leave unbounded parent
  sleep pending. Shared settlement now publishes a durable host outcome event in
  the existing channel (not a fabricated agent response), including silent failure
  and deadline interruption. Filtering, acknowledgement, repeated reconstruction
  and fresh notifications on explicit resume have regressions. In-memory removal
  reproduces all three silent-outcome failures. Review also found the stale-prefix
  knowledge and empty-archive defects above; both were reproduced and fixed.
- **421 backend tests pass**, no failures/skips in the final combined selection:
  every retained Goal suite, real Tasklet execution, shared host/reopening/public
  controls, durable usage/availability/checkpoints, root persistence ownership,
  profile eligibility, real tool dispatch/inventories and accounting transports.
  Log: `/tmp/dirac-64-final-tests.log`. Earlier focused selections additionally
  covered profile/architecture/completion/prompt regressions; they overlap and are
  not added to this count. **7 CLI and 7 webview Goal rendering tests pass**;
  logs: `/tmp/dirac-64-cli-goal-summary.log`,
  `/tmp/dirac-64-webview-goal-header.log`.
- Full `npm run compile`, unit-test TypeScript checking, fresh `npm run cli:build`,
  full webview build, `npm run check:arch` and whitespace checks pass. Architecture
  baselines are unchanged. Goal projection functions remain in the existing
  GoalLoop module rather than adding a cyclic module. Logs:
  `/tmp/dirac-64-final-{compile,unit-types,cli-build,arch}.log`,
  `/tmp/dirac-64-cleanup-webview-build.log`.
- The old unavailable-accounting transport assertion now checks optional fields
  individually and passes; production transport behavior was unchanged. Other
  separately baseline-reproduced failures remain excluded: ToolRegistry priority
  replacement, ToolExecutor permission-binding onUsage expectation and three
  SurfaceAdapter cases. Logs: `/tmp/dirac-64-registry-baseline.log`,
  `/tmp/dirac-64-request-runtime-baseline.log`,
  `/tmp/dirac-64-surface-baseline.log`. They are not claimed as passing coverage.
- Controlled providers and host resources support the composed runtime evidence;
  rendered component tests are separate. No live-provider or real CLI application
  Goal scenario is claimed yet; the latter remains 6.5. An initial combined test
  launch raced protobuf regeneration and was rerun after both builds completed;
  the missing generated files were a verification-order failure, not a source fix.

## Verification performed for 6.5 — final phase-6 acceptance

- **Two real CLI application/PTY scenarios pass** against the freshly rebuilt CLI
  with the isolated deterministic loopback provider: ordinary root (189.7 seconds)
  and `/goal` root (162.6 seconds). Both cover asynchronous sibling acceptance,
  private questions, parent sleep/user wake, mixed sibling progress, parent answer
  delivery, full private results/transcripts, completed same-ID child resumption
  and stable Agents-panel previews. Logs:
  `/tmp/dirac-65-{standalone,goal}-final-pty.log`.
- The Goal remains `working` while children privately await the parent, and explicit
  root completion achieves it without an automatic verification gate. Top-level
  directories/history contain only the root. A new CLI process selects the saved
  root with the provider stopped; browsing neither restarts children nor changes
  the child records, events or conversation/presentation transcript bytes. The
  achieved Goal record also remains byte-identical.
- Removed the unused Goal-only transcript pager and its now-unreachable tests.
  Shared tasklet transcript controls remain covered. Removed retired
  `resolve_task_interaction` composer passthroughs from CLI and webview. Actual
  shared escalation cards are answered by root card identity, not treated as Goal
  steering. Updated rendered regressions cover both ordinary and Goal escalation.
  The tool-configuration fixture now uses retained `verify_goal`; a stale expected
  `Current config:` capitalization was corrected without changing production output.
- **396 backend tests pass**, no failures/skips, after the cleanup: every retained
  Goal suite plus real Tasklet execution, shared host/reopening/public controls,
  usage/availability/checkpoints, persistence ownership, inventories/dispatch and
  accounting transports. This rechecks the controlled-provider Goal compositions
  from 6.3/6.4, including coordinator/follow-up authorization and escalation,
  pause/stop/final-write ownership, explicit restoration, once-only accounting and
  D34 selection/history/deletion. Log: `/tmp/dirac-65-backend-tests.log`.
- **43 CLI tests pass** in five files: ChatView/GoalSummary rendering and routing,
  tool configuration, ACP deletion/worktrees and prompt-history storage.
  **16 webview tests pass** in two files: shared interaction routing and GoalHeader
  rendering. Logs: `/tmp/dirac-65-{cli,webview}-tests.log`. These are focused
  selections, not additive counts with earlier phase runs or universal suite green.
- Full compile (protobufs, all production typechecks, lint/proto lint, extension
  build), unit-test TypeScript checking, fresh CLI build and full webview build
  pass. Architecture checks pass with zero new violations and unchanged baselines;
  syntax/whitespace checks pass. Logs:
  `/tmp/dirac-65-{compile,unit-types,cli-build,webview-build,arch}.log`.
  Independent read-only review of this acceptance/cleanup diff found no actionable
  findings; it did not run additional tests or builds.
- The application scenarios establish question resolution and completed-child
  reopening, not permission escalation, interrupted-child reopening or active-child
  reconstruction in a launched UI. Those guarantees are covered by controlled
  backend compositions; component tests separately verify rendering/routing. No
  live-provider or launched VS Code run is claimed. Previously baseline-confirmed
  broader-suite failures listed under 6.4 remain excluded, not passing results.
- **No numbered phase-6 implementation items remain.** Old Goal artifacts are not
  converted or automatically deleted. Fork compatibility remains a separate task;
  this acceptance does not claim a fix for it.
