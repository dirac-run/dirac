# Dirac, an Open-source AI coding agent for efficiently doing complex work 

Dirac is built for long-running software-engineering work, precise codebase changes, and efficient model use.

## What is Dirac?

Dirac is an open-source coding agent you can use in VS Code, from the terminal, or through any compatible [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) client. It supports **dozens of providers and hundreds of models**, so you can bring the models and credentials that fit your workflow instead of being locked into one stack.

Dirac combines autonomous task execution with purpose-built code tools: hash-anchored file editing, syntax-tree inspection and refactoring, parallel operations, subagents, continuous steering, and configurable permission controls. The goal is simple: give capable models better infrastructure so they can work longer, faster, and with less token overhead.

## Sponsors

<a href="https://unbiased.ai/">
  <img src="assets/sponsors/unbiased-icon.png" alt="" height="40" />
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/sponsors/unbiased-wordmark-dark.png" />
    <img src="assets/sponsors/unbiased-wordmark.png" alt="Unbiased AI" height="32" />
  </picture>
</a>

Thank you to [Unbiased AI](https://unbiased.ai/) for sponsoring Dirac's open-source development.

Interested in sponsoring Dirac? [Get in touch](https://dirac.run/contact).

## Why Dirac?

<details>
<summary><strong>Available in VS Code, Open VSX, the CLI, and ACP clients</strong></summary>

Install the extension from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=dirac-run.dirac) or [Open VSX](https://open-vsx.org/extension/dirac-run/dirac), run Dirac in any terminal with the CLI, or use it from ACP-compatible editors such as JetBrains IDEs and Zed. Your provider configuration stays with Dirac across these interfaces.

</details>

<details>
<summary><strong>Goal mode: give Dirac a goal and walk away</strong></summary>

Start an interactive CLI session with `/goal <objective>`. Dirac can keep working toward the same objective for hours or days without drifting, autonomously creating and coordinating tasks until the goal is achieved. It pauses when it needs your input, and you can check in, steer, pause, resume, or stop it at any time.

![An achieved Goal with delegated work, timing, token, cache, and cost accounting](assets/media/goal.png)

</details>

<details>
<summary><strong>Dirac can extend itself</strong></summary>

Use `/new-tool <description>` to build a tool tailored to your workflow while you work. Dirac turns the requirements into a typed tool, compiles it, validates it, and smoke-tests it. Task-scoped tools are available immediately; persistent workspace and global tools appear in the **Tools** tab and can be enabled without starting a new conversation.

Tool creation must be enabled. Smoke commands follow your configured approval policy.

![Dirac building and then using a custom weather tool in the same conversation](assets/media/tool-building.png)

</details>

<details>
<summary><strong>Low-verbosity responses</strong></summary>

Models do not need to narrate every routine step. Enable **Low-verbosity responses** to keep progress and final answers concise while preserving decisions, caveats, failures, and verification results.

![A concise task completion with changes and verification results](assets/media/models-speak-less.png)

</details>

<details>
<summary><strong>Steer it while it works</strong></summary>

If something occurs to you after a task starts, send another message at any time. Dirac queues it and delivers it to the model with the next tool response, updating the work without cancelling or restarting the task.

![A steering message delivered without interrupting the active task](assets/media/steering.png)

</details>

<details>
<summary><strong>Use a separate Utility model for supporting work</strong></summary>

Route context compaction, new-task handoffs, commit-message generation, and permission decisions to a separate, cheaper model so the main model can stay focused on implementation. In our context-compaction case study, this model arbitrage reduced cost by more than 80%: [Sol vs. Luna: token arbitrage for AI agents](https://dirac.run/posts/token-arbitrage-sol-vs-luna).

![Utility model use cases and configuration](assets/media/utility.png)

</details>

<details>
<summary><strong>No more approval fatigue</strong></summary>

Configure the Utility model as the first pass for permission requests and give it an explicit natural-language policy. It approves requests that satisfy the policy and escalates unsafe or uncertain requests to you. Every automatic approval remains visible in the transcript with its reason.

</details>

<details>
<summary><strong>Hash-anchored file editing</strong></summary>

Dirac uses a custom stable line-anchor protocol instead of brittle search-and-replace blocks. The model can identify an exact source range by its anchors and replace only that range, even after nearby lines move. This reduces edit payloads, ambiguity, and retries. [Read how hash anchors and Myers diff make editing more efficient](https://dirac.run/posts/hash-anchors-myers-diff-single-token).

![Dirac applying precise edits through stable source anchors](assets/media/multiple_edit.png)

</details>

<details>
<summary><strong>AST code inspection</strong></summary>

Dirac uses the codebase's syntax trees to inspect structure without reading entire files. The model can request outlines of many files or retrieve one exact implementation and its references:

```text
inspect_ast(operation: "outline", paths: ["utils/db.py"])
inspect_ast(operation: "implementation", paths: ["utils/db.py"], symbols: ["DBManager.init_db"])
```

![Dirac AST inspection results listing extracted functions and inspected files](assets/media/inspect-ast.png)

Structural results depend on parser and index coverage. Dynamic references require separate verification.

</details>

<details>
<summary><strong>AST code manipulation</strong></summary>

Structural edits operate on symbols rather than approximate text matches. Dirac can replace one complete function or rename hundreds of indexed references in one call:

```text
edit_ast(operation: "replace", targets: [{ path: "utils/db.py", symbol: "DBManager.init_db", replacement: "..." }])
edit_ast(operation: "rename", targets: [{ path: "src/", symbol: "old_name", replacement: "new_name" }])
```

![Dirac renaming exact symbols across a codebase](assets/media/parallel_AST_edit.png)

</details>

<details>
<summary><strong>Ask Dirac questions about itself</strong></summary>

Every Dirac build ships with its source. Use `/askDirac <question>` to ask how the installed version works; Dirac receives read-only access to its own functional source so it can answer against the build you are running.

![An askDirac question about the edit_file tool and Dirac's answer](assets/media/ask-dirac.png)

</details>

<details>
<summary><strong>Parallel code edits</strong></summary>

Dirac's tool protocol lets models batch independent reads, searches, edits, and commands in one response. Coordinated changes across multiple files happen together instead of requiring a separate model round trip for every operation.

![Dirac applying many independent file edits in parallel](assets/media/parallel_edits.png)

</details>

<details>
<summary><strong>Review one multi-file change</strong></summary>

When automatic approval is disabled, Dirac groups related changes into a single multi-file diff view. You can review the complete change as one unit instead of opening and approving a sequence of disconnected file edits.

</details>

<details>
<summary><strong>Opportunistic first-request enrichment</strong></summary>

Before the first request reaches the model, Dirac detects likely filenames, directory paths, and symbol names and assembles a bounded context packet. Named symbols receive definition-first context and indexed references.

You can also mention Git changes, workspace diagnostics, terminal output, URLs, text files, PDFs, DOCX files, spreadsheets, notebooks, and images. Applicable `AGENTS.md` instructions, matching rules, and active skills join the request as repository guidance.

</details>

<details>
<summary><strong>Concurrent, first-class subagents</strong></summary>

Subagents can research, edit, run commands, and validate work concurrently. Each receives complete assignment instructions rather than a copy of the parent conversation, runs under the parent's authority, and has no automatic execution deadline. The main agent creates and supervises children through `subagents`; `send_message` provides ordinary peer communication, and `shared_journal` stores longer findings once for interested agents to read. Neither messages nor publications grant permissions or restart completed children. Dirac tracks source freshness and rejects stale edits at write time; agents still share workspace contents.

Agents run in the background without streaming separate cards into the main chat. The status area shows the active count; `/agents` prints a frozen local snapshot without sending anything to the model. In the CLI, `/agent` opens a read-only transcript browser with explicit refresh and paging. Ask the main agent to guide, stop, or resume a child—there is no direct child chat or approval surface.

![Multiple subagents working concurrently](assets/media/subagents.png)

</details>

<details>
<summary><strong>Repository-aware execution</strong></summary>

Path-aware instructions, rules, skills, workflows, and hooks carry repository guidance into each task. Permissions are evaluated at tool boundaries, command batches report exit status and bounded output, and Chromium checks return screenshots, console messages, page errors, and the current URL.

Dirac can also isolate work in a Git worktree with integration and cleanup controls. Browser interaction uses screenshots and coordinates; the main-worktree flow expects a clean, single-root Git workspace.

</details>

<details>
<summary><strong>Continuity for long-running tasks</strong></summary>

Context condensation preserves decisions, exact paths, failed attempts, and validation state. Separate bounded recovery paths handle transient provider errors, context overflow, empty responses, and interrupted tool loops.

Plan, Act, and Utility work can use separate model configurations. Reviewed handoffs can move remaining work into a fresh task, while task IDs support resuming work across VS Code, the CLI, pipelines, and compatible ACP clients.

</details>

<details>
<summary><strong>Restore points</strong></summary>

Checkpoints capture workspace files and operational task state. Restore can apply to the workspace, the task, or both, including queued steering, active skills, task tools, and context tracking.

</details>

## Harness comparison

We benchmarked Dirac and other open-source agent harnesses on eight multi-file refactoring tasks from public GitHub repositories. In this comparison, every harness used `gemini-3-flash-preview` with thinking set to `high`. Dirac completed all eight tasks at the lowest average cost.

> **Cost note:** A bug discovered in Cline after these runs ([issue #10314](https://github.com/cline/cline/issues/10314), [PR #10315](https://github.com/cline/cline/pull/10315)) caused the Dirac and Cline results to slightly underreport cache-read costs ($0.03 instead of $0.05 per million tokens).

| Task (repository) | Files* | Cline | Kilo | Ohmypi | Opencode | Pimono | Roo | **Dirac** |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| DynamicCache ([Transformers](https://github.com/huggingface/transformers)) | 8 | 🟢 [(diff)](evals/cline/cline_refactor_DynamicCache) [$0.37] | 🔴 [(diff)](evals/kilo/kilo_code_refactor_DynamicCache_FAILURE) [N/A] | 🟡 [(diff)](evals/ohmypi/ohmypi_refactor_DynamicCache) [$0.24] | 🟢 [(diff)](evals/opencode/opencode_refactor_DynamicCache) [$0.20] | 🟢 [(diff)](evals/pimono/pimono_refactor_DynamicCache) [$0.34] | 🟢 [(diff)](evals/roo/roo_code_refactor_DynamicCache) [$0.49] | **🟢 [(diff)](evals/dirac/dirac_refactor_DynamicCache) [$0.13]** |
| IOverlayWidget ([VS Code](https://github.com/microsoft/vscode)) | 21 | 🟢 [(diff)](evals/cline/cline_refactor_IOverlayWidget) [$0.67] | 🟡 [(diff)](evals/kilo/kilo_code_refactor_IOverlayWidget) [$0.78] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_IOverlayWidget) [$0.63] | 🟢 [(diff)](evals/opencode/opencode_refactor_IOverlayWidget) [$0.40] | 🟢 [(diff)](evals/pimono/pimono_refactor_IOverlayWidget) [$0.48] | 🟡 [(diff)](evals/roo/roo_code_refactor_IOverlayWidget) [$0.58] | **🟢 [(diff)](evals/dirac/dirac_refactor_IOverlayWidget) [$0.23]** |
| addLogging ([VS Code](https://github.com/microsoft/vscode)) | 12 | 🟡 [(diff)](evals/cline/cline_refactor_addLogging) [$0.42] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_addLogging) [$0.70] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_addLogging) [$0.64] | 🟢 [(diff)](evals/opencode/opencode_refactor_addLogging) [$0.32] | 🟢 [(diff)](evals/pimono/pimono_refactor_addLogging) [$0.25] | 🟡 [(diff)](evals/roo/roo_code_refactor_addLogging) [$0.45] | **🟢 [(diff)](evals/dirac/dirac_refactor_addLogging) [$0.16]** |
| datadict ([Django](https://github.com/django/django)) | 14 | 🟢 [(diff)](evals/cline/cline_refactor_datadict) [$0.36] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_datadict) [$0.42] | 🟡 [(diff)](evals/ohmypi/ohmypi_refactor_datadict) [$0.32] | 🟢 [(diff)](evals/opencode/opencode_refactor_datadict) [$0.24] | 🟡 [(diff)](evals/pimono/pimono_refactor_datadict) [$0.24] | 🟢 [(diff)](evals/roo/roo_code_refactor_datadict) [$0.17] | **🟢 [(diff)](evals/dirac/dirac_refactor_datadict) [$0.08]** |
| extensionsWorkbenchService ([VS Code](https://github.com/microsoft/vscode)) | 3 | 🔴 [(diff)](evals/cline/cline_refactor_extensionswb_service_FAILURE) [N/A] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_extensionswb_service) [$0.71] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_extensionswb_service) [$0.43] | 🟢 [(diff)](evals/opencode/opencode_refactor_extensionswb_service) [$0.53] | 🟢 [(diff)](evals/pimono/pimono_refactor_extensionswb_service) [$0.50] | 🟢 [(diff)](evals/roo/roo_code_refactor_extensionswb_service) [$0.36] | **🟢 [(diff)](evals/dirac/dirac_refactor_extensionswb_service) [$0.17]** |
| latency ([Transformers](https://github.com/huggingface/transformers)) | 25 | 🟢 [(diff)](evals/cline/cline_refactor_latency) [$0.87] | 🟡 [(diff)](evals/kilo/kilo_code_refactor_latency_WRONG) [$1.51] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_latency) [$0.94] | 🟢 [(diff)](evals/opencode/opencode_refactor_latency) [$0.90] | 🟢 [(diff)](evals/pimono/pimono_refactor_latency) [$0.52] | 🟢 [(diff)](evals/roo/roo_code_refactor_latency) [$1.44] | **🟢 [(diff)](evals/dirac/dirac_refactor_latency) [$0.34]** |
| sendRequest ([VS Code](https://github.com/microsoft/vscode)) | 13 | 🟡 [(diff)](evals/cline/cline_refactor_sendRequest_2missing) [$0.51] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_sendRequest) [$0.77] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_sendRequest) [$0.74] | 🟢 [(diff)](evals/opencode/opencode_refactor_sendRequest) [$0.67] | 🟡 [(diff)](evals/pimono/pimono_refactor_sendRequest) [$0.45] | 🟢 [(diff)](evals/roo/roo_code_refactor_sendRequest) [$1.05] | **🟢 [(diff)](evals/dirac/dirac_refactor_sendRequest) [$0.25]** |
| stoppingcriteria ([Transformers](https://github.com/huggingface/transformers)) | 3 | 🟢 [(diff)](evals/cline/cline_refactor_stoppingcriteria) [$0.25] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_stoppingcriteria) [$0.19] | 🟢 [(diff)](evals/ohmypi/ohmypi_code_refactor_stoppingcriteria) [$0.17] | 🟢 [(diff)](evals/opencode/opencode_refactor_stoppingcriteria) [$0.26] | 🟢 [(diff)](evals/pimono/pimono_code_refactor_stoppingcriteria) [$0.23] | 🟢 [(diff)](evals/roo/roo_code_refactor_stoppingcriteria) [$0.29] | **🟢 [(diff)](evals/dirac/dirac_refactor_stoppingcriteria) [$0.12]** |
| **Total correct** | | 5/8 | 5/8 | 6/8 | 8/8 | 6/8 | 6/8 | **8/8** |
| **Average cost** | | $0.49 | $0.73 | $0.51 | $0.44 | $0.38 | $0.60 | **$0.18** |

> 🟢 Success \| 🟡 Incomplete \| 🔴 Failure
>
> \* Expected number of files to be modified or created. See [evals/README.md](evals/README.md) for the exact tasks and methodology.

## Install Dirac

| Interface | Installation |
| --- | --- |
| VS Code | [Install from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=dirac-run.dirac) |
| Open VSX | [Install from Open VSX](https://open-vsx.org/extension/dirac-run/dirac) |
| CLI | `npm install -g dirac-cli` |
| ACP | Install Dirac from your editor's ACP Registry, or run `dirac --acp` manually |

The CLI requires Node.js 22.13 through 24.x and npm. Node.js 25 is not supported because of known memory issues.

## Quick start

### VS Code or an Open VSX editor

1. Install Dirac and open its sidebar.
2. Select a provider and model, then add the provider credentials.
3. Describe what you want to build, fix, investigate, or review.
4. Approve actions as needed, or configure an autonomy policy in **Settings**.

### CLI

```bash
npm install -g dirac-cli
dirac auth
dirac "Analyze the architecture of this project"
```

Useful ways to start:

```bash
dirac                              # Open the interactive composer
dirac --plan "Design this feature" # Start in Plan mode
dirac --yolo "Fix the tests"       # Run unattended with plain output
git diff | dirac "Review this"     # Pipe context directly to Dirac
dirac history                      # Resume previous work
```

See the [CLI guide](cli/README.md) for Goal mode, custom tools, task resumption, JSON output, model overrides, and the complete configuration reference.

### ACP editors

Dirac can run as an external agent in ACP-compatible editors, including JetBrains IDEs and Zed. Installing it from the editor's ACP Registry is recommended so the client can manage installation and updates.

- **JetBrains IDEs 2025.3 and later:** open **Settings → Tools → AI Assistant → Agents**, or select **Install From ACP Registry…** from the agent picker.
- **Zed:** open **Agent Settings → External Agents**, then select **Add Agent → Install from Registry**.

Dirac manages its provider credentials independently from the editor. See the [ACP setup guide](cli/README.md#agent-client-protocol-acp) for authentication, environment variables, manual configuration, and troubleshooting.

## Providers and configuration

Dirac supports API-key providers, subscription-backed providers, cloud platforms, and OpenAI-compatible endpoints. Configure interactively in the extension or with `dirac auth` in the CLI.

Common environment variables include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, and `HF_TOKEN`. For process-specific CLI or ACP configuration, use `DIRAC_PROVIDER`, `DIRAC_MODEL`, `DIRAC_API_KEY`, and optional `DIRAC_BASE_URL`.

See [Provider-specific settings](docs/providers/README.md) for AWS Bedrock and Google Cloud Vertex AI, and the [CLI authentication guide](cli/README.md#authentication) for terminal setup.

## Development

```bash
npm run install:all
npm run protos
npm run compile
npm run lint
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines. Unit and integration test commands are documented in the root [`package.json`](package.json).

## Star history

<a href="https://star-history.com/#dirac-run/dirac&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=dirac-run/dirac&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=dirac-run/dirac&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=dirac-run/dirac&type=Date" />
  </picture>
</a>

## License

Dirac is open source under the [Apache License 2.0](LICENSE).

## Acknowledgments

Dirac is a fork of [Cline](https://github.com/cline/cline). We are grateful to the Cline team and contributors for their foundational work.

Built by [Max Trivedi](https://www.linkedin.com/in/max-trivedi-49993aab/) at [Dirac Delta Labs](https://dirac.run).
