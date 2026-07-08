---
name: new-tool
description: Create a new custom tool for Dirac through an interactive interview
---

# Creating a New Custom Tool

You are helping the user create a new custom tool for Dirac. Guide them through an interactive process to define and create a tool.

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
   - **Task** (`<task storage>/tools/`): available only for this task, survives task resume
5. **Requirements** — any specific behavior, logic, edge cases, or env traits the tool should use.

## Step 2: Create the Tool with `upsert_tool`

Call the `upsert_tool` tool with the gathered information. It handles code generation, compilation, validation, and smoke testing internally.

Parameters:
- `tools`: array of tool definitions, each containing:
  - `name`: the snake_case tool identifier
  - `scope`: `"global"`, `"workspace"`, or `"task"`
  - `description`: what the tool does
  - `parameters`: array of `{ name, type, required, instruction }`
  - `requirements`: natural language description of what the tool should do

## Step 3: Handle Results

- **Success** (`✅`): proceed to Step 4.
- **Failure** (`❌`): read the error, adjust requirements, and call `upsert_tool` again. Max 3 retries.

## Step 4: Inform the User

Tell the user:
- The tool will appear in the **Tools** tab of the settings panel.
- User tools default to **disabled** and must be enabled in settings before use.
- Once enabled, the tool is available to the main agent and to subagents whose allowlist includes the tool id/name.
- Task-scoped tools are automatically available for this task and will persist across task resume.
