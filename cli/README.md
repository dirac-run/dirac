# Dirac CLI

<p align="center">
  <img src="https://github.com/dirac-run/dirac/blob/master/assets/media/diraccli1.png?raw=true" width="70%" />
</p>

<p align="center">
  <a href="https://github.com/dirac-run/dirac"><strong>GitHub</strong></a> |
  <a href="https://www.npmjs.com/package/dirac-cli"><strong>NPM</strong></a> |
  <a href="https://discord.gg/wcYTx9BGea"><strong>Discord</strong></a>
</p>

## What is Dirac?

Dirac is an efficiency-focused open-source coding agent built for complex, real-world codebases. It supports **dozens of providers and hundreds of models**, and combines long-running autonomous work with hash-anchored editing, AST inspection and refactoring, parallel operations, subagents, continuous steering, and configurable permission controls.

The CLI provides an interactive terminal UI as well as scriptable plain-text and JSON modes. See the [full Dirac overview](https://github.com/dirac-run/dirac#what-is-dirac) for the feature walkthrough and reproducible harness comparison.

## Requirements

- Node.js 22.13 through 24.x
- npm

Node.js 25 is not supported because of known memory issues.

## Installation

```bash
npm install -g dirac-cli
dirac auth
```

From a source checkout, install dependencies and build the executable from the repository root:

```bash
npm run install:all
npm run cli:build
node cli/dist/cli.mjs --help
```

## Running Dirac

Dirac has two terminal paths.

### Interactive mode

With an interactive stdin and stdout, Dirac renders the Ink interface. Run it without a prompt to open the composer, or provide a prompt to submit the first turn immediately:

```bash
dirac
dirac "Analyze this codebase"
dirac --plan "Design an implementation"
```

Interactive mode supports task approvals, follow-up messages, history, settings, model selection, skills, file mentions, image paste, and task resumption. `--auto-approve-all` keeps this interface while automatically approving actions.

### Goals, custom tools, and steering

Start a long-running Goal directly from an interactive terminal:

```bash
dirac "/goal Upgrade the application to the next major framework version"
```

Dirac can continue working toward that objective for hours or days, create and coordinate its own tasks, and pause when it needs input. Goals require the interactive Ink CLI; plain-text mode and ACP do not support them.

Build a reusable tool without leaving the conversation:

```bash
dirac "/new-tool Build a workspace-scoped tool that checks our deployment status"
```

Dirac generates, compiles, validates, and smoke-tests the tool. Task-scoped tools are immediately available; workspace and global tools appear in the **Tools** settings and default to disabled until you enable them.

While a regular task or Goal is working, type and submit another message to steer it. Dirac queues the message for the next safe model turn instead of cancelling the active work. Use `/settings` to configure low-verbosity responses, the Utility model, approval behavior, subagents, and other task features.

### Standalone mode

Dirac uses plain output when `--yolo` or `--json` is present, stdin is piped, or either terminal stream is redirected. `--yolo` auto-approves actionable cards and is intended for unattended execution:

```bash
dirac --yolo "Run the tests and fix failures"
git diff | dirac "Review these changes"
dirac --json "List the relevant files" > events.ndjson
```

In plain text mode, the final result is written to stdout. Progress, tool activity, summaries, warnings, and errors are written to stderr, so stdout can be safely piped into another command. Without `--yolo`, a standalone task exits with an error if it needs an approval or user feedback.

Piped bytes are preserved and placed before an optional prompt. Image-only tasks are valid.

## Agent Client Protocol (ACP)

Dirac can run as an external coding agent in ACP-compatible editors. The ACP Registry is the recommended installation path because the editor can install and update the agent package.

### Install from the ACP Registry

- **JetBrains IDEs 2025.3 and later**: open **Settings → Tools → AI Assistant → Agents**, or select **Install From ACP Registry…** in the agent picker. Find Dirac and select **Install**.
- **Zed**: open **Agent Settings → External Agents**, select **Add Agent → Install from Registry**, and install Dirac.

Start a Dirac thread after installation. If the selected provider is not already configured, Dirac offers the authentication methods supported by the client:

- **Configure a Dirac provider** opens a local browser page for provider, model, and API-key setup. This supports API-key providers such as DeepSeek.
- **Sign in with ChatGPT** configures the optional ChatGPT subscription provider.
- **Configure with environment variables** accepts explicit provider configuration from clients that support ACP environment authentication.
- **Configure Dirac in a terminal** runs the interactive setup when the client supports ACP terminal authentication.

ChatGPT is not required. Dirac's provider credentials and billing are separate from the editor's own model/provider settings.

### Configure DeepSeek or another provider with environment variables

The generic `DIRAC_*` variables select one provider explicitly for both Act and Plan modes:

```bash
DIRAC_PROVIDER=deepseek \
DIRAC_MODEL=deepseek-flash \
DIRAC_API_KEY="$DEEPSEEK_API_KEY" \
dirac --acp
```

- `DIRAC_PROVIDER`: Dirac provider ID, such as `deepseek`, `anthropic`, or `openrouter`.
- `DIRAC_MODEL`: Exact model ID for that provider.
- `DIRAC_API_KEY`: API key for API-key providers.
- `DIRAC_BASE_URL`: Optional custom endpoint for providers that support one.

For registry installations, enter these values through the client's environment authentication method or its per-agent environment settings. Explicit `DIRAC_*` values override persisted provider and model defaults for that ACP process.

### Configure before starting the editor

If an ACP client does not render Dirac's authentication methods, configure the shared Dirac home from a terminal first:

```bash
dirac auth
```

The next `dirac --acp` process reads that persisted configuration. When using a non-default home, pass the same `--config <path>` to both setup and ACP startup.

### Manual ACP configuration

Install the CLI globally, then add an equivalent agent-server entry to the client's ACP configuration (the surrounding configuration shape is client-specific):

```bash
npm install -g dirac-cli
```

```json
{
  "command": "dirac",
  "args": ["--acp"]
}
```

Use the executable's absolute path if the editor cannot resolve `dirac` from `PATH`. `--cwd <path>` can provide a default workspace when the client does not send one.

## Common commands

```bash
dirac auth                         # Configure a provider and model
dirac --acp                        # Run as an ACP agent for an editor
dirac "/askDirac How does edit_file work?" # Ask about this installed Dirac build
dirac history                      # Browse and resume prior tasks
dirac config                       # Show active configuration
dirac tools                        # List effective workspace tools
dirac update                       # Check for a newer CLI release
dirac --continue                   # Resume this workspace's latest task
dirac --taskId <id> "Follow up"    # Resume a specific task
dirac kanban                       # Run the Kanban integration
```

`dirac task` (alias `dirac t`) accepts the same task options as the default prompt command, except for root-only ACP, Kanban, and `--continue` options. Run `dirac --help` or `dirac task --help` for the complete current option list.

Frequently used task options include:

| Option | Effect |
| --- | --- |
| `--act`, `--plan` | Select the task mode. These options conflict. |
| `--yolo` | Use standalone output and auto-approve actions. |
| `--auto-approve-all` | Auto-approve actions while retaining the interactive interface. |
| `--model <id>` | Override the configured model. |
| `--provider <id-or-url>` | Override the provider; requires `--model`. |
| `--enable-tool <ids>` | Enable comma-separated tool IDs over the saved configuration. Repeatable. |
| `--disable-tool <ids>` | Disable comma-separated tool IDs over the saved configuration. Repeatable. |
| `--only-tools <ids>` | Use exactly these configurable tool IDs; cannot be combined with either delta option. |
| `--images <paths...>` | Attach PNG, JPEG, GIF, or WebP images. |
| `--thinking [tokens]` | Enable extended thinking; the default budget is 1024. |
| `--reasoning-effort <level>` | Set `none`, `low`, `medium`, `high`, or `xhigh`. |
| `--timeout <seconds>` | Stop a standalone task after a positive number of seconds. |
| `--verbose` | Expand reasoning and task diagnostics. |
| `--json` | Emit newline-delimited JSON events. |

Tool selections apply only to ordinary CLI tasks for the current invocation and are never persisted. They cannot be used with ACP, detached listen mode, Kanban, or Goals, and they never alter task-scoped tools. `--enable-tool` and `--disable-tool` may be combined when their resolved tool sets are disjoint. Lists accept canonical tool IDs or unambiguous tool names separated by commas, and each option may be repeated. Unknown, non-configurable, or conflicting tools stop startup with an error.

```bash
dirac --yolo --enable-tool read_file,edit_file --disable-tool use_subagents "Fix the issue"
dirac --only-tools read_file,search_files,respond "Analyze the workspace"
```

Run `dirac tools` to print the current configuration as copy-pasteable comma-separated `--enable-tool` and `--disable-tool` options.

Images can also be mentioned inline. `@/images/screenshot.png` is relative to the selected workspace; ordinary absolute and `./relative` paths are also accepted when the file exists.

## Authentication

Start the interactive setup with:

```bash
dirac auth
```

Quick setup is available when all required values are supplied:

```bash
dirac auth --provider anthropic --apikey "$ANTHROPIC_API_KEY" --modelid claude-sonnet-4-6
dirac auth --provider openai --apikey "$OPENAI_API_KEY" --modelid gpt-4o --baseurl https://api.example.com/v1
```

Provider API keys can also be supplied through their standard environment variables, including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, and `HF_TOKEN`.

## Terminal colors

Dark-terminal colors remain the default. When `COLORFGBG` identifies a light background, Dirac selects its high-contrast light palette automatically. Override detection with:

```bash
DIRAC_COLOR_MODE=light dirac
DIRAC_COLOR_MODE=dark dirac
```

You can also select **Light terminal theme** under **Settings → Features**; that persisted choice applies on the next CLI launch. `DIRAC_COLOR_MODE` takes precedence over the saved setting, and `DIRAC_COLOR_MODE=auto` restores detection with a dark fallback. Dirac also honors `NO_COLOR` and `FORCE_COLOR`; redirected output is uncolored unless color is forced.

## Configuration and environment

Dirac stores configuration under `~/.dirac/data/` and per-workspace state under `~/.dirac/data/workspaces/`. Use `--config <path>` or `DIRAC_DIR` to select another Dirac home directory.

Other useful environment variables are:

- `DIRAC_PROVIDER`, `DIRAC_MODEL`, `DIRAC_API_KEY`, and optional `DIRAC_BASE_URL` explicitly configure the provider used by CLI and ACP processes.
- `DIRAC_NO_AUTO_UPDATE=1` disables the background update check.
- `DIRAC_NO_EMOJI=1` selects Unicode/ASCII fallbacks for icons.
- `CUSTOM_HEADERS` supplies OpenAI-compatible custom headers in JSON or `key=value` form.
- `DIRAC_COMMAND_PERMISSIONS` restricts shell commands with allow and deny patterns.

See the installed `dirac(1)` manual for the complete command and environment reference.

## License

Dirac is licensed under the Apache License 2.0.
