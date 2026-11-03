---
name: new-tool
description: Create a custom Dirac tool from user-provided or model-derived requirements
---

# Creating a New Custom Tool

You are creating a new custom tool for Dirac. The request may come directly from the user, or you may identify that a reusable tool would help accomplish the task.

## Step 1: Gather Requirements

Use requirements already established by the task and conversation. Ask the user only for details that are genuinely missing or ambiguous. If the requirements are clear, proceed without an interview.

Choose a snake_case **name**, a **description** shown to the model, and **parameters**. Each parameter has `name`, `type` (`string`, `boolean`, `integer`, `array`, or `object`), `required` (boolean), and `instruction` (string).

Choose the **scope**:
- **Global** (`~/.dirac/tools/`, or `$DIRAC_DIR/tools/`): all workspaces.
- **Workspace** (`<workspace>/.dirac/tools/`): this project only.
- **Task** (`<task storage>/tools/`): this task, including resume. Contained tasklets use their own task storage.

## Step 2: Write the Implementation

Write the implementation yourself, or explicitly delegate implementation work with the available tasklet interfaces and inspect the result. You remain responsible for choosing repairs. `upsert_tool` does not generate code or launch hidden workers.

Supply `implementation` as the complete TypeScript **body** of `async processCall(args, env)`. Do not include an enclosing function, imports, exports, a manifest, or a tool spec; the installer creates the module and metadata from your arguments. Return a string on success and throw an Error on failure. Handle empty arguments with a useful usage string, because the smoke test also invokes the tool with `{}`.

Use only the tool environment for workspace/system/UI operations; do not import Dirac internals. Available operations include:
- `await env.workspace.readFile(path)`, `writeFile(path, content)`, `listFiles(path, recursive, limit)`, and `resolvePath(path)`.
- `await env.system.executeCommand(command, options?)`, returning `{ userRejected, output, completed, exitCode, signal }`; check the outcome before reporting success.
- `await env.system.searchFiles(directory, regex, options?)`.
- `await env.ui.createCard({ header, body, status, collapsed })`; await the returned card's `update` and `finalize` methods when showing progress.
- `env.config.cwd` and optional `env.config.taskId` are synchronous configuration values.

For example, a tool with a string parameter `text` can use this implementation body:

```typescript
if (!args?.text) return "Usage: provide text"
return String(args.text).toUpperCase()
```

Prepare `smoke_args` as a **string containing a JSON object** of realistic successful arguments, for example `'{ "text": "hello" }'` (or `'{}'` for a tool without parameters). The string representation supports strict provider schemas. Smoke tests execute the supplied code; choose safe inputs and account for any side effects. They are validation, not a security sandbox or a substitute for the environment's permissions.

## Step 3: Validate and Install with `upsert_tool`

Call `upsert_tool` with a `tools` array. Each entry contains `name`, `scope`, `description`, `parameters`, `implementation`, and `smoke_args`. The installer authorizes the mutation, stages the supplied code, validates it and runs a smoke test through the existing command-permission path, then promotes and activates it.

- **Success** (`✓`): validation and installation finished. A ready result means activation also succeeded; an explicitly disabled result requires enabling before invocation.
- **Failure** (`❌`) or an authorization/activation error: read the diagnostic and decide whether to change the implementation, inputs, or approach. Submit a repaired implementation only when you choose to; there is no automatic retry or repair. Do not claim readiness on failure. A failed update must leave the previously installed tool intact.

## Step 4: Inform the User

Report the installed name, scope and activation state only after a successful result. Newly installed tools are registered and enabled; updating an existing disabled tool preserves its disabled state. Global and workspace tools appear in the **Tools** tab, where they can be enabled. Task-scoped tools persist with their owning conversation. Availability still respects the current execution profile, permissions and any tasklet allowlist.
