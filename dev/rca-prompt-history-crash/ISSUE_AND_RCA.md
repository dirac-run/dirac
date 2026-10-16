# Issue & Root Cause Analysis: Unreadable Legacy Task Transcript Breaks Workspace Prompt History

## Symptom
When launching the interactive CLI (`dirac`) in a workspace that has an older task saved in the legacy pre-Card `ui_messages.json` schema (for example `~/.dirac/data/tasks/1792101500193/ui_messages.json`), the CLI immediately displays a red error banner:

```text
! Failed to load prompt history: Saved task transcript uses an unsupported or unreadable format:
/Users/highlands/.dirac/data/tasks/1792101500193/ui_messages.json
```

In addition to the banner, `Ctrl+Up` / `Ctrl+Down` prompt-history recall is completely broken for the workspace even when the other 19 recent tasks are valid.

## Root Cause
In `src/core/controller/TaskHistoryController.ts:107-126`, `getPromptHistory()` loads up to 20 recent runs for the workspace using an unguarded `Promise.all`:

```ts
const prompts = await Promise.all(
	runs.map(async (run) => {
		const saved = getUserPrompts(await getSavedDiracMessages(run.id))
		return saved.length > 0 ? saved : run.task.trim() ? [{ text: run.task, ts: run.ts }] : []
	}),
)
```

In `src/core/storage/conversationHistory.ts:529-546`, `parseSavedDiracMessages()` filters `ui_messages.json` with `isReadableDiracMessage()`. If a legacy task file contains old `"type": "say"` / `"type": "ask"` entries rather than `Card`-based `DiracMessage` objects (`parsed.length > 0 && readableMessages.length === 0`), line 545 throws:

```ts
throw new Error(`Saved task transcript uses an unsupported or unreadable format: ${filePath}`)
```

Because `getSavedDiracMessages(run.id)` is not wrapped in a per-run `try / catch` inside `getPromptHistory()`:
1. A single legacy task directory rejects the entire `Promise.all(...)`.
2. The fallback already written on line 122 (`run.task.trim() ? [{ text: run.task, ts: run.ts }] : []`) is never reached when `getSavedDiracMessages` throws.

```text
getPromptHistory(workspacePath)
  └── Promise.all(runs.slice(0, 20))
        ├── run 1..18 (valid JSONL) ──────────────► returns UserPrompt[]
        └── run 19 (legacy ui_messages.json) ─────► getSavedDiracMessages throws!
                                                       │
                                                       ▼
                                           Entire Promise.all rejects!
                                           Fallback `run.task` on line 122 is bypassed
                                           CLI renders "! Failed to load prompt history"
```

## Proposed Fix
In `src/core/controller/TaskHistoryController.ts:119-125`, catch per-run transcript read errors, log a warning, and fall back to `run.task`:

```ts
const prompts = await Promise.all(
	runs.map(async (run) => {
		try {
			const saved = getUserPrompts(await getSavedDiracMessages(run.id))
			if (saved.length > 0) return saved
		} catch (error) {
			Logger.warn(`[TaskHistoryController] Skipping unreadable transcript for task ${run.id}:`, error)
		}
		return run.task.trim() ? [{ text: run.task, ts: run.ts }] : []
	}),
)
```
