# CLI terminal harness

A persistent, shell-free PTY running the **real built CLI**, with an xterm terminal
emulator for inspecting what a user would see. An agent can start it in one tool
call and send input or inspect it in later calls. It does not use Ink mocks or
modify production CLI code.

## Requirements and verification

Linux or macOS, Node 22.13–24.x, and repository dependencies. `node-pty` is a native
dev dependency; normal `npm install` installs its prebuild or compiles it. If you
installed with `--ignore-scripts`, its native binding must already be available.
The session-control socket currently does not support Windows.

From the repository root:

```bash
npm run cli:build
npm run test:e2e:cli:tui
```

The build is **not automatic**. Rebuild after changing CLI or core code, otherwise
you will test an old binary. `start` returns the bundle path and modification time.
The tests cover the PTY/emulator, persistent control, invalid requests, process
exit/stop/idle cleanup, paste negotiation, resizing, and #259 against the built CLI.
No live model credentials or calls are needed for this suite.

## Interactive control across tool calls

```bash
npm run --silent cli:tui -- start
```

Copy the returned `session` directory (for example `/tmp/dirac-tui-AbCd12`) into
subsequent commands. The detached owner keeps the terminal alive after `start`
returns. Commands return JSON; `--silent` suppresses npm's non-JSON banners.

```bash
SESSION=/tmp/dirac-tui-AbCd12
npm run --silent cli:tui -- wait --session "$SESSION" --text '@ files'
npm run --silent cli:tui -- write --session "$SESSION" --text 'Give me a long response.'
npm run --silent cli:tui -- key --session "$SESSION" --key Enter
npm run --silent cli:tui -- wait --session "$SESSION" --text 'Response line 01' --timeout 30000
npm run --silent cli:tui -- paste --session "$SESSION" --file /absolute/path/to/draft.txt
npm run --silent cli:tui -- key --session "$SESSION" --key Up --count 3
npm run --silent cli:tui -- screen --session "$SESSION" --scrollback
npm run --silent cli:tui -- resize --session "$SESSION" --cols 80 --rows 24
npm run --silent cli:tui -- stop --session "$SESSION"
```

`write` sends raw text/escape bytes without submitting. `paste` sends a single
multiline write, adding bracketed-paste delimiters **only if the application has
enabled that terminal mode**. Use `key Enter` to submit separately. `paste` and
`write` accept either `--text` or `--file`, never both.

Keys include `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `Enter`, `Escape`, `Tab`,
`Backspace`, `Delete`, `PageUp`, `PageDown`, `Ctrl+a`, `Ctrl+e`, `Ctrl+c`, `Alt+Left`,
`Shift+Down`, and `Shift+Enter` (sent as CSI-u `ESC [ 13 ; 2 u`). Repeated keys are
spaced apart so Ink doesn't receive several escape sequences coalesced into one
input event. Unsupported chords fail visibly. The #260 regressions verify both
CSI-u and xterm modifyOtherKeys Shift+Enter, insertion at the cursor, follow-up
drafts, narrow widths, Shift+Down, and ordinary Enter submission. The harness sends
distinct bytes; it does not simulate physical Shift+Enter in a terminal that
sends the same carriage return as Enter.

`wait` searches the visible screen, with a default 10-second deadline. A failure
includes the current screen. Actions wait briefly for terminal output to settle;
continuously streaming apps are sampled after at most three seconds. For delayed
updates, use `wait` rather than assuming one action captures the final frame.

## Default deterministic fixture versus live sessions

By default, `start` creates a private temporary home and empty workspace. It
starts a loopback OpenAI-compatible provider, seeds an isolated Dirac configuration
with a dummy key, and returns an 80-line `respond:complete` for every model request.
The real CLI handles API streaming, tool dispatch, completion cards and input.
The fixture never tells the agent to run commands or edit files. Host provider
credentials and proxy variables are not inherited. Auto-update, indexing and
telemetry are disabled. This is **not** an OS sandbox or a network firewall.

For plan-scroll regressions, use an 80-line `respond:plan` fixture:

```bash
npm run --silent cli:tui -- start --fixture long-plan --cols 100 --rows 30
```

Press Tab to enter Plan mode, submit a prompt, and wait for `Plan line 01`.
Cards now open at the beginning; press Down to reach later lines. The #262
regressions first scroll down and then up before asserting that editing retains
the visible plan lines, including at narrow widths, with multiline and Unicode
input, and after resizing. They also cover completed-response scrolling and
verify that a newly submitted turn starts its new card at the beginning.
The #263 regressions assert that completed responses and proposed plans open
at their first line, retain their viewport during draft edits and resizing,
remain scrollable in both directions, and reset to the beginning on follow-up.

For #264 Markdown rendering regressions, use `--fixture markdown-plan`. This
returns a plan with three long fenced code blocks separated by bold prose. Enter
Plan mode with Tab, submit a prompt, and wait for `Markdown plan start.`. Scroll
with Down: code must retain its border and literal `**literal**` markers even
when the opening fence is above the viewport; prose between blocks must not
become code. The regressions cover both directions, the end, narrow widths and
resizing. Markdown is parsed as a full document before formatted rows are clipped.

For #265 response Markdown regressions, use `--fixture markdown-response` at
100×30 or 60×30 and submit `/askDirac what are the auto-approved commands?`.
The canned `respond:complete` answer contains headings, bold prose, inline code,
lists, a reference link and a long fenced code block. Assertions check formatted
rows throughout scrolling, literal code after its fence leaves the viewport,
return scrolling and resizing. This tests rendering, not the accuracy of an
answer about approvals; no live credentials or command execution are used.

For file-creation approval regressions, opt into a deterministic `write_to_file`
request followed by a short completion:

```bash
npm run --silent cli:tui -- start --fixture create-file --cols 180 --rows 40
```

This fixture asks to create one fixed long workspace-relative path. Auto-approval
is off; the file is written only after approval. Keep the default temporary
workspace rather than pointing it at user files. The #261 regressions verify the
left-aligned, fully wrapped description at wide and narrow widths, resizing, and
approval/denial behavior.

For mode-switch continuity regressions, run the focused suite after rebuilding:

```bash
node --test tests/e2e/cli/mode-switch.test.mjs
```

The suite submits `/askDirac` prompts to avoid Goal routing. Tab must skip a
pending file permission or follow-up question, continue in the same root task,
and deliver both the skipped tool result and the new mode instructions to the
next model request. Questions are covered in both directions; Plan → Act on a
proposed plan must still accept the plan rather than skip it. Persisted card
statuses, unchanged task IDs, bounded request counts, and an untouched target
file are checked in addition to the terminal output.

The opt-in `mode-question`, `mode-plan`, and `mode-stream` fixtures return one
question, proposed plan, or gated streaming response, then a short final response.
Because `respond:complete` is Act-only, the final Plan-mode response uses
`respond:plan` and leaves one new proposed-plan card waiting for the user; all
pre-switch interactions must already be skipped. Act-mode responses complete.
The streaming cases press Tab before releasing the first SSE response through a
loopback-only fixture endpoint; switching must preserve the active response and
apply the new mode at the next natural request boundary. No timing-based model
response delay or live provider is used. These fixtures and `create-file` capture
model request bodies in the isolated home's `mode-switch-requests.jsonl`;
no credentials are captured. A failed test prints its retained session directory.
Keep the default temporary workspace.

For existing-file edit approval scrolling (#266), use a seeded temporary file and
real `read_file` → `edit_file` calls with two long insertions:

```bash
npm run --silent cli:tui -- start --fixture edit-file --cols 180 --rows 32
```

Submit `Make the two insertions in permission-scroll.txt.` and wait for `Apply 2 edit`.
Press Down 25 times, Up 5 times, then Up 3 times: earlier diff rows must enter the
viewport instead of only removing its bottom rows. The regression also checks
both scroll boundaries, unified/wrapped layouts, resizing, and approval/denial.
Diffs are parsed in full before formatted rows are clipped; scroll bounds include
collapsed context, paired changes, wrapped lines and hunk separators. This fixture
writes only `permission-scroll.txt`; keep the default isolated workspace rather
than supplying a directory with user files.

For real providers, explicitly opt in:

```bash
npm run --silent cli:tui -- start --live --cwd /absolute/path/to/repository
```

**Live mode inherits your environment and Dirac configuration/credentials.** It
can make billable model calls and perform normal agent actions in the selected
workspace. Logs may contain prompts and other sensitive data. Do not use live
mode unless the task authorizes those actions. Auto-update remains disabled.

To inspect a different executable (or a particular installed CLI):

```bash
npm run --silent cli:tui -- start -- node /absolute/path/to/program.mjs
```

Custom commands use the isolated environment and no canned provider, unless
`--live` is also specified. Arguments after `--` go directly to the executable;
there is no shell interpolation. Use absolute program/script paths when needed,
since the default working directory is a temporary empty workspace.

## Screen and cursor interpretation

Snapshots contain `screen`, `lines`, `cols`, `rows`, the terminal's hardware
`cursor` coordinates, `exit`, and compact `styledRuns` for cells with backgrounds
or inverse video. Coordinates are zero-based. `--scrollback` additionally returns
the active buffer, bounded to 2,000 scrollback rows plus the visible screen.

**Ink paints the input cursor rather than moving the hardware cursor to it.**
Inspect `styledRuns` to locate that painted block. The #259 regression identifies
it using the deterministic dark palette's `theme.cursorBg` (`#C6CBDD`); the hardware
cursor alone cannot prove that the prompt cursor moved. Highlighted mentions,
buttons and code blocks may also have background colors.

The #259 test pastes 15 lines, presses Up **without Ctrl+A**, and asserts that the
painted prompt cursor moves while the response stays still. It then verifies both
arrow directions, prompt viewport movement, response-scroll fallback at input
boundaries, and resize retention. It also checks one-row navigation through a
soft-wrapped paragraph, cursor visibility after resizing, and pasted CRLF text
with empty rows, wide characters, emoji and combining characters.

## JavaScript API

For assertions or concise output from an agent tool's Node script:

```js
import { startSession, requestSession } from './tests/e2e/cli/client.mjs'

const { session } = await startSession({ cols: 100, rows: 30 })
try {
  await requestSession(session, { operation: 'wait', text: '@ files' })
  const snapshot = await requestSession(session, { operation: 'paste', text: 'first\nsecond' })
  console.log(snapshot.screen)
  console.log(snapshot.styledRuns)
} finally {
  await requestSession(session, { operation: 'stop' })
}
```

Operations: `screen`, `write`, `paste`, `key`, `resize`, `wait`, `stop`. Their
properties mirror the CLI flags; deadlines use `timeoutMs`, dimensions use `cols`
and `rows`, and repeated keypresses use `count`. `startSession` also accepts
`command`, `args`, `cwd`, `live`, `idleMs`, and `fixture` (`long-response` by default
or `long-plan` / `markdown-plan` / `markdown-response` / `create-file` / `edit-file` / `tasklets`
/ `mode-question` / `mode-plan` / `mode-stream`).

## Vim prompt editing regressions (#92)

`node --test tests/e2e/cli/vim-input.test.mjs` checks modal editing against the built CLI at baseline, screen-fit (80×24), and narrow sizes. It covers the persisted Terminal setting, `Esc`/`i`, counts, deletion/change, painted cursor, CRLF/Unicode paste in INSERT, raw Backspace/Delete/Home/End, undo/redo, resizing, slash-menu cancellation, and follow-up submission. The JavaScript `startSession` API accepts `vimMode: true` to seed only this preference in the isolated fixture configuration; it is false by default. Pasting in NORMAL is interpreted as Vim keystrokes, so paste drafts in INSERT. No live credentials are used.

## Prompt recall regressions (#269)

`node --test tests/e2e/cli/prompt-history.test.mjs` checks Ctrl+Up/Down recall against the built CLI, including initial and follow-up prompts, draft/cursor restoration, collapsed pastes, editing and explicit resubmission, completion-menu priority, Vim NORMAL, resizing, narrow layouts, and unchanged response scrolling. It also checks recall after `/clear` and a new CLI launch with the same isolated configuration, plus workspace isolation. The shortcut hint uses the existing muted footer row without adding terminal rows. The harness sends xterm modified arrows (`ESC [ 1 ; 5 A/B`); OS-level shortcuts must be configured to pass these bytes to the terminal. No live credentials are used.

## Tasklet lifecycle and Agents panel

After a fresh `npm run cli:build`, run the standalone and Goal-root scenarios with:

```bash
node --test tests/e2e/cli/tasklets.test.mjs
```

The opt-in `tasklets` fixture enables subagents only in its private configuration.
It uses the unified public native `subagents` tool (`operation: create` and supervision operations), plus child `respond` calls through
the real built CLI. Root/child requests are distinguished by tool availability and
assignment markers, not global request ordering. Two siblings report progress and
ask private parent-directed questions; the parent inspects them and voluntarily
sleeps. The test opens `/agent` (singular), inspects/reopens previews without
answering the questions, then submits user messages to wake the parent. It checks
one completed sibling while the other remains waiting, addressed `message` replies using exact `request_id` values,
bounded selected assignment/transcript evidence, same-ID resume, and stable agent-name/title/status
completed previews after reopening
the persisted root in a new CLI process with the provider stopped.
The Goal variant starts through `/goal`, stays `working` during private child
questions, and becomes `achieved` after explicit completion without a hidden
verification gate. Both variants assert root-only top-level storage/history and
byte-preserved child records, events and transcripts during restored browsing;
the Goal record also stays unchanged on selection/reopening.
It also reproduces the 80×24 case with two waiting children: displaced parent control
receipts remain accessible in scrollback with named agent targets, while accounting-only cards/legacy UUID headings
never become conversation rows. Activity-only changes do not create transcript revisions.

No live credentials, command execution, or workspace edits are requested by the
model. The provider writes only a diagnostic `tasklet-fixture.jsonl` in the temporary
workspace. Inspection waits are event-driven and bounded; root and child request
budgets and the test deadline fail rather than run indefinitely. This scenario
covers question resolution, not tool-permission escalation, child interruption,
or restoring a still-running child. Keep the default isolated workspace.

## Lifecycle and artifacts

Always call `stop` when finished. It terminates the PTY process (escalating to
SIGKILL if necessary) and closes the fixture and control socket. An idle session
expires after 15 minutes; override with `start --idle MILLISECONDS`. Naturally
exited programs retain their last screen until stopped or expired. Input after
exit fails instead of silently disappearing. The harness is a development helper,
not a supervisor for independently detached processes spawned by live tools.

Each owner-only temporary directory contains `session.json`, `harness.log`, raw
`terminal.ansi`, and the isolated home/workspace. `stop` retains these for debugging;
remove the directory afterward if not needed. Do not commit credentials, captured
output, or session files. No sessions are added to CI automatically.
