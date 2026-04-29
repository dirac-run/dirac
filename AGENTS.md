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
- `webview-ui/`: React-based frontend (separate workspace).
- `cli/`: TypeScript/Ink CLI (separate workspace).
- `proto/dirac/`: Protocol Buffer definitions.
- `src/generated/`, `src/shared/proto/`: Generated from protos (don't edit manually).

## 📂 Important Files

- `src/extension.ts`: Extension entry point.
- `src/core/task/index.ts`: Main task logic.
- `src/shared/tools.ts`: Tool registry.
- `escode.mjs`: Build configuration with path aliases and plugins.
- `package.json`: Workspaces defined: `[".", "cli"]`.

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

- **Setup**: `npm run install:all` (installs root + webview-ui deps)
- **Protobufs**: `npm run protos` (Required before build; generates `src/generated/` and `src/shared/proto/`)
- **Build**: `npm run build` (full extension build)
- **Dev**: `npm run dev` (protos + watch mode)
- **CLI Build**: `npm run cli:build` (builds CLI package)
- **CLI Dev**: `npm run cli:dev` (link + watch)

### Testing

- `npm test`: Runs all tests (unit + integration)
- `npm run test:unit`: Unit tests with mocha
- `npm run test:integration`: VS Code integration tests
- `npm run test:e2e`: Playwright E2E tests (requires build)
- `npm run cli:test`: CLI vitest tests
- `npm run test:webview`: Webview UI tests

### Code Quality

- **Lint**: `npm run lint` (biome + proto lint)
- **Format**: `npm run format` or `npm run format:fix`
- **Fix all**: `npm run fix:all` (biome check --write)
- **Type check**: `npm run check-types` (runs protos first, checks all workspaces)
- **CI check**: `npm run ci:check-all` (parallel typecheck, lint, format)

### Biome Configuration

- Uses `biome.jsonc` with tabs, 130 char line width, lf endings
- Organize imports enabled
- Some rules set to "info" rather than error during migration
- Custom grit plugins for enforcing patterns (e.g., no direct console.log)
- Grit plugins: `src/dev/grit/` (vscode-api, console-log, use-cache-service)

## 📝 Path Aliases (TypeScript)

- `@/*` → `src/*`
- `@api/*` → `src/core/api/*`
- `@core/*` → `src/core/*`
- `@generated/*` → `src/generated/*`
- `@hosts/*` → `src/hosts/*`
- `@integrations/*` → `src/integrations/*`
- `@packages/*` → `src/packages/*`
- `@services/*` → `src/services/*`
- `@shared/*` → `src/shared/*`
- `@utils/*` → `src/utils/*`

## ⚠️ Important Constraints

### Node.js Version

- **Node.js v25 is NOT supported** due to upstream V8 Turboshaft compiler bug
- Use Node.js v20, v22, or v24 (LTS versions)
- CLI supports: `>=20.0.0 <25.0.0`

### Build Order Dependencies

1. `npm run protos` must run before `npm run build`
2. `check-types` runs `protos` automatically
3. `compile` runs: check-types → lint → esbuild

### Generated Files

Do not manually edit files in:

- `src/generated/` (grpc-js, nice-grpc output)
- `src/shared/proto/` (ts-proto output)
- `proto/` contains source .proto files

### Lint-Staged Hooks

- `state-keys.ts` changes auto-regenerate `proto/dirac/state.proto`
- Biome check runs on staged files
- Configured in `package.json` `lint-staged` section

## 🔍 Search Exclusions

Avoid searching in these directories (large generated/binary files):

- `node_modules/`
- `dist/`
- `dist-standalone/`
- `build/`
- `.git/`
- `out/`
- `src/generated/`
- `src/shared/proto/`
- `webview-ui/build/`
