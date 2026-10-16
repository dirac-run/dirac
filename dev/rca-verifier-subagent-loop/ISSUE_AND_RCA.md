# Issue & Root Cause Analysis: Verification Subagent Infinite Rejection Loop & Shell-Tool Abuse with Local Models

## Symptom
When running Dirac with a local OpenAI-compatible model (`openai/occamy-1.0-oQ4e-mtp`) while `doubleCheckCompletionEnabled` ("Double-check completion") and `subagentsEnabled` ("Subagents") are enabled:
1. Every time the main agent calls `respond(operation: "complete")`, Dirac spawns a sequence of verification subagents (`Feynman`, `Tao`, `Curie`, `Euler`, `Witten` in task `1792160620858`; `Poincaré`, `Ramanujan`, `Shannon`, `Gödel` in task `1792160480446`).
2. Even when the verifier subagent **confirms the solution is completely valid** and starts its response with `VERIFICATION: SUCCESS`, Dirac rejects the completion and feeds the verifier's positive report back to the main agent as a **verification failure**, causing an infinite verification loop.
3. Inside each verification subagent run, the model executes 15–39 sequential `execute_command` calls (`cat`, `grep`, `sed`, `find`) in `StandaloneTerminal` instead of using native `read_file` and `search_files` tools.

## Evidence from Logs (`~/.dirac/data/tasks/1792160620858/subagents/index.md` & `1792160480446/subagents/index.md`)

- **Task `1792160620858` (Subagent #2 `Feynman`)**:
  ```json
  {
    "status": "completed",
    "result": "VERIFICATION: SUCCESS\n\nThe code smells review of the `dev/modelsapi` branch (2 committed changes vs `origin/master`) has been fully verified against the actual committed code and staged refinements. All 16 code smell findings and 2 staged-refinement risks are substantiated by the real diffs.",
    "stats": { "toolCalls": 15 }
  }
  ```
- **Task `1792160620858` (Subagent #5 `Euler`)**:
  ```json
  {
    "status": "completed",
    "result": "VERIFICATION: SUCCESS\n\nThe completion result accurately identifies a legitimate code smell in the committed changes on the `dev/modelsapi` branch...",
    "stats": { "toolCalls": 13 }
  }
  ```
- **Task `1792160480446` (Subagent #3 `Ramanujan`)**:
  ```json
  {
    "status": "completed",
    "result": "VERIFICATION: SUCCESS\n\nAll four prior verification failures have been addressed in the current completion result...",
    "stats": { "toolCalls": 17 }
  }
  ```
- **Task `1792160480446` (Subagent #4 `Shannon`)**:
  ```json
  {
    "status": "completed",
    "result": "Verification complete. All claims in the completion result were confirmed against the source code...\n\nThe completion result is accurate and complete.",
    "stats": { "toolCalls": 21 }
  }
  ```

All four subagents above concluded the completion was valid, yet Dirac rejected all four and forced the main agent to retry until Subagent #5 (`Gödel`) happened to output `"VERIFICATION: SUCCESS"` with zero trailing characters.

## Root Cause

### 1. Brittle Exact-String Equality in `CompletionResponseOperation.ts:276`
In `src/core/task/tools/modules/respond/CompletionResponseOperation.ts:165-166`, the prompt instructs the verifier:

```text
If the solution passes all checks, respond with exactly "VERIFICATION: SUCCESS" and nothing else.
Otherwise, respond with "VERIFICATION: FAILED" followed by all the details on what failed.
```

Then at lines 276–281, `runVerificationSubagent()` checks the result with strict `===` equality:

```ts
if (runResult.result?.trim() === "VERIFICATION: SUCCESS") {
	env.orchestration.setTaskState("completionVerificationFailure", undefined)
	return undefined
}
const report = runResult.result?.trim() || "Verifier returned no result."
return await this.recordVerificationFailure(env, result, report, `Verification Subagent Report:\n${report}`)
```

Local and open-weight models routinely include a brief justification after the `VERIFICATION: SUCCESS` header (`"VERIFICATION: SUCCESS\n\nAll claims verified..."`). Because `runResult.result.trim() === "VERIFICATION: SUCCESS"` evaluates to `false`, `CompletionResponseOperation` records the `VERIFICATION: SUCCESS` message as a **failure** and returns:

```text
Verification Subagent Report:
VERIFICATION: SUCCESS
...
The solution could not be verified successfully. Please address the issues listed above and try again.
```

```text
Main Agent calls respond(operation: "complete")
   │
   ▼
runVerificationSubagent() spawns Verifier (Feynman / Ramanujan / Euler)
   │
   ▼
Verifier confirms solution and outputs:
   "VERIFICATION: SUCCESS\n\nAll claims verified..."
   │
   ▼
CompletionResponseOperation.ts:276 checks:
   runResult.result?.trim() === "VERIFICATION: SUCCESS"  ──► FALSE!
   │
   ▼
recordVerificationFailure() wraps "VERIFICATION: SUCCESS..." inside:
   "The solution could not be verified successfully. Please address the issues listed above and try again."
   │
   ▼
Main Agent receives contradictory failure message, rewrites answer, and calls respond("complete") again
   │
   └──► Infinite verifier subagent loop (Feynman -> Tao -> Curie -> Euler -> Witten)
```

### 2. Unrestricted `execute_command` Usage in Read-Only Verification Subagents
In `~/.dirac/data/logs/dirac-cli.log` (lines 5440–5552), verifier subagent `Witten` executed 39 consecutive terminal commands (`cat`, `grep -n`, `sed -n`, `find`) via `execute_command`, spawning and showing `Dirac Terminal 1` on every turn instead of using `read_file` or `search_files`. Each shell invocation adds terminal startup overhead and pollutes the subagent context with raw file dumps.

## Proposed Fixes

1. **Parse `VERIFICATION: SUCCESS` prefix tolerant of trailing explanation (`src/core/task/tools/modules/respond/CompletionResponseOperation.ts:276`)**:
   - Accept any verifier result that starts with `VERIFICATION: SUCCESS` (and does not contain `VERIFICATION: FAILED`), e.g.:
     ```ts
     const normalizedResult = runResult.result?.trim() ?? ""
     const isVerifiedSuccess =
     	/^VERIFICATION:\s*SUCCESS\b/i.test(normalizedResult) &&
     	!/\bVERIFICATION:\s*FAILED\b/i.test(normalizedResult)
     if (isVerifiedSuccess) {
     	env.orchestration.setTaskState("completionVerificationFailure", undefined)
     	return undefined
     }
     ```
2. **Guide verifier subagents to prefer `read_file` / `search_files` over `execute_command` for file inspection**:
   - In `COMPLETION_VERIFICATION_INSTRUCTIONS` (`CompletionResponseOperation.ts`), instruct the verifier to use `read_file` and `search_files` for reading/searching code and reserve `execute_command` for running tests, typechecks, or `git diff`.
