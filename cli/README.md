# Dirac - Accurate & Highly Token Efficient Open Source AI Agent

<p align="center">
  <img src="https://github.com/dirac-run/dirac/blob/master/assets/media/diraccli.png?raw=true" width="70%" />
</p>

<p align="center">
  <a href="https://github.com/dirac-run/dirac"><strong>GitHub</strong></a> |
  <a href="https://www.npmjs.com/package/dirac-cli"><strong>NPM</strong></a> |
  <a href="https://discord.gg/mWkzrF4h"><strong>Discord</strong></a>
</p>



It is a well studied phenomenon that any given model's reasoning ability degrades with the context length. If we can keep context tightly curated, we improve both accuracy and cost while making larger changes tractable in a single task. 

Dirac is an open-source coding agent built with this in mind. It reduces API costs by **64.8%** on average while producing better and faster work. Using hash-anchored parallel edits, AST manipulation, and a suite of advanced optimizations. Oh, and no MCP.

Our goal: Optimize for bang-for-the-buck on tooling with bare minimum prompting instead of going blindly minimalistic.

## 📊 Evals

Dirac is benchmarked against other leading open-source agents on complex, real-world refactoring tasks. Dirac consistently achieves 100% accuracy at a fraction of the cost. These evals are run on public github repos and should be reproducible by anyone. 

| Task (Repo) | Files* | Cline | Kilo | Ohmypi | Opencode | Pimono | Roo | **Dirac** |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Task1 ([transformers](https://github.com/huggingface/transformers)) | 8 | 🟢 [$0.37] | 🔴 [N/A] | 🟡 [$0.24] | 🟢 [$0.20] | 🟢 [$0.34] | 🟢 [$0.49] | **🟢 [$0.13]** |
| Task2 ([vscode](https://github.com/microsoft/vscode)) | 21 | 🟢 [$0.67] | 🟡 [$0.78] | 🟢 [$0.63] | 🟢 [$0.40] | 🟢 [$0.48] | 🟡 [$0.58] | **🟢 [$0.23]** |
| Task3 ([vscode](https://github.com/microsoft/vscode)) | 12 | 🟡 [$0.42] | 🟢 [$0.70] | 🟢 [$0.64] | 🟢 [$0.32] | 🟢 [$0.25] | 🟡 [$0.45] | **🟢 [$0.16]** |
| Task4 ([django](https://github.com/django/django)) | 14 | 🟢 [$0.36] | 🟢 [$0.42] | 🟡 [$0.32] | 🟢 [$0.24] | 🟡 [$0.24] | 🟢 [$0.17] | **🟢 [$0.08]** |
| Task5 ([vscode](https://github.com/microsoft/vscode)) | 3 | 🔴 [N/A] | 🟢 [$0.71] | 🟢 [$0.43] | 🟢 [$0.53] | 🟢 [$0.50] | 🟢 [$0.36] | **🟢 [$0.17]** |
| Task6 ([transformers](https://github.com/huggingface/transformers)) | 25 | 🟢 [$0.87] | 🟡 [$1.51] | 🟢 [$0.94] | 🟢 [$0.90] | 🟢 [$0.52] | 🟢 [$1.44] | **🟢 [$0.34]** |
| Task7 ([vscode](https://github.com/microsoft/vscode)) | 13 | 🟡 [$0.51] | 🟢 [$0.77] | 🟢 [$0.74] | 🟢 [$0.67] | 🟡 [$0.45] | 🟢 [$1.05] | **🟢 [$0.25]** |
| Task8 ([transformers](https://github.com/huggingface/transformers)) | 3 | 🟢 [$0.25] | 🟢 [$0.19] | 🟢 [$0.17] | 🟢 [$0.26] | 🟢 [$0.23] | 🟢 [$0.29] | **🟢 [$0.12]** |
| **Total Correct** | | 5/8 | 5/8 | 6/8 | 8/8 | 6/8 | 6/8 | **8/8** |
| **Avg Cost** | | $0.49 | $0.73 | $0.51 | $0.44 | $0.38 | $0.60 | **$0.18** |

> 🟢 Success | 🟡 Incomplete | 🔴 Failure
> **Cost Comparison**: Dirac is **64.8% cheaper** than the competition (a **2.8x** cost reduction).
> \* Expected number of files to be modified/created to complete the task.
> See [evals/README.md](https://github.com/dirac-run/dirac/blob/master/evals/README.md) for detailed task descriptions and methodology.

## 🚀 Key Features

- **Hash-Anchored Edits**: Dirac uses stable line hashes to target edits with extreme precision, avoiding the "lost in translation" issues of traditional line-number based editing.
  ![Hash-Anchored Edits](https://www.dirac.run/static/images/multiple_edit.png)
- **AST-Native Precision**: Built-in understanding of language syntax (TypeScript, Python, C++, etc.) allows Dirac to perform structural manipulations like function extraction or class refactoring with 100% accuracy.
  ![AST-Native Precision](https://www.dirac.run/static/images/parallel_AST_edit.png)
- **Multi-File Batching**: Dirac can process and edit multiple files in a single LLM roundtrip, significantly reducing latency and API costs.
  ![Multi-File Batching](https://www.dirac.run/static/images/multi_function_read.png)
- **High-Bandwidth Context**: Optimized context curation keeps the agent lean and fast, ensuring the LLM always has the most relevant information without wasting tokens.
- **Autonomous Tool Use**: Dirac can read/write files, execute terminal commands, use a headless browser, and more - all while keeping you in control with an approval-based workflow.

## 📦 Installation

Install the Dirac CLI globally using npm:

```bash
npm install -g dirac-cli
```

Alternatively, use our official installation script (macOS/Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/dirac-run/dirac/master/scripts/install.sh | bash
```

## 🚀 Quick Start 

1. **Authenticate**:
   ```bash
   dirac auth
   ```
2. **Run your first task**:
   ```bash
   dirac "Analyze the architecture of this project"
   ```

### Configuration (Environment Variables)

You can provide API keys via environment variables to skip the `dirac auth` step. This is ideal for CI/CD or non-persistent environments:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `XAI_API_KEY` (x.ai)
- `HF_TOKEN` (HuggingFace)
- ... and others (see `src/shared/storage/env-config.ts` for the full list).

### Common Commands

- `dirac "prompt"`: Start an interactive task.
- `dirac -p "prompt"`: Run in **Plan Mode** to see the strategy before executing.
- `dirac -y "prompt"`: **Yolo Mode** (auto-approve all actions, great for simple fixes).
- `git diff | dirac "Review these changes"`: Pipe context directly into Dirac.
- `dirac history`: View and resume previous tasks.

## 📄 License

Dirac is **open source** and licensed under the [Apache License 2.0](LICENSE).

## 🤝 Acknowledgments

Dirac is a fork of the excellent [Cline](https://github.com/cline/cline) project. We are grateful to the Cline team and contributors for their foundational work.

---

Built with ❤️ by [Max Trivedi](https://www.linkedin.com/in/max-trivedi-49993aab/) at [Dirac Delta Labs](https://dirac.run)
