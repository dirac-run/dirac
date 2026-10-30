---
title: DIRAC
section: 1
header: User Commands
footer: Dirac CLI
date: August 2026
---

# NAME

dirac - run the Dirac coding agent in a terminal

# SYNOPSIS

**dirac** [*options*] [*prompt*]

**dirac task** [*options*] [*prompt*]

**dirac** *command* [*options*]

# DESCRIPTION

**dirac** runs the Dirac coding agent against a workspace. It can inspect and edit files, execute commands, use browser tools, maintain task history, and resume earlier work.

The CLI has an interactive React/Ink interface and a standalone output path for unattended tasks, pipes, redirection, and machine-readable output. Both paths use the same core task engine and configuration.

# OUTPUT MODES

**Interactive mode** is used when stdin and stdout are terminal devices and neither **--yolo** nor **--json** is present. With no prompt, Dirac opens the composer. With a prompt, it submits the first turn immediately. The interface supports approvals, feedback, follow-up messages, history, settings, model selection, skills, and task resumption.

Press **Enter** to submit a prompt. **Shift+Enter** inserts a newline when the terminal sends a distinct modified-Enter sequence (CSI-u `ESC [ 13 ; 2 u` or xterm modifyOtherKeys `ESC [ 27 ; 2 ; 13 ~`). **Shift+Down** also inserts a newline. If Enter and Shift+Enter send the same carriage return, use Shift+Down or configure a Shift+Enter mapping to one of these sequences; identical input bytes cannot be distinguished.

**Ctrl+Up / Ctrl+Down** recall older/newer prompts from the current conversation and recent conversations in the same workspace. Recall fills the input without sending; edit and press Enter to submit. Moving forward past the newest prompt restores the original draft and cursor. Only text is recalled, not old attachments. Ordinary arrows still move the cursor or scroll the response. If the terminal or OS intercepts Ctrl+arrows, configure it to send `ESC [ 1 ; 5 A` / `ESC [ 1 ; 5 B`.

Scrollable response cards, including proposed plans and follow-up responses, open at the beginning. Use **Down** for later lines and **Up** for earlier lines. In a multiline draft, arrows navigate the prompt first and scroll the response only at the draft's navigation boundaries. Editing a draft retains the response's scroll position.

**Standalone mode** is selected when **--yolo** or **--json** is present, stdin was piped, stdin is redirected, or stdout is redirected. It does not render the Ink interface.

In standalone text mode, stdout is reserved for the final completion result. Task IDs, progress, tool activity, verbose reasoning, summaries, warnings, and errors are written to stderr. Redirected output has no ANSI escape sequences unless color is explicitly forced.

Without **--yolo**, a standalone task fails if it needs an approval or user feedback. **--yolo** auto-approves actionable cards. **--auto-approve-all** provides auto-approval while retaining interactive mode when the terminal supports it.

# TASK MODES

**Act mode** allows Dirac to use tools to carry out the task. It is the default unless the saved configuration selects another mode.

**Plan mode** directs Dirac to investigate and develop a plan before implementation.

**--act** and **--plan** conflict and cannot be supplied together.

# COMMANDS

## task, t

Run a new task, or resume the task given by **--taskId**. The optional prompt may be combined with piped stdin and images.

**dirac task** [*options*] [*prompt*]

The task subcommand accepts every option in TASK OPTIONS. ACP, Kanban, and **--continue** are available only on the default root command.

## history, h

List task history.

**dirac history** [**--limit** *number*] [**--page** *number*] [**--config** *path*]

**-n**, **--limit** *number*
: Show this many tasks per page. The default is 10. The value must be a positive integer.

**-p**, **--page** *number*
: Show this 1-based page. The default is 1. Requests beyond the available history are clamped to the last page.

**--config** *path*
: Use another Dirac home directory.

## config

Show the effective global and workspace configuration.

**dirac config** [**--config** *path*]

## tools

Print the current tool configuration as copy-pasteable comma-separated **--enable-tool** and **--disable-tool** options, then exit.

**dirac tools** [**--cwd** *path*] [**--config** *path*]

**-c**, **--cwd** *path*
: Select the workspace used to discover tools. The default is the current directory.

**--config** *path*
: Use another Dirac home directory.

## auth

Open the interactive provider setup or perform quick setup with flags.

**dirac auth** [*options*]

**-p**, **--provider** *id*
: Provider ID, such as `openai-native`, `anthropic`, or `moonshot`.

**-k**, **--apikey** *key*
: Provider API key.

**-m**, **--modelid** *id*
: Model ID to configure.

**-b**, **--baseurl** *url*
: Base URL for an OpenAI-compatible provider.

**--azure-api-version** *version*
: Azure API version for Azure OpenAI.

**-v**, **--verbose**
: Show verbose diagnostics.

**-c**, **--cwd** *path*
: Select the workspace directory.

**--config** *path*
: Use another Dirac home directory.

## version

Print the Dirac CLI version.

## update

Check npm for a newer CLI version and offer to install it.

**dirac update** [**--verbose**]

## kanban

Run `npx kanban --agent dirac`.

The equivalent root option is **dirac --kanban**. Neither form accepts a task prompt.

## dev log

Open the CLI log using the platform's configured external application.

# TASK OPTIONS

These options apply to both **dirac** [*prompt*] and **dirac task** [*prompt*], except where noted.

**-a**, **--act**
: Run in act mode. Conflicts with **--plan**.

**-p**, **--plan**
: Run in plan mode. Conflicts with **--act**.

**-y**, **--yolo**
: Select standalone mode and auto-approve actions.

**--auto-approve-all**
: Auto-approve actions while keeping the interactive interface when stdin and stdout are TTYs.

**-t**, **--timeout** *seconds*
: Abort after a positive number of seconds. No timeout is applied unless this option is supplied.

**-m**, **--model** *model*
: Override the configured model for this invocation.

**--provider** *provider*
: Override the API provider. A provider ID or OpenAI-compatible base URL may be supplied. Requires **--model**.

**-i**, **--images** *paths...*
: Attach one or more PNG, JPEG, GIF, or WebP images. Relative paths are resolved from the selected workspace.

**-v**, **--verbose**
: Expand reasoning and task diagnostics. In the interactive interface, the existing transcript starts expanded.

**-c**, **--cwd** *path*
: Select the task workspace. The default is the current directory.

**--config** *path*
: Use another Dirac home directory instead of `~/.dirac`.

**--thinking** [*tokens*]
: Enable extended thinking. The default budget is 1024 tokens when no value is supplied. The value must be a non-negative integer.

**--reasoning-effort** *effort*
: Set reasoning effort to `none`, `low`, `medium`, `high`, or `xhigh`. Matching is case-insensitive.

**--speed** *speed*
: Set inference speed to `default`, `standard`, or `fast`. Fast is available only for supported Anthropic, OpenAI API, and OpenAI Codex subscription models and may use premium pricing or credits.

**--max-consecutive-mistakes** *count*
: Stop a yolo task after this many consecutive mistakes. The value must be a positive integer.

**--json**
: Select standalone mode and emit newline-delimited JSON events.


**--auto-condense**
: Use AI-powered context compaction instead of mechanical truncation.

**--subagents**
: Enable subagents for this task.

**--enable-tool** *ids*
: Enable comma-separated configurable tool IDs over the saved configuration for this invocation. May be repeated and may be combined with **--disable-tool** when the resolved sets are disjoint.

**--disable-tool** *ids*
: Disable comma-separated configurable tool IDs over the saved configuration for this invocation. May be repeated and may be combined with **--enable-tool** when the resolved sets are disjoint.

**--only-tools** *ids*
: Use exactly the listed comma-separated configurable tool IDs for this invocation. This exact mode cannot be combined with **--enable-tool** or **--disable-tool**.

Tool-selection options apply only to ordinary CLI tasks and are not persisted. They cannot be used with ACP, detached listen mode, Kanban, or Goals, and they never alter task-scoped tools. Lists accept canonical IDs or unambiguous names. Unknown, non-configurable, ambiguous, or conflicting tool identifiers stop startup with an error. Use **dirac tools** to list canonical IDs and saved status.

**--headers** *headers*
: Set custom headers for an OpenAI-compatible provider. Accepts a JSON object or comma-separated `key=value` pairs.

**--hooks-dir** *path*
: Load additional runtime hooks from this directory.

**--no-index**
: Disable symbol indexing for the workspace.

**--no-emoji**
: Use Unicode/ASCII icon fallbacks instead of emoji.

**-T**, **--taskId** *id*
: Resume this task. An optional prompt, piped stdin, and images become a follow-up turn. With no follow-up content, the historical task is displayed.

# ROOT-ONLY OPTIONS

**-V**, **--version**
: Print the package version and exit.

**--continue**
: Resume the most recent task associated with the current workspace. This option does not accept a prompt or piped stdin and conflicts with **--taskId**.

**--acp**
: Run as an Agent Client Protocol server over standard input and output for editor integration.

**--acp-auth**
: Configure a provider for an ACP client, then exit. This is primarily used by clients that support ACP terminal authentication.

**--listen** *socket*
: Run ACP detached on a Unix socket. Implies **--acp**.

**--kanban**
: Run `npx kanban --agent dirac`. This option does not accept a prompt.

# ACP EDITOR INTEGRATION

Install Dirac from the ACP Registry when the editor supports it. In JetBrains IDEs 2025.3 and later, open **Settings → Tools → AI Assistant → Agents** or use **Install From ACP Registry…** in the agent picker. In Zed, open **Agent Settings → External Agents** and use **Add Agent → Install from Registry**.

When a selected provider is not configured, Dirac advertises the authentication methods supported by the client: local browser provider setup, optional ChatGPT OAuth, explicit environment variables, and terminal setup where available. ChatGPT is not required; API-key providers such as DeepSeek can be selected directly.

For manual clients, install `dirac-cli` and configure an agent command equivalent to:

```json
{
  "command": "dirac",
  "args": ["--acp"]
}
```

Use an absolute executable path if the editor cannot resolve `dirac` from `PATH`. Run `dirac auth` before starting the editor as a fallback when the client does not display ACP authentication methods. A non-default Dirac home must use the same **--config** value during setup and ACP startup.

# INPUT

## Piped input

Piped stdin is preserved byte-for-byte and placed before the optional prompt, separated from it by a blank line. Piped input selects standalone mode.

Whitespace-only stdin is treated as empty for validation. It does not invalidate a supplied prompt or image-only task.

Examples:

```bash
git diff | dirac "Review these changes"
cat error.log | dirac --yolo "Find and fix the cause"
```

## Images

Images may be supplied with **--images** or mentioned in the prompt. `@/images/screenshot.png` means a path relative to the selected workspace. Ordinary `/absolute/path.png`, `./relative/path.png`, `~/path.png`, quoted paths, and backslash-escaped spaces are also accepted when the file exists.

Duplicate canonical paths are attached only once. An image-only task is valid.

# JSON OUTPUT

**--json** writes one JSON value per line to stdout. The stream begins with:

```json
{"type":"task_started","taskId":"..."}
```

Task state messages follow in their internal `DiracMessage` shape, including message identifiers, timestamps, and typed content for Markdown, cards, or API status. A standalone failure produces:

```json
{"type":"error","message":"..."}
```

Consumers should parse the output as NDJSON rather than as one JSON array.

# TASK RESUMPTION

```bash
dirac history
dirac --taskId abc123
dirac --taskId abc123 "Add tests for that change"
dirac --continue
dirac task --taskId abc123 --yolo "Finish the implementation"
```

A follow-up submitted to a completed task starts a new turn; the historical completed state does not terminate the new turn.

# AUTHENTICATION EXAMPLES

```bash
dirac auth
dirac auth --provider anthropic --apikey "$ANTHROPIC_API_KEY" --modelid claude-sonnet-4-6
dirac auth --provider openai --apikey "$OPENAI_API_KEY" --modelid gpt-4o --baseurl https://api.example.com/v1
```

Interactive setup masks keys in terminal output. Quick setup validates the provider and required values instead of falling back silently.

# VIM PROMPT EDITING

Enable **Vim prompt editing** in **/settings → Terminal**, or search settings for **vim**. It is disabled by default, saved across launches, and applies immediately. The footer shows **INSERT** or **NORMAL**. New drafts start in INSERT; **Esc** enters NORMAL; **i**, **a**, **I**, and **A** return to INSERT. Enter submits in either mode.

NORMAL supports **h/l** (graphemes), **j/k** (logical lines), **w/b/e** (words), **0/^/\$** (line positions), and **gg/G** (draft start/last-line start). Use **d/c** with **h/l/w/b/e/0/^/\$** to delete/change, **dd/cc** for lines, **D/C** to line end, and **x** for graphemes. Numeric counts include **3b**, **2dw**, and **d2w**. **u** undoes; **Ctrl+R** redoes unless an active Goal owns that shortcut. Esc cancels an incomplete command.

Type, paste, complete slash commands, and insert file mentions in INSERT. Printable input in NORMAL is interpreted as editing commands. This subset does not implement registers, yank/put, search, repeat, or Ex commands. The preference does not affect standalone text/JSON or ACP input.

# TERMINAL COLORS

Dirac uses semantic dark and light palettes in both interactive and standalone output. Dark mode is the fallback.

The **Light terminal theme** checkbox under **Settings → Features** persists the selected light or dark palette for the next CLI launch.

**DIRAC_COLOR_MODE**
: Set to `dark` or `light` to override the saved setting. Set to `auto` or supply an unrecognized value to use `COLORFGBG` detection with a dark fallback.

**COLORFGBG**
: When provided by the terminal, its background color index is used to detect a light terminal.

**NO_COLOR**
: Disable ANSI colors when present.

**FORCE_COLOR**
: Force ANSI colors when present. A value of `0` disables them. `NO_COLOR` takes precedence.

Redirected output is uncolored by default.

# ENVIRONMENT

**DIRAC_DIR**
: Override the Dirac home directory. The default is `~/.dirac`.

**DIRAC_PROVIDER**
: Explicit provider ID for both Act and Plan modes, such as `deepseek`, `anthropic`, or `openrouter`. Overrides persisted provider defaults for the process.

**DIRAC_MODEL**
: Exact model ID for the provider selected by **DIRAC_PROVIDER**.

**DIRAC_API_KEY**
: API key for the provider selected by **DIRAC_PROVIDER**, when that provider uses API-key authentication.

**DIRAC_BASE_URL**
: Optional custom endpoint for the provider selected by **DIRAC_PROVIDER**, when supported.

**DIRAC_NO_AUTO_UPDATE**
: Set to `1` to disable the background update check.

**DIRAC_NO_EMOJI**
: When set, use Unicode/ASCII icon fallbacks. Equivalent to **--no-emoji**.

**CUSTOM_HEADERS**
: OpenAI-compatible custom headers in JSON or comma-separated `key=value` form. **--headers** takes precedence.

**OPENAI_COMPATIBLE_CUSTOM_KEY**
: API key for an OpenAI-compatible endpoint. A provider URL or `OPENAI_API_BASE` and a model must also be configured.

Provider-specific API key variables such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, and `HF_TOKEN` can bypass interactive authentication.

**DIRAC_COMMAND_PERMISSIONS**
: JSON configuration that restricts shell commands. If no configuration is supplied, commands are allowed subject to normal task approval behavior.

The object supports:

- `allow`: glob patterns for commands that may run. Once present, unmatched commands are denied.
- `deny`: glob patterns that are rejected before allow rules.
- `allowRedirects`: whether shell redirects are allowed. The default is false when command permission rules are active.

Every command segment separated by shell operators is checked, and deny rules take precedence.

```bash
export DIRAC_COMMAND_PERMISSIONS='{"allow":["npm *","git *"],"deny":["git push *"]}'
```

# FILES

The default storage layout is:

```text
~/.dirac/
  data/
    globalState.json
    secrets.json
    workspaces/<workspace-hash>/workspaceState.json
    tasks/
    logs/
```

`secrets.json` is created with owner-only permissions. Use **dirac dev log** to open the CLI log.

# EXIT STATUS

Dirac exits with status 0 after successful completion or a normal interactive exit. It exits nonzero for invalid arguments, missing authentication in standalone mode, unavailable approvals or feedback, timeouts, task failures, and initialization errors.

# EXAMPLES

```bash
# Open the interactive composer
dirac

# Submit an interactive task immediately
dirac --plan "Design a REST API"

# Keep the TUI but auto-approve actions
dirac --auto-approve-all "Fix the lint failures"

# Run unattended with standalone output
dirac --yolo "Run the tests and fix failures"

# Attach images
dirac --images screenshot.png diagram.webp "Implement this layout"
dirac "Compare @/screens/before.png and @/screens/after.png"

# Override model configuration
dirac --provider openai-native --model gpt-4o --reasoning-effort high "Audit this module"

# Consume NDJSON
dirac --json "Describe the repository" | jq -c 'select(.type == "task_started")'
```

# BUGS

Report bugs at <https://github.com/dirac-run/dirac/issues>.

# AUTHORS

Dirac is developed by Dirac Delta Labs and open-source contributors.

# COPYRIGHT

Licensed under the Apache License 2.0.
