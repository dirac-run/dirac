# Code Smell Review — `dev/acp-zed-gaps` Working Changes

**Base:** `origin/master` · **Scope:** `cli/` (11 files, all smells resolved)

---

## RC1 — `sessionCapabilities.list` advertised

**Files:** `DiracAgent.ts`, `DiracAgent.worktree.test.ts`

- **Status: Clean.** `sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {}, fork: {} }` is declared in `DiracAgent.initialize()` (`DiracAgent.ts:1200–1206`) and verified in `DiracAgent.worktree.test.ts:140`.

---

## RC2 — `inference_speed` recategorized to `model_config`

**Files:** `sessionConfig.ts`, `sessionConfig.runtime.test.ts`

- **Status: Clean.** `inference_speed` uses `category: "model_config"` (`sessionConfig.ts:234`), and `sessionConfig.runtime.test.ts:365–368` asserts both `speed.category === "model_config"` and `model.category === "model"`.

---

## RC4 — Slash-command `input.hint` duplication fixed

**Files:** `DiracAgent.ts`

- **Status: Resolved.** Removed the redundant `input: { hint: cmd.description }` in `sendAvailableCommands` (`DiracAgent.ts:2373–2377`) so Zed's slash-command popup no longer duplicates the full description sentence as an argument placeholder.

---

## RC5 — `session/fork` (`unstable_forkSession` & `copySessionUpdates`)

### 1. Extraction out of `DiracAgent.ts` into `cli/src/agent/sessionHistory.ts`

Because `DiracAgent.ts` is ~2,450 lines, all pure fork-state resolution and filesystem/history cloning helpers were moved out of `DiracAgent.ts` into `cli/src/agent/sessionHistory.ts`:
- `resolveForkSourceCwd(options)` (`sessionHistory.ts:104–120`): documents and isolates the working-directory fallback order.
- `resolveForkSourceState(options)` (`sessionHistory.ts:123–164`): resolves active or persisted source session state (`sourceOverrides`, `sourceMode`, `sourceTaskId`, `sourceTitle`, `sourceCwd`, `sourceHistoryItem`).
- `cloneForkedSessionArtifacts(options)` (`sessionHistory.ts:167–203`): copies `tasks/<sourceTaskId>` → `tasks/<newTaskId>`, upserts the `TaskHistoryItem` under `withTaskHistoryInventoryLock`, and calls `copySessionUpdates(sourceSessionId, newSessionId)`.
- `DiracAgent.unstable_forkSession` (`DiracAgent.ts:1478–1517`) is now a 38-line coordinator that delegates registration to `private registerForkedSession(...)` (`DiracAgent.ts:1520–1569`).

### 2. Resolution of All Review Observations

| # | Observation in Initial Review | Verdict | Resolution Applied |
|---|---|---|---|
| **1** | `item as unknown as RunHistoryItem` double cast in `upsertHistoryItem` | **Valid (Fixed)** | `RunHistoryItem = TaskHistoryItem \| GoalHistoryItem` (`src/shared/HistoryItem.ts:53`), so `TaskHistoryItem` is directly assignable to `RunHistoryItem`. Removed the `as unknown as RunHistoryItem` cast (`sessionHistory.ts:198`). |
| **2** | `unstable_forkSession` was ~130 lines and mixed filesystem/history cloning with session registration | **Valid (Fixed)** | Extracted `resolveForkSourceCwd`, `resolveForkSourceState`, and `cloneForkedSessionArtifacts` into `cli/src/agent/sessionHistory.ts`, and `registerForkedSession` as a private helper in `DiracAgent.ts`. |
| **3** | `sourceCwd` 7-level fallback chain inline in `unstable_forkSession` | **Valid (Fixed)** | Extracted into `resolveForkSourceCwd` in `cli/src/agent/sessionHistory.ts:104–120`. |
| **4** | `await controller.getTaskWithId(newTaskId)` return value unused without explanation | **Valid (Fixed)** | Added explicit comment in `registerForkedSession` (`DiracAgent.ts:1550`) explaining that `getTaskWithId` validates the cloned task exists in `taskHistory` before registering the session. |
| **5** | `entry.annotation._meta as Record<string, unknown> \| undefined` cast in `copySessionUpdates` could spread a non-object | **Valid (Fixed)** | Replaced the `as` cast with the runtime `isObject(...)` guard already in `acp-session-updates.ts` (`...(isObject(entry.update._meta) ? entry.update._meta : {})` and `...(isObject(entry.annotation._meta) ? entry.annotation._meta : {})`, `acp-session-updates.ts:699, 711`). |
| **6** | `AcpAgent.unstable_forkSession` skips `replayLoadedSessionHistory` without an inline comment | **Valid (Fixed)** | Added inline comment in `AcpAgent.ts:379` explaining that `session/fork` (like `session/resume`) does not stream historical chunks back on the fork response. |
| **7** | Verify `migrateLegacyIsolatedJournal(targetSessionId)` does not re-enter `withLock` | **Verified Safe** | `migrateLegacyIsolatedJournal` (`acp-session-updates.ts:527–558`) does not call `withLock`—it is designed to be called inside `withLock(sessionLockDirectory(sessionId), ...)` (matching `appendSessionEntry` at line 599 and `getSessionUpdates` at line 650). |
| **8** | Verify `appendRow` return value (`size`) passed to `compactIfNeeded(filePath, size)` | **Verified Safe** | `appendRow` (`acp-session-updates.ts:438–448`) returns `fs.fstatSync(descriptor).size` (the exact total file size on disk after `fsyncSync`), which is what `compactIfNeeded` compares against `maximumJournalBytes()`. |
