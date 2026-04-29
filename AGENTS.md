# Dirac Agent Guide

This is the codebase of our coding agent Dirac. It supports cli and vscode extension.

## 🏗️ Codebase Modules
- `src/core/task/`: Task execution loop and state management.
- `src/core/task/tools/`: Tool implementations (handlers).
- `src/core/prompts/`: System and tool prompt templates.
- `src/core/controller/`: High-level extension coordination and state.
- `src/core/context/`: Context gathering and management.
- `src/core/slash-commands/`: Slash command definitions and parsing.
- `src/integrations/`: Terminal, Browser, and Editor API wrappers.
- `src/services/`: Shared services (Logging, Telemetry, Tree-sitter).
- `src/shared/`: Cross-component types and utilities.
- `webview-ui/`: React-based frontend.
- `cli/`: TypeScript/Ink CLI.

## 📂 Important Files
- `src/extension.ts`: Extension entry point.
- `src/core/task/index.ts`: Main task logic.
- `src/shared/tools.ts`: Tool registry.
- `proto/dirac/`: Protocol Buffer definitions.
- `package.json`: Project dependencies and scripts.

## 🔌 API Providers
- Provider Handlers: `src/core/api/providers/`
  - Individual implementations for each provider (e.g., `anthropic.ts`, `gemini.ts`, `openai.ts`, `bedrock.ts`).
  - Each handler implements the `ApiHandler` interface defined in `src/core/api/index.ts`.
- API Factory: `src/core/api/index.ts`
  - Contains `createHandlerForProvider` which instantiates the correct handler based on user configuration.
- Model Metadata: `src/shared/api.ts`
  - Central location for model IDs, pricing, and capability flags (e.g., `supportsTools`, `supportsThinking`).
- Stream Handling: `src/core/api/transform/`
  - Logic for transforming various provider stream formats into Dirac's internal `ApiStream`.

## 🛠️ Dev Flow
- Setup: `npm run install:all`
- Protobufs: `npm run protos` (Required before build)
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`

## Note on grep/search
Avoid searching in the following directories as they contain large generated files or binary data that will result in "unwanted blobs" or irrelevant matches:
- `node_modules/`
- `dist/`
- `build/`
- `.git/`
- `out/`
- `src/generated/` (Generated from protos)
- `src/shared/proto/` (Generated from protos)