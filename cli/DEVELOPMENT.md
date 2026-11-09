# Developing the Dirac CLI

The CLI is the terminal host for Dirac. It reuses the core controller, task loop, providers, tools, and storage while implementing terminal-specific input, rendering, approvals, and process lifecycle behavior.

## Requirements

- Node.js 22.13 through 24.x
- npm
- The repository dependencies installed from the repository root

Node.js 20 cannot load the current `node:sqlite` dependency, and Node.js 25 is intentionally unsupported.

## Build and run

Run repository scripts from the repository root:

```bash
npm run install:all
npm run cli:build
node cli/dist/cli.mjs --help
```

`npm run cli:build` generates protobuf bindings, type-checks the CLI, bundles the executable and library entry points, and emits declarations. Use `npm run cli:build:production` for a minified production bundle.

For iterative development:

```bash
npm run protos
npm run cli:watch
```

The watch process rebuilds source changes. Run `node cli/dist/cli.mjs` in another terminal. Global linking is optional and is not required to build, run, or test the CLI.

## Verification

```bash
npm run cli:build
npm run cli:test -- --run
npm run lint
```

CLI tests use Vitest. The suite includes interactive Ink rendering, standalone execution and stream contracts, parser behavior, task resumption, ACP conformance, and the public library surface. Some ACP tests create local Unix sockets, so the environment must allow temporary socket creation.

For persistent terminal interaction and deterministic built-CLI regressions, use the [PTY harness](../tests/e2e/cli/README.md): `npm run cli:tui -- start` for interactive control, or `npm run test:e2e:cli:tui` after rebuilding. Its default local fixture does not use live model credentials.

## Runtime paths

The CLI deliberately has two rendering paths:

1. Interactive mode renders the React/Ink interface when stdin and stdout are TTYs.
2. Standalone mode runs without Ink when `--yolo` or `--json` is set, stdin is piped, stdin is redirected, or stdout is redirected.

`--auto-approve-all` is the interactive auto-approval option. `--yolo` always selects standalone mode. In standalone text mode stdout is reserved for the final result, while diagnostics and progress go to stderr. JSON mode emits newline-delimited events on stdout.

Changes to task startup, resumption, approvals, rendering, cleanup, or output must be checked in both paths. Never assume an Ink component affects standalone execution or that a plain-text formatter affects the TUI.

## Architecture

```text
cli/src/index.ts
  command definitions and lazy command dispatch
          |
          +-- cli/src/commands/
          |     auth, config, history, task, resume, welcome, kanban
          |
          +-- cli/src/components/ and cli/src/hooks/
          |     interactive React/Ink UI
          |
          +-- cli/src/utils/plain-text-task.ts
          |     standalone task lifecycle and stream contract
          |
          +-- cli/src/acp/
          |     Agent Client Protocol host and detached server
          |
          +-- cli/src/agent/
                embeddable agent/session API

All paths initialize and communicate with the shared core controller and task engine.
```

Important files and directories:

| Path | Responsibility |
| --- | --- |
| `cli/src/index.ts` | Commander option definitions and top-level routing |
| `cli/src/commands/task.ts` | Shared task initialization and interactive/standalone selection |
| `cli/src/utils/mode-selection.ts` | Pure output-mode decision |
| `cli/src/utils/plain-text-task.ts` | Standalone task execution, approval policy, stdout/stderr contract |
| `cli/src/components/App.tsx` | Interactive application shell and navigation |
| `cli/src/components/ChatView.tsx` | Interactive task conversation |
| `cli/src/context/TaskContext.tsx` | Interactive task state subscription |
| `cli/src/controllers/CliWebviewProvider.ts` | Terminal implementation of the core host bridge |
| `cli/src/constants/theme.ts` | Semantic dark/light Ink and ANSI palettes |
| `cli/src/utils/cleanup.ts` | Process cleanup and output draining |
| `cli/src/acp/` | ACP transport, sessions, terminals, and conformance tests |
| `cli/src/agent/` | Public library implementation |
| `cli/src/exports.ts` | Public package exports |
| `cli/esbuild.mts` | Executable and library bundling |

The CLI runs the core in the same Node.js process. Terminal-specific behavior crosses the core boundary through the host bridge; tool implementation details remain in the core tool layer.

## Command changes

The default command and `task` subcommand intentionally duplicate most task options in Commander. When adding or changing a task option:

1. Update both definitions unless the option is explicitly root-only.
2. Add it to `TaskOptions` with the exported core type or enum where one exists.
3. Apply state overrides in `cli/src/utils/options.ts`.
4. Verify interactive and standalone behavior.
5. Update `cli/README.md` and `cli/man/dirac.1.md`, then regenerate `cli/man/dirac.1`.

Root-only options currently include ACP startup, detached socket listening, Kanban, and `--continue`.

Commander parsers must reject invalid values rather than silently changing them. Prefer shared exported enums and option collections over duplicated string literals.

## Interactive UI

Components render terminal state; hooks own input and stateful interaction. Keep task execution outside rendering components. The `TaskContext` subscription is the boundary from core state into the TUI.

Input handlers must ignore terminal control sequences they do not own. Layout code must account for live terminal resizing and very narrow terminals. Modal lists clamp their selection and viewport whenever their contents or available height changes.

Use semantic tokens from `cli/src/constants/theme.ts`; do not place raw named colors in components. Dark mode is the fallback. Light mode is selected by `DIRAC_COLOR_MODE=light` or a light background reported through `COLORFGBG`.

Transcript rendering uses a restrained hierarchy for long-running terminal sessions. Assistant prose, tool headers, tool bodies, metadata, and diff context each have semantic roles. Tool bodies must use an explicit foreground rather than inheriting the terminal default. Tool identity remains delightfully color coded through category-tinted icons, borders, and headers, while status colors stay localized to short markers and urgent states. Do not color entire output blocks. Prefer explicit palette colors over terminal `dim` styling, whose readability varies by emulator.

Scrollable Markdown and live thinking tails must parse the complete document before clipping formatted terminal rows. Use `renderMarkdownLines` for both viewport rendering and Markdown scroll bounds; clipping source text before parsing loses off-screen fences, table headers, list numbering, and reference definitions. The interactive formatter is separate from standalone text output.

File-edit permission diffs also parse the complete patch before clipping. Use `createDiffLayout` for both diff rendering and permission scroll bounds, accounting for collapsed context, split-row pairing, hunk separators and unified-line wrapping. Never clip raw patch source before parsing: losing a hunk header changes line numbers and can cut off rows without moving the viewport.

### Tasklet observation

Interactive `/agents` is a display-only inventory snapshot; it never enters model history, steering, or approval input. `/agent` opens a passive, paged transcript browser (`r` refresh, `n`/`p` pages). Both use the existing TaskService observation handlers, qualified by selected root and source identity. Saved reads cannot construct a runtime or repair stored history. The count comes from admitted/unsettled TaskletHost ownership, not card status. Keep local snapshots separate from authoritative presentation replay, and do not restore continuously updated child-preview cards or a second Goal-specific inventory.

## Standalone output contract

Standalone execution is designed for shell composition:

- stdout contains the final completion text only in normal text mode.
- stderr contains task IDs, progress, tool cards, verbose reasoning, summaries, warnings, and errors.
- redirected streams do not contain ANSI escapes unless `FORCE_COLOR` enables them.
- `--json` writes one complete JSON value per line to stdout.
- tasks that require unavailable feedback fail clearly.
- actionable approval cards require `--yolo` and are serialized before approval.
- an explicit timeout aborts the task and exits unsuccessfully.

Do not move diagnostic output to stdout. Test both TTY and redirected stream behavior when changing display utilities.

## Images and piped input

The CLI accepts PNG, JPEG, GIF, and WebP images through `--images`, inline mentions, interactive file mentions, and clipboard paste. Inline `@/path` mentions are workspace-relative. Ordinary absolute paths remain absolute. Resolve and deduplicate canonical paths before reading them.

Piped stdin is preserved byte-for-byte and prepended to the optional prompt. Whitespace-only stdin is empty for task validation but must not make an otherwise valid prompt or image-only task fail.

## Storage

The default Dirac home is `~/.dirac`; state is stored below `~/.dirac/data`:

```text
~/.dirac/
  data/
    globalState.json
    secrets.json
    workspaces/<workspace-hash>/workspaceState.json
    tasks/
    logs/
```

`--config <path>` and `DIRAC_DIR` override the Dirac home. The selected working directory determines workspace storage and defaults to the current directory.

ACP session forks copy retained tasklets into the new root's directory and rebind their ownership to that root. Child handles, conversation IDs, outcomes, events, and private transcripts are retained; forking does not restart child execution. Changes or deletion in the fork must not affect the source session.

After a fresh CLI build, verify this contract over actual ACP stdio with `cd cli && npx vitest run src/acp/protocolConformance.test.ts -t 'forks retained tasklets'`.

## Public library

The package exports its embeddable API from `cli/src/exports.ts`. Importing the library bundle must not install CLI signal handlers, suppress the caller's console, parse argv, or otherwise mutate process-global CLI state. Keep command-entry side effects in `cli/src/index.ts`.

## Manual page

Edit `cli/man/dirac.1.md`, then regenerate the roff file with:

```bash
pandoc --standalone --to man cli/man/dirac.1.md --output cli/man/dirac.1
```

Inspect both the Markdown source and generated man page whenever command options or environment behavior changes.

## Publishing

From `cli/`, the package scripts can build a tarball and update the Homebrew formula:

```bash
npm run build:production
npm run package
npm run package:brew
```

Publishing a package or formula is a release operation and is separate from the normal build and verification workflow.

Parent supervision uses `subagents(operation="create", assignments=[...])` and the same tool's `list`, `inspect`, `message`, `interrupt`, `resume`, and `sleep` operations. Control `message` accepts up to 20 guidance/reply/permission-decision items; replies and permission decisions require the exact `request_id`. Ordinary questions and peer communication use `send_message({to,text})`, not control messages. `list_agents` provides a compact root-scoped roster; children may use finite `wait_for_message` waits, and all agents may publish/read findings through `shared_journal`. There is no callable `tasklets` alias; retained historical records remain passive evidence. Normal transcript/Agents rows show assignment titles and status, not routing IDs. Displaced running/waiting snapshots can enter scrollback; only meaningful status/result changes create revisions. Accounting-only cards remain in stored usage totals but are not transcript rows. See `tests/e2e/cli/README.md` for the isolated standalone/Goal regression fixture.
