# Dirac - Accurate & Highly Token Efficient Open Source AI Agent

> **Dirac topped the [Terminal-Bench-2 leaderboard](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/145) for `gemini-3-flash-preview` with a 65.2% score!**


It is a well studied phenomenon that any given model's reasoning ability degrades with the context length. If we can keep context tightly curated, we improve both accuracy and cost while making larger changes tractable in a single task. 

Dirac is an open-source coding agent built with this in mind. It reduces API costs by **64.8%** on average while producing better and faster work. Using hash-anchored parallel edits, AST manipulation, and a suite of advanced optimizations. Oh, and no MCP.

Our goal: Optimize for bang-for-the-buck on tooling with bare minimum prompting instead of going blindly minimalistic.

## 📊 Evals

Dirac is benchmarked against other leading open-source agents on complex, real-world refactoring tasks. Dirac consistently achieves 100% accuracy at a fraction of the cost. These evals are run on public github repos and should be reproducible by anyone. 

> 🏆 **TerminalBench 2.0 Leaderboard**: Dirac recently topped the [Terminal-Bench-2 leaderboard](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/145) with a **65.2%** score using `gemini-3-flash-preview`. This outperforms both Google's official baseline (**47.6%**) and the top closed-source agent Junie CLI (**64.3%**). This was achieved without any benchmark-specific info or any `AGENTS.md` files being inserted.


> **Note on the cost table below**: A bug was discovered in Cline, the parent repo, after running these evals ([issue #10314](https://github.com/cline/cline/issues/10314)). We have submitted a [PR #10315](https://github.com/cline/cline/pull/10315) to fix this. This bug caused the evals for Dirac and Cline to slightly underreport the numbers ($0.03 vs $0.05 per million token cache read). Although there won't be a large difference, we will update the evals soon.

All tasks for all models used `gemini-3-flash-preview` with thinking set to `high`

| Task (Repo) | Files* | Cline | Kilo | Ohmypi | Opencode | Pimono | Roo | **Dirac** |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Task1 ([transformers](https://github.com/huggingface/transformers)) | 8 | 🟢 [(diff)](evals/cline/cline_refactor_DynamicCache) [$0.37] | 🔴 [(diff)](evals/kilo/kilo_code_refactor_DynamicCache_FAILURE) [N/A] | 🟡 [(diff)](evals/ohmypi/ohmypi_refactor_DynamicCache) [$0.24] | 🟢 [(diff)](evals/opencode/opencode_refactor_DynamicCache) [$0.20] | 🟢 [(diff)](evals/pimono/pimono_refactor_DynamicCache) [$0.34] | 🟢 [(diff)](evals/roo/roo_code_refactor_DynamicCache) [$0.49] | **🟢 [(diff)](evals/dirac/dirac_refactor_DynamicCache) [$0.13]** |
| Task2 ([vscode](https://github.com/microsoft/vscode)) | 21 | 🟢 [(diff)](evals/cline/cline_refactor_IOverlayWidget) [$0.67] | 🟡 [(diff)](evals/kilo/kilo_code_refactor_IOverlayWidget) [$0.78] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_IOverlayWidget) [$0.63] | 🟢 [(diff)](evals/opencode/opencode_refactor_IOverlayWidget) [$0.40] | 🟢 [(diff)](evals/pimono/pimono_refactor_IOverlayWidget) [$0.48] | 🟡 [(diff)](evals/roo/roo_code_refactor_IOverlayWidget) [$0.58] | **🟢 [(diff)](evals/dirac/dirac_refactor_IOverlayWidget) [$0.23]** |
| Task3 ([vscode](https://github.com/microsoft/vscode)) | 12 | 🟡 [(diff)](evals/cline/cline_refactor_addLogging) [$0.42] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_addLogging) [$0.70] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_addLogging) [$0.64] | 🟢 [(diff)](evals/opencode/opencode_refactor_addLogging) [$0.32] | 🟢 [(diff)](evals/pimono/pimono_refactor_addLogging) [$0.25] | 🟡 [(diff)](evals/roo/roo_code_refactor_addLogging) [$0.45] | **🟢 [(diff)](evals/dirac/dirac_refactor_addLogging) [$0.16]** |
| Task4 ([django](https://github.com/django/django)) | 14 | 🟢 [(diff)](evals/cline/cline_refactor_datadict) [$0.36] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_datadict) [$0.42] | 🟡 [(diff)](evals/ohmypi/ohmypi_refactor_datadict) [$0.32] | 🟢 [(diff)](evals/opencode/opencode_refactor_datadict) [$0.24] | 🟡 [(diff)](evals/pimono/pimono_refactor_datadict) [$0.24] | 🟢 [(diff)](evals/roo/roo_code_refactor_datadict) [$0.17] | **🟢 [(diff)](evals/dirac/dirac_refactor_datadict) [$0.08]** |
| Task5 ([vscode](https://github.com/microsoft/vscode)) | 3 | 🔴 [(diff)](evals/cline/cline_refactor_extensionswb_service_FAILURE) [N/A] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_extensionswb_service) [$0.71] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_extensionswb_service) [$0.43] | 🟢 [(diff)](evals/opencode/opencode_refactor_extensionswb_service) [$0.53] | 🟢 [(diff)](evals/pimono/pimono_refactor_extensionswb_service) [$0.50] | 🟢 [(diff)](evals/roo/roo_code_refactor_extensionswb_service) [$0.36] | **🟢 [(diff)](evals/dirac/dirac_refactor_extensionswb_service) [$0.17]** |
| Task6 ([transformers](https://github.com/huggingface/transformers)) | 25 | 🟢 [(diff)](evals/cline/cline_refactor_latency) [$0.87] | 🟡  [(diff)](evals/kilo/kilo_code_refactor_latency_WRONG) [$1.51] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_latency) [$0.94] | 🟢 [(diff)](evals/opencode/opencode_refactor_latency) [$0.90] | 🟢 [(diff)](evals/pimono/pimono_refactor_latency) [$0.52] | 🟢 [(diff)](evals/roo/roo_code_refactor_latency) [$1.44] | **🟢 [(diff)](evals/dirac/dirac_refactor_latency) [$0.34]** |
| Task7 ([vscode](https://github.com/microsoft/vscode)) | 13 | 🟡 [(diff)](evals/cline/cline_refactor_sendRequest_2missing) [$0.51] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_sendRequest) [$0.77] | 🟢 [(diff)](evals/ohmypi/ohmypi_refactor_sendRequest) [$0.74] | 🟢 [(diff)](evals/opencode/opencode_refactor_sendRequest) [$0.67] | 🟡 [(diff)](evals/pimono/pimono_refactor_sendRequest) [$0.45] | 🟢 [(diff)](evals/roo/roo_code_refactor_sendRequest) [$1.05] | **🟢 [(diff)](evals/dirac/dirac_refactor_sendRequest) [$0.25]** |
| Task8 ([transformers](https://github.com/huggingface/transformers)) | 3 | 🟢 [(diff)](evals/cline/cline_refactor_stoppingcriteria) [$0.25] | 🟢 [(diff)](evals/kilo/kilo_code_refactor_stoppingcriteria) [$0.19] | 🟢 [(diff)](evals/ohmypi/ohmypi_code_refactor_stoppingcriteria) [$0.17] | 🟢 [(diff)](evals/opencode/opencode_refactor_stoppingcriteria) [$0.26] | 🟢 [(diff)](evals/pimono/pimono_code_refactor_stoppingcriteria) [$0.23] | 🟢 [(diff)](evals/roo/roo_code_refactor_stoppingcriteria) [$0.29] | **🟢 [(diff)](evals/dirac/dirac_refactor_stoppingcriteria) [$0.12]** |
| **Total Correct** | | 5/8 | 5/8 | 6/8 | 8/8 | 6/8 | 6/8 | **8/8** |
| **Avg Cost** | | $0.49 | $0.73 | $0.51 | $0.44 | $0.38 | $0.60 | **$0.18** |

> 🟢 Success \| 🟡 Incomplete \| 🔴 Failure

> **Cost Comparison**: Dirac is **64.8% cheaper** than the competition (a **2.8x** cost reduction).
>
> \* Expected number of files to be modified/created to complete the task.
>
> See [evals/README.md](evals/README.md) for detailed task descriptions and methodology.


## 🚀 Key Features

- **Hash-Anchored Edits**: Dirac uses stable line hashes to target edits with extreme precision, avoiding the "lost in translation" issues of traditional line-number based editing.
  ![Hash-Anchored Edits](https://www.dirac.run/static/images/multiple_edit.png)
- **AST-Native Precision**: Built-in understanding of language syntax (TypeScript, Python, C++, etc.) allows Dirac to perform structural manipulations like function extraction or class refactoring with 100% accuracy.
  ![AST-Native Precision](https://www.dirac.run/static/images/parallel_AST_edit.png)
- **Multi-File Batching**: Dirac can process and edit multiple files in a single LLM roundtrip, significantly reducing latency and API costs.
  ![Multi-File Batching](https://www.dirac.run/static/images/multi_function_read.png)
- **High-Bandwidth Context**: Optimized context curation keeps the agent lean and fast, ensuring the LLM always has the most relevant information without wasting tokens.
- **Autonomous Tool Use**: Dirac can read/write files, execute terminal commands, use a headless browser, and more - all while keeping you in control with an approval-based workflow.
- **Skills & AGENTS.md**: Customize Dirac's behavior with project-specific instructions using `AGENTS.md` files. It also seamlessly picks up Claude's skills by automatically reading from `.ai`, `.claude`, and `.agents` directories.
- **Native Tool Calling Only**: To ensure maximum reliability and performance, Dirac exclusively supports models with native tool calling enabled. (Note: MCP is not supported).

## 📦 Installation

### VS Code Extension
Install Dirac from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=dirac-run.dirac).

### CLI (Terminal)
Install the Dirac CLI globally using npm:
```bash
npm install -g dirac-cli
```

> **Note**: Node.js v25 is currently not supported due to an upstream V8 Turboshaft compiler bug that causes out-of-memory crashes during WASM initialization. Please use Node.js v20, v22, or v24 (LTS versions).

## 🚀 CLI Quick Start 

1. **Authenticate**:
   ```bash
   dirac auth
   ```
2. **Run your first task**:
   ```bash
   dirac "Analyze the architecture of this project"
   ```

### Configuration (Environment Variables)
You can provide API keys via environment variables to skip the `dirac auth` step. This is ideal for CI/CD or non-persistent environments.

For provider-specific setup (e.g. [AWS Bedrock](docs/providers/README.md#aws-bedrock), [Google Cloud Vertex AI](docs/providers/README.md#google-cloud-vertex-ai)), see the [Provider Settings](docs/providers/README.md) guide.

Common API Keys:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `XAI_API_KEY` (x.ai)
- `HF_TOKEN` (HuggingFace)
- ... and others (see `src/shared/storage/env-config.ts` for the full list).

#### Using Any OpenAI compatible endpoint

You can use OPENAI_COMPATIBLE_CUSTOM_KEY (or its alias OPENAI_API_BASE) for any provider and model as long as it exposes an OpenAI compatible endpoint. Using these variables requires providing both the model and the provider in the cli

`$ OPENAI_API_BASE="xxx" dirac -y --provider "https://api.deepseek.com/v1" --model deepseek-v4-flash "explain Dirac Delta function"`


### Common Commands
- `dirac "prompt"`: Start an interactive task.
- `dirac -p "prompt"`: Run in **Plan Mode** to see the strategy before executing.
- `dirac -y "prompt"`: **Yolo Mode** (auto-approve all actions, great for simple fixes).
- `git diff | dirac "Review these changes"`: Pipe context directly into Dirac.
- `dirac history`: View and resume previous tasks.


## 🛠️ Getting Started

1. Open the Dirac sidebar in VS Code.
2. Configure your preferred AI provider (Anthropic, OpenAI, OpenRouter, etc.).
3. Start a new task by describing what you want to build or fix.
4. Watch Dirac go!


## 📈 Star History

<a href="https://star-history.com/#dirac-run/dirac&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=dirac-run/dirac&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=dirac-run/dirac&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=dirac-run/dirac&type=Date" />
  </picture>
</a>


## 📄 License

Dirac is **open source** and licensed under the [Apache License 2.0](LICENSE).

## 🤝 Acknowledgments

Dirac is a fork of the excellent [Cline](https://github.com/cline/cline) project. We are grateful to the Cline team and contributors for their foundational work.

---

Built with ❤️ by [Max Trivedi](https://www.linkedin.com/in/max-trivedi-49993aab/) at [Dirac Delta Labs](https://dirac.run)
