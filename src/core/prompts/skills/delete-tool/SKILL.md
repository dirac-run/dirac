---
name: delete-tool
description: Delete a local user-defined custom tool from global or workspace scope
---

# Deleting a User-Defined Custom Tool

You are helping the user delete a custom tool that was previously created with the `/new-tool` command. Only user-defined tools (global or workspace scope) can be deleted — built-in tools are protected and cannot be removed.

## Step 1: Discover User Tools

Scan both tool directories for user-created tools:

1. **Global tools** — `~/.dirac/tools/` (or `$DIRAC_DIR/tools/` if `DIRAC_DIR` is set)
2. **Workspace tools** — `<workspace>/.dirac/tools/`

Use `list_files` to enumerate subdirectories, then `read_file` each `dirac-tool.json` manifest to collect tool metadata (id, name, scope, entry).

Also read the `spec` from `tool.ts` to get the tool's description.

If no user tools are found in either location, inform the user that there are no user-defined tools to delete and stop.

## Step 2: Present the Tool List

Present the discovered tools to the user grouped by scope. For each tool show:
- **id** (from manifest)
- **name** (from manifest)
- **description** (from tool.ts spec)
- **scope** (global or workspace)
- **path** (filesystem location of the tool directory)

Format the list clearly, for example:

```
**Global tools** (~/.dirac/tools/):
  1. analyze_deps — Analyze project dependencies
  2. format_code — Auto-format source files

**Workspace tools** (<workspace>/.dirac/tools/):
  3. run_tests — Run the project test command
```

Use `ask_followup_question` to let the user select which tool(s) to delete. Include a "Cancel — don't delete anything" option.

## Step 3: Confirm Deletion

After the user selects one or more tools, confirm the deletion explicitly:

> You are about to permanently delete the following tool(s):
> - `run_tests` from `<workspace>/.dirac/tools/run_tests/`
>
> This will remove the tool directory and all its files. This action cannot be undone.
> The tool will no longer load in new sessions.
>
> Proceed?

Use `ask_followup_question` with "Yes, delete" and "No, cancel" options.

## Step 4: Delete the Tool

For each confirmed tool, delete its entire directory using `execute_command`:

```bash
rm -rf <tool-directory-path>
```

Also clean up any compiled cache files at `~/.dirac/cache/tools/<tool_id>-*.mjs` if they exist:

```bash
rm -f ~/.dirac/cache/tools/<tool_id>-*.mjs
```

If a deletion fails (e.g., permission error), report the error to the user but continue with remaining deletions.

## Step 5: Inform the User

After successful deletion, tell the user:

- The tool directory has been permanently removed.
- The tool will no longer load in new sessions (the tool registry re-scans directories at workspace initialization).
- If the tool was currently enabled, it may still appear in the current session's tool list until the session is restarted.
- If they want to remove the tool's toggle state from settings, they can do so in the **Tools** tab of the settings panel.
