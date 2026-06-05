---
name: new-tool
description: Create a new custom tool for Dirac through an interactive interview
---

# Creating a New Custom Tool

You are helping the user create a new custom tool for Dirac. Guide them through an interactive process to define, generate, and verify a Dirac-managed TypeScript tool.

## Step 1: Gather Requirements

Ask the user these questions (all at once if they gave a detailed request, otherwise one at a time):

1. **Tool name** — a `snake_case` identifier (e.g. `run_tests`, `format_code`, `analyze_deps`).
2. **Description** — what the tool does, shown to the LLM.
3. **Parameters** — for each input the tool needs:
   - Name (`snake_case`)
   - Type (`string` | `boolean` | `integer` | `array` | `object`)
   - Required or optional
   - Instruction text for the LLM
4. **Scope** — where should the tool live?
   - **Global** (`~/.dirac/tools/`): available in every workspace
   - **Workspace** (`<workspace>/.dirac/tools/`): available only in this project

## Step 2: Generate Tool Files

Create exactly this Dirac-managed directory layout at the chosen scope path:

```text
<tool-root>/<tool_name>/
    dirac-tool.json
    tool.ts
```

Where `<tool-root>` is either `~/.dirac/tools` or `<workspace>/.dirac/tools`.

Do not create JavaScript entrypoints. User tools are TypeScript-only at source and are loaded by Dirac's manifest-based TypeScript loader.

### dirac-tool.json — Sidecar Manifest

Always create this file. The manifest lets Dirac identify the folder as a managed user tool and validate the entrypoint before loading it.

```json
{
  "schemaVersion": 1,
  "id": "run_tests",
  "name": "run_tests",
  "scope": "workspace",
  "entry": "tool.ts",
  "createdBy": "dirac",
  "createdAt": "2026-05-29T00:00:00.000Z"
}
```

Use `"scope": "global"` for tools under `~/.dirac/tools`, and `"scope": "workspace"` for tools under `<workspace>/.dirac/tools`.

### tool.ts — Alias-Free Tool Module

Always create this file. It must export `spec` and `create`.

Do not import from Dirac internals. Avoid `@/` or any other internal path aliases. Use structural typing and the documented `env` capabilities provided to `processCall`.

```typescript
export const spec = {
    id: "run_tests",
    name: "run_tests",
    description: "Run the project test command.",
    parameters: [
        {
            name: "command",
            type: "string",
            required: false,
            instruction: "Optional test command to run. Defaults to npm test.",
        },
    ],
}

export function create() {
    return {
        spec() {
            return spec
        },
        supportedSurfaces() {
            return ["all"]
        },
        async processCall(args, env) {
            const command = args.command || "npm test"

            const card = await env.ui.createCard({
                icon: "tool",
                header: "Run Tests",
                collapsed: true,
            })

            try {
                // env.workspace   -> readFile(path): string, writeFile(path, content): void,
                //                      listFiles(path, recursive, limit): [FileInfo[], boolean],
                //                      resolvePath(path): {absolutePath, displayPath}
                // env.system      -> executeCommand(cmd, opts?): [boolean, string], searchFiles(dir, regex, opts?): string
                // env.editor      -> open(path): void, showReview(files): void, saveChanges(): SaveResult
                // env.symbols     -> getDefinitions(symbol): SymbolLocation[], getReferences(symbol): SymbolLocation[],
                //                      getSymbols(symbol): SymbolLocation[]
                // env.ast         -> getSkeleton(path): string, getFunctions(absPath, relPath, names): {formattedContent, foundNames} | null
                // env.interaction -> askPermission(message): {approved, action, ...}

                const [denied, output] = await env.system.executeCommand(command)
                await card.update({ status: "success", body: String(output) })
                return String(output)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                await card.update({ status: "error", body: `Error: ${message}` })
                throw error
            }
        },
    }
}
```

For complex logic, keep helper functions in the same `tool.ts` file unless you are certain relative imports will compile and load correctly in the production user-tool loader.

## Step 3: Validate Before Finishing

Before telling the user the tool is ready:

1. Confirm `id` and `name` are valid `snake_case` identifiers.
2. Confirm `dirac-tool.json` parses successfully.
3. Confirm `schemaVersion === 1`.
4. Confirm `entry === "tool.ts"`.
5. Confirm `createdBy === "dirac"`.
6. Confirm `scope` matches the physical location (`global` under `~/.dirac/tools`, `workspace` under `<workspace>/.dirac/tools`).
7. Confirm `manifest.id === spec.id`.
8. Confirm `manifest.name === spec.name`.
9. Confirm the generated module exports `spec` and `create`.
10. Confirm no JavaScript entrypoint is created or required.
11. Check for collisions with built-in tools and existing user tools when possible.
12. Ensure parameters are JSON-schema-compatible.
13. Ensure there are no imports from Dirac internals or path aliases such as `@/` or any internal aliases.
14. Validate that TypeScript compiles through Dirac's real user-tool loader path when possible.
15. Do not tell the user the tool is ready until validation passes.
16. Show the user the complete generated files.

## Step 4: Inform the User

Tell the user:

- The tool will appear in the **Tools** tab of the settings panel.
- User tools default to **disabled** and must be enabled in settings before use.
- Once enabled, the tool is available to the main agent and to subagents whose allowlist includes the tool id/name.

## Step 5: Built-in Tool (Optional)

If the user wants to contribute the tool as a shipped built-in:

1. Move the directory to `src/core/task/tools/modules/<tool_name>/`.
2. Add `<TOOL_NAME> = "<tool_name>"` to the `DiracDefaultTool` enum in `src/shared/tools.ts`.
3. Run `npm run generate:tools` to regenerate the barrel.
4. The tool is now part of the shipped software.
