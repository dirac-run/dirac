import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import { GLOBAL_STATE_DEFAULTS, SETTINGS_DEFAULTS } from "@shared/storage/state-keys"
import { assembleModelState } from "@core/controller/ui/assembleModelState"
import type { StateManager } from "../StateManager"
import {
	setGlobalState, setGlobalStateBatch, setTaskSettings, setTaskSettingsBatch, setSessionOverride,
	setWorkspaceState, setWorkspaceStateBatch, type StateManagerSettersContext,
} from "../StateManagerSetters"

function context(): StateManagerSettersContext {
	return {
		isInitialized: true,
		globalStateCache: structuredClone({ ...GLOBAL_STATE_DEFAULTS, ...SETTINGS_DEFAULTS }),
		taskStateCache: {}, sessionOverrideCache: {}, workspaceStateCache: {}, secretsCache: {},
		persistence: { addPendingGlobalState: sinon.spy(), addPendingGlobalStateBatch: sinon.spy() },
		notifyStateChange: sinon.spy(),
	} as unknown as StateManagerSettersContext
}

describe("global role storage and publication", () => {
	it("validates before global persistence and publishes successful writes", () => {
		const ctx = context()
		setGlobalState(ctx, "subagentRoles", [])
		assert.deepEqual(ctx.globalStateCache.subagentRoles, [])
		assert.equal((ctx.notifyStateChange as sinon.SinonSpy).callCount, 1)
		assert.throws(() => setGlobalStateBatch(ctx, {
			preferredLanguage: "French",
			subagentRoles: [{ name: "default", description: "Invalid.", enabled: false }],
		}))
		assert.equal(ctx.globalStateCache.preferredLanguage, SETTINGS_DEFAULTS.preferredLanguage)
		assert.deepEqual(ctx.globalStateCache.subagentRoles, [])
	})

	it("rejects task, session and workspace role writes", () => {
		const ctx = context()
		for (const write of [
			() => setTaskSettings(ctx, "task", "subagentRoles", []),
			() => setTaskSettingsBatch(ctx, "task", { subagentRoles: [] }),
			() => setSessionOverride(ctx, "subagentRoles", []),
			() => setWorkspaceState(ctx, "subagentRoles", []),
			() => setWorkspaceStateBatch(ctx, { subagentRoles: [] } as never),
		]) assert.throws(write, /user-global/)
		assert.deepEqual(ctx.taskStateCache, {})
		assert.deepEqual(ctx.sessionOverrideCache, {})
		assert.deepEqual(ctx.workspaceStateCache, {})
	})

	it("publishes the current global catalog rather than a task snapshot", () => {
		const roles = [{ name: "Global reviewer", description: "Review code.", enabled: false }]
		const stateManager = {
			getGlobalSettingsKey: () => undefined,
			getSystemDefaultSettingsKey: (key: string) => key === "subagentRoles" ? roles : undefined,
			getSecretKey: () => undefined,
			getApiConfiguration: () => ({}), getGlobalStateKey: () => undefined, getWorkspaceStateKey: () => undefined,
		} as unknown as StateManager
		assert.deepEqual(assembleModelState(stateManager).subagentRoles, roles)
	})
})
