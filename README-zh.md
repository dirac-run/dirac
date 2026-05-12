# Dirac - 精准且高效 Token 使用的开源 AI 代理

> **Dirac 在 [Terminal-Bench-2 排行榜](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/145) 中以 65.2% 的得分位居 `gemini-3-flash-preview` 榜首！**


一个经过充分研究的现象是，任何给定模型的推理能力会随着上下文长度的增加而下降。如果我们能保持上下文的精心策划，就能提高准确性和成本效益，同时使更大的更改在单个任务中变得可行。

Dirac 是一个以此为理念构建的开源编码代理。它平均减少 **64.8%** 的 API 成本，同时产生更好更快的工作成果。使用哈希锚定的并行编辑、AST 操作和一系列高级优化。哦，而且没有 MCP。

我们的目标：在工具上优化性价比，使用最少的提示，而不是盲目追求极简。

## 📊 评估

Dirac 在复杂的、真实世界的重构任务上与其他领先的开源代理进行了基准测试。Dirac 以极低成本始终达到 100% 的准确率。这些评估在公开的 GitHub 仓库上运行，任何人都可以复现。

> 🏆 **TerminalBench 2.0 排行榜**：Dirac 最近以 **65.2%** 的得分使用 `gemini-3-flash-preview` 在 [Terminal-Bench-2 排行榜](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/145) 中位居榜首。这超越了 Google 的官方基线（**47.6%**）和排名第一的闭源代理 Junie CLI（**64.3%**）。这是在没有插入任何基准特定信息或 `AGENTS.md` 文件的情况下实现的。


> **关于下方成本表的说明**：在运行这些评估后，在 Cline（父仓库）中发现了一个 bug（[issue #10314](https://github.com/cline/cline/issues/10314)）。我们已提交 [PR #10315](https://github.com/cline/cline/pull/10315) 来修复。此 bug 导致 Dirac 和 Cline 的评估略微低估了数字（$0.03 vs $0.05 每百万 token 缓存读取）。虽然差异不大，但我们很快会更新评估。

所有任务的所有模型都使用 `gemini-3-flash-preview`，thinking 设置为 `high`

| 任务 (仓库) | 文件数* | Cline | Kilo | Ohmypi | Opencode | Pimono | Roo | **Dirac** |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Task1 ([transformers](https://github.com/huggingface/transformers)) | 8 | 🟢 [$0.37] | 🔴 [N/A] | 🟡 [$0.24] | 🟢 [$0.20] | 🟢 [$0.34] | 🟢 [$0.49] | **🟢 [$0.13]** |
| Task2 ([vscode](https://github.com/microsoft/vscode)) | 21 | 🟢 [$0.67] | 🟡 [$0.78] | 🟢 [$0.63] | 🟢 [$0.40] | 🟢 [$0.48] | 🟡 [$0.58] | **🟢 [$0.23]** |
| Task3 ([vscode](https://github.com/microsoft/vscode)) | 12 | 🟡 [$0.42] | 🟢 [$0.70] | 🟢 [$0.64] | 🟢 [$0.32] | 🟢 [$0.25] | 🟡 [$0.45] | **🟢 [$0.16]** |
| Task4 ([django](https://github.com/django/django)) | 14 | 🟢 [$0.36] | 🟢 [$0.42] | 🟡 [$0.32] | 🟢 [$0.24] | 🟡 [$0.24] | 🟢 [$0.17] | **🟢 [$0.08]** |
| Task5 ([vscode](https://github.com/microsoft/vscode)) | 3 | 🔴 [N/A] | 🟢 [$0.71] | 🟢 [$0.43] | 🟢 [$0.53] | 🟢 [$0.50] | 🟢 [$0.36] | **🟢 [$0.17]** |
| Task6 ([transformers](https://github.com/huggingface/transformers)) | 25 | 🟢 [$0.87] | 🟡 [$1.51] | 🟢 [$0.94] | 🟢 [$0.90] | 🟢 [$0.52] | 🟢 [$1.44] | **🟢 [$0.34]** |
| Task7 ([vscode](https://github.com/microsoft/vscode)) | 13 | 🟡 [$0.51] | 🟢 [$0.77] | 🟢 [$0.74] | 🟢 [$0.67] | 🟡 [$0.45] | 🟢 [$1.05] | **🟢 [$0.25]** |
| Task8 ([transformers](https://github.com/huggingface/transformers)) | 3 | 🟢 [$0.25] | 🟢 [$0.19] | 🟢 [$0.17] | 🟢 [$0.26] | 🟢 [$0.23] | 🟢 [$0.29] | **🟢 [$0.12]** |
| **总计正确** | | 5/8 | 5/8 | 6/8 | 8/8 | 6/8 | 6/8 | **8/8** |
| **平均成本** | | $0.49 | $0.73 | $0.51 | $0.44 | $0.38 | $0.60 | **$0.18** |

> 🟢 成功 \| 🟡 未完成 \| 🔴 失败

> **成本对比**：Dirac 比竞争对手便宜 **64.8%**（**2.8 倍**成本降低）。
>
> \* 完成任务预期需要修改/创建的文件数。
>
> 详细任务描述和方法论请参见 [evals/README.md](evals/README.md)。


## 🚀 核心特性

- **哈希锚定编辑**：Dirac 使用稳定的行哈希来精准定位编辑，避免传统基于行号编辑的"翻译丢失"问题。
  ![Hash-Anchored Edits](https://www.dirac.run/static/images/multiple_edit.png)
- **AST 原生精度**：内置的语言语法理解（TypeScript、Python、C++ 等）使 Dirac 能够以 100% 准确率执行结构化操作，如函数提取或类重构。
  ![AST-Native Precision](https://www.dirac.run/static/images/parallel_AST_edit.png)
- **多文件批处理**：Dirac 可以在单次 LLM 调用中处理和编辑多个文件，显著减少延迟和 API 成本。
  ![Multi-File Batching](https://www.dirac.run/static/images/multi_function_read.png)
- **高带宽上下文**：优化的上下文策划保持代理精简和快速，确保 LLM 始终拥有最相关的信息而不浪费 token。
- **自主工具使用**：Dirac 可以读写文件、执行终端命令、使用无头浏览器等——同时通过基于审批的工作流让你保持控制。
- **技能与 AGENTS.md**：使用 `AGENTS.md` 文件通过项目特定指令自定义 Dirac 的行为。它还通过自动从 `.ai`、`.claude` 和 `.agents` 目录读取来无缝获取 Claude 的技能。
- **仅原生工具调用**：为确保最大可靠性和性能，Dirac 专门支持启用原生工具调用的模型。（注意：不支持 MCP）。

## 📦 安装

### VS Code 扩展
从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=dirac-run.dirac) 安装 Dirac。

### CLI（终端）
使用 npm 全局安装 Dirac CLI：
```bash
npm install -g dirac-cli
```

> **注意**：由于上游 V8 Turboshaft 编译器 bug 导致 WASM 初始化期间内存不足崩溃，目前不支持 Node.js v25。请使用 Node.js v20、v22 或 v24（LTS 版本）。

## 🚀 CLI 快速开始

1. **认证**：
   ```bash
   dirac auth
   ```
2. **运行你的第一个任务**：
   ```bash
   dirac "分析这个项目的架构"
   ```

### 配置（环境变量）
你可以通过环境变量提供 API 密钥，跳过 `dirac auth` 步骤。这非常适合 CI/CD 或非持久化环境。

有关特定提供商的设置（例如 [AWS Bedrock](docs/providers/README.md#aws-bedrock)、[Google Cloud Vertex AI](docs/providers/README.md#google-cloud-vertex-ai)），请参阅[提供商设置](docs/providers/README.md)指南。

常用 API 密钥：

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `OPENROUTER_API_KEY`
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `MISTRAL_API_KEY`
- `XAI_API_KEY` (x.ai)
- `HF_TOKEN` (HuggingFace)
- ... 以及其他（完整列表请参见 `src/shared/storage/env-config.ts`）。

#### 使用任何 OpenAI 兼容端点

你可以通过提供 base URL 和模型 ID 来使用任何 OpenAI 兼容提供商（例如 DeepSeek、DeepInfra、OpenRouter 或你自己的本地代理）。

**环境变量：**
- `OPENAI_API_BASE`：你的 API base URL（例如 `https://api.deepseek.com/v1`）。
- `OPENAI_API_KEY`（或 `OPENAI_COMPATIBLE_CUSTOM_KEY`）：你的 API 密钥。
- `CUSTOM_HEADERS`：可选的自定义头部（例如 `"Authorization=Bearer token,X-Account-Id=123"` 或 JSON 格式）。

**CLI 示例：**
```bash
# 使用环境变量
export OPENAI_API_BASE="https://api.yourprovider.com/v1"
export OPENAI_API_KEY="your-api-key"
export CUSTOM_HEADERS="Authorization=Bearer XXX"

dirac "解释 Dirac Delta 函数" \
  # 如果设置了 OPENAI_API_BASE，--provider 现在是可选的
  --model "your-model-id"
```

**CLI 标志示例：**
```bash
dirac "解释 Dirac Delta 函数" \
  --provider "https://api.deepseek.com/v1" \
  --model "deepseek-v4-pro" \
  --headers "X-Custom-Header=Value"
```


### 常用命令
- `dirac "提示"`：启动交互式任务。
- `dirac -p "提示"`：在**计划模式**下运行，先查看策略再执行。
- `dirac -y "提示"`：**Yolo 模式**（自动批准所有操作，适合简单修复）。
- `git diff | dirac "审查这些更改"`：将上下文直接管道传输到 Dirac。
- `dirac history`：查看和恢复之前的任务。


## 🛠️ 入门指南

1. 在 VS Code 中打开 Dirac 侧边栏。
2. 配置你首选的 AI 提供商（Anthropic、OpenAI、OpenRouter 等）。
3. 通过描述你想要构建或修复的内容来开始新任务。
4. 看着 Dirac 工作！


## 📄 许可证

Dirac 是**开源**的，基于 [Apache License 2.0](LICENSE) 许可。

## 🤝 致谢

Dirac 是优秀的 [Cline](https://github.com/cline/cline) 项目的分支。我们感谢 Cline 团队和贡献者的奠基工作。

---

由 [Max Trivedi](https://www.linkedin.com/in/max-trivedi-49993aab/) 在 [Dirac Delta Labs](https://dirac.run) 用 ❤️ 构建
