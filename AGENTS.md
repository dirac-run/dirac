# Dirac Agent Guide

This is the codebase of our coding agent Dirac. It supports cli and vscode extension.

## Codebase Structure

- `src/core/task/` : Task execution loop and state
- `src/core/task/tools/modules/` : Tool implementations
- `src/core/task/tools/interfaces/IToolEnvironment.ts` : Tool↔environment contract
- `src/core/task/tools/ToolExecutorCoordinator.ts` : Tool dispatch
- `src/core/prompts/` : System prompt templates
- `src/core/controller/` : Extension coordination and state
- `src/core/context/` : Context gathering
- `src/core/api/providers/` : Per-provider API handlers (anthropic, gemini, openai, bedrock…)
- `src/core/api/transform/` : Provider stream → internal `ApiStream`
- `src/shared/api.ts` : Model IDs, pricing, capability flags
- `src/integrations/` : Terminal, Browser, Editor wrappers
- `src/services/` : Logging, Telemetry, Tree-sitter
- `src/shared/` : Cross-component types and utilities
- `webview-ui/` : React frontend (`Card` is the UI primitive for tools)
- `cli/` : TypeScript/Ink CLI
- `proto/dirac/` : Protobuf definitions


## Tooling

Tools are self-contained units dispatched by `ToolExecutorCoordinator`. Once called, a tool owns its lifecycle: it creates one or more `Card`s via `createCard`, updates their status via the card handle, and sets a final status before exiting. The only way a tool interacts with the environment is through `IToolEnvironment`. How cards are rendered is the UI's concern, not the tool's.

## Must Follow Engineering Principles

1. Layered architecture is a hard boundary. Task loop orchestrates, tools execute, UI renders, API handlers handler API providers. No layer knows the internals of another. Tool-specific logic belongs in the tool module, not in the coordinator or task loop. Never EVER mix the layers.
2. No defensive programming, it does more harm than good to swallow failures.
3. Every function should have single responsibility. 
4. No spaghetti control flow. Linear over nested. Early returns over deep conditionals. State transitions happen in one place.
5. Tools are hermetically sealed. A tool's only interface with the environment is IToolEnvironment. Tools do not import each other. Shared behavior is explicit, not implicit coupling.
6. Names are contracts. A function or file name should make its behavior predictable before you open it. Vague names (handle, process, manage) are rejected at review.
8. No cargo-cult patterns. Don't add abstraction, indirection, or boilerplate because it feels right. Every layer of indirection needs a reason. Premature generalization is complexity debt.

> Legacy code may violate these. Flag violations and propose fixes when you encounter them.

## Dev Flow
## 🛠️ Dev Flow
- Setup: `npm run install:all`
- Protobufs: `npm run protos` (Required before build)
- Compile: `npm run compile`
- Test: `npm test` (do not run tests automatically, only if user asked)
- Lint: `npm run lint`

## Note on grep/search
Skip these when grepping or searching - generated/binary content only:
`node_modules/`, `dist/`, `build/`, `.git/`, `out/`, `src/generated/`, `src/shared/proto/`