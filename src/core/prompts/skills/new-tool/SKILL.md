---
name: new-tool
description: Create a custom Dirac tool from user-provided or model-derived requirements
---

# Creating a New Custom Tool

You are creating a new custom tool for Dirac. The request may come directly from the user, or you may identify that a reusable tool would help accomplish the task.

## Step 1: Gather Requirements

Use requirements already established by the task and conversation. Ask the user only for details that are genuinely missing or ambiguous. If the requirements are clear, proceed without an interview.

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
   - **Task** (`<task storage>/tools/`): available only for this task, survives task resume
5. **Requirements** — any specific behavior, logic, edge cases, or env traits the tool should use.

## Step 2: Create the Tool with `upsert_tool`

Call the `upsert_tool` tool with the gathered information. It handles code generation, compilation, validation, and smoke testing internally.

## Step 3: Handle Results

- **Success** (`✅`): proceed to Step 4.
- **Failure** (`❌`): read the error, adjust the requirements, and call `upsert_tool` again.

## Step 4: Inform the User

Tell the user:
- Global and workspace tools appear in the **Tools** tab and default to disabled until enabled.
- Task-scoped tools are automatically available for this task and persist across task resume.
- Enabled tools are available to the main agent and to subagents whose allowlist includes the tool id/name.
