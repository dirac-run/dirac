import assert from "node:assert/strict"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, it } from "mocha"
import type { CustomSandboxProfile } from "@shared/SandboxSettings"
import { ownPreparedSandboxLaunch, prepareNativeSandboxWithProbe } from "./nativeSandbox"
import {
	type AvailableNativeSandbox,
	type NativeSandboxBackendLaunch,
	NativeSandboxError,
	type NativeSandboxRequest,
} from "./types"

const available: AvailableNativeSandbox = {
	available: true,
	backend: "seatbelt",
	helperPath: "/not-spawned",
	limitations: [],
	policyCapabilities: { restrictiveProfiles: true, taskPolicies: false, unsupportedControls: [] },
}
const request: NativeSandboxRequest = { executable: "/bin/true", args: [], cwd: "/", env: {}, policy: { id: "default" } }

function customFixture() {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dirac-launch-contract-")))
	for (const name of ["work", "authority", "temp"]) mkdirSync(path.join(root, name))
	const policy: CustomSandboxProfile = {
		id: "custom",
		revision: 1,
		kind: "custom",
		name: "Custom",
		description: "",
		filesystem: { base: "selected", workspace: "read-write", readable: [], writable: [], blocked: [], caches: [] },
		temporaryDirectory: path.join(root, "temp"),
		network: "deny",
		environment: { passthrough: [], overrides: {} },
	}
	return {
		root,
		policy,
		input: {
			...request,
			policy,
			context: { workspaceRoots: [path.join(root, "work")], protectedPaths: [path.join(root, "authority")] },
		} satisfies NativeSandboxRequest,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	}
}

describe("common native launcher contract (fake backends, no enforcement claim)", () => {
	it("consumes preparation before spawn and forbids all replay after an uncertain launch error", () => {
		let spawns = 0,
			disposals = 0
		const launch: NativeSandboxBackendLaunch = {
			spawn() {
				spawns++
				throw new NativeSandboxError("uncertain", "launch-failed", "execution-uncertain")
			},
			dispose() {
				disposals++
			},
			async terminate() {},
		}
		const prepared = ownPreparedSandboxLaunch(available, request, launch)
		assert.throws(() => prepared.spawn(), /uncertain/)
		assert.throws(() => prepared.spawn(), /replay is forbidden/)
		assert.equal(spawns, 1)
		assert.equal(disposals, 1)
	})

	it("dispose prevents launch, and termination rejects a sibling child", async () => {
		const child = new EventEmitter() as ChildProcess
		const sibling = new EventEmitter() as ChildProcess
		let terminations = 0
		const backend: NativeSandboxBackendLaunch = {
			spawn: () => child,
			dispose() {},
			async terminate(candidate) {
				assert.equal(candidate, child)
				terminations++
			},
		}
		const prepared = ownPreparedSandboxLaunch(available, request, backend)
		assert.equal(prepared.spawn(), child)
		await assert.rejects(prepared.terminate(sibling), /different execution/)
		await prepared.terminate(child)
		assert.equal(terminations, 1)
		const abandoned = ownPreparedSandboxLaunch(available, request, backend)
		abandoned.dispose()
		abandoned.dispose()
		assert.throws(() => abandoned.spawn(), /replay is forbidden/)
	})

	it("rejects unsupported policies/hosts before a missing-helper probe can authorize fallback", async () => {
		const f = customFixture()
		let probes = 0
		const missing = async () => {
			probes++
			return {
				available: false as const,
				error: new NativeSandboxError("missing", "missing-helper", "before-launch", true),
			}
		}
		try {
			for (const platform of ["freebsd", "win32"] as const) {
				await assert.rejects(
					prepareNativeSandboxWithProbe(f.input, missing, platform),
					(error: NativeSandboxError) => error.category === "invalid-policy" && !error.fallbackEligible,
				)
			}
			f.policy.environment.overrides.DYLD_INSERT_LIBRARIES = "/unsafe"
			await assert.rejects(
				prepareNativeSandboxWithProbe(f.input, missing, "darwin"),
				(error: NativeSandboxError) => error.category === "invalid-policy" && !error.fallbackEligible,
			)
			assert.equal(probes, 0, "unsupported controls must not reach availability/fallback")
		} finally {
			f.cleanup()
		}
	})

	it("valid policy setup failure remains separately recognizable and disposes all preparation", async () => {
		const f = customFixture()
		try {
			await assert.rejects(
				prepareNativeSandboxWithProbe(
					f.input,
					async () => ({
						available: false,
						error: new NativeSandboxError("missing", "missing-helper", "before-launch", true),
					}),
					"darwin",
				),
				(error: NativeSandboxError) => error.category === "missing-helper" && error.fallbackEligible,
			)
			const { readdirSync } = await import("node:fs")
			assert.deepEqual(readdirSync(f.policy.temporaryDirectory), [])
		} finally {
			f.cleanup()
		}
	})
})
