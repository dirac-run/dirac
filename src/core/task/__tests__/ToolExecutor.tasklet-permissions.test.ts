import assert from "node:assert/strict"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { SETTINGS_DEFAULTS, type Settings } from "@shared/storage/state-keys"
import { CardStatus } from "@shared/ExtensionMessage"
import { HostProvider } from "@/hosts/host-provider"
import { ToolExecutor } from "../ToolExecutor"
import { createTaskWorkingConfiguration } from "../runtime/TaskWorkingConfiguration"
import type { TaskInteractionRequest } from "../types/task-messenger"
import { createCardFromMessenger } from "../tools/adapters/traits/UiTraitBuilder"
import { resolveBrowserLaunchPermission, resolveCommandApproval, type AutoApprove } from "../tools/autoApprove"
import type { TaskConfig } from "../tools/types/TaskConfig"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { DiracDefaultTool } from "@shared/tools"

function harness(utility = false) {
	const settings = structuredClone(SETTINGS_DEFAULTS) as Settings
	settings.mode = "act"
	settings.strictPlanModeEnabled = true
	settings.yoloModeToggled = false
	settings.autoApproveAllToggled = false
	settings.autoApprovalSettings.actions.executeCommands = false
	settings.autoApprovalSettings.actions.editFiles = false
	settings.userApprovedCommands = []
	let revision = 1
	const config = () => createTaskWorkingConfiguration({
		revision, settings, apiConfiguration: {} as any,
		workspaceConfiguration: {} as any, executionOptions: {
			terminalReuseEnabled: false,
			vscodeTerminalExecutionMode: "backgroundExec", multiRootEnabled: false
		}
	})
	const permissions = { revision: 0, validateTool: sinon.stub().returns({ allowed: true, reason: "no_config" }) }
	const decide = sinon.stub().resolves({ decision: "approve", reason: "allowed" })
	const executor = Object.assign(Object.create(ToolExecutor.prototype), {
		getCurrentWorkingConfiguration: config,
		commandPermissionController: permissions,
		executionProfile: "standalone", cwd: "/workspace",
		createPermissionDecisionBinding: () => utility ? { configurationRevision: revision, authorityMode: settings.mode, commandPermissionRevision: permissions.revision, service: { decide } } : undefined,
	}) as ToolExecutor
	return { executor, settings, permissions, decide, change: () => { revision++ } }
}

function request(name = "execute_command", operation: TaskInteractionRequest["permissionOperation"] = { kind: "commands", commands: ["echo hello"] }): TaskInteractionRequest {
	return {
		card: {
			id: "permission", header: "Exact operation", status: CardStatus.WAITING_FOR_INPUT,
			renderType: "markdown", requireApproval: true
		} as any,
		permissionRequestKind: "manual_tool", permissionOperation: operation,
		toolCall: { name, arguments: { commands: ["echo hello"] } }
	}
}
const signal = () => new AbortController().signal

describe("ToolExecutor tasklet parent authority", () => {
	afterEach(() => sinon.restore())

	it("uses current parent authority rather than the child's interception classification", async () => {
		const h = harness()
		assert.equal((await h.executor.authorizeTaskletPermission(request(), signal())).approved, false)
		h.settings.userApprovedCommands = [{ command: "echo hello", match: "exact" }]
		h.change()
		const result = await h.executor.authorizeTaskletPermission(request(), signal())
		assert.equal(result.approved, true)
		result.assertCurrent()
		h.settings.userApprovedCommands = []
		h.change()
		assert.throws(result.assertCurrent, /authority changed/)
	})

	it("applies current command rules to custom-tool smoke execution", async () => {
		const h = harness()
		const smoke = request("upsert_tool", { kind: "commands", commands: ["npx tsx '/task/test-harness.ts'"] })
		assert.equal((await h.executor.authorizeTaskletPermission(smoke, signal())).approved, false)
		h.settings.userApprovedCommands = [{ command: "npx tsx '/task/test-harness.ts'", match: "exact" }]
		h.change()
		const approved = await h.executor.authorizeTaskletPermission(smoke, signal())
		assert.equal(approved.approved, true)
		approved.assertCurrent()
		h.settings.userApprovedCommands = []
		h.change()
		assert.throws(approved.assertCurrent, /authority changed/)
		assert.equal((await h.executor.authorizeTaskletPermission(smoke, signal())).approved, false)
	})

	it("checks every exact normalized command, including workspace prefixes", async () => {
		const h = harness()
		h.permissions.validateTool.callsFake((_tool, command) => command === "echo trusted"
			? { allowed: true, reason: "allowed", matchedPattern: "echo trusted" }
			: { allowed: false, reason: "denied" })
		assert.equal((await h.executor.authorizeTaskletPermission(request("execute_command", {
			kind: "commands", commands: ["@root:echo trusted"],
		}), signal())).approved, true)
		assert.equal((await h.executor.authorizeTaskletPermission(request("execute_command", {
			kind: "commands", commands: ["@root:echo trusted", "echo denied"],
		}), signal())).approved, false)
	})

	it("invalidates authorization when separately mutable permission rules change", async () => {
		const h = harness()
		h.settings.yoloModeToggled = true
		const result = await h.executor.authorizeTaskletPermission(request(), signal())
		h.permissions.revision++
		assert.throws(result.assertCurrent, /authority changed/)
	})

	it("retains the complete unrestricted command approval path with and without Utility", async () => {
		for (const utility of [false, true]) {
			const h = harness(utility)
			h.settings.yoloModeToggled = true
			h.permissions.validateTool.returns({ allowed: false, reason: "denied" })
			assert.equal((await h.executor.authorizeTaskletPermission(request(), signal())).approved, true)
			sinon.assert.notCalled(h.decide)
		}
	})

	it("does not repeat a child's Utility escalation but permits current static parent authority", async () => {
		const h = harness(true)
		const escalated = { ...request(), utilityPermissionEscalation: "Policy is silent" }
		assert.equal((await h.executor.authorizeTaskletPermission(escalated, signal())).approved, false)
		sinon.assert.notCalled(h.decide)
		h.settings.userApprovedCommands = [{ command: "echo hello", match: "exact" }]
		h.change()
		assert.equal((await h.executor.authorizeTaskletPermission(escalated, signal())).approved, true)
		sinon.assert.notCalled(h.decide)
	})

	it("identifies child-originated requests when the parent consults Utility", async () => {
		const h = harness(true)
		await h.executor.authorizeTaskletPermission(request(), signal())
		sinon.assert.calledOnce(h.decide)
		assert.equal(h.decide.firstCall.args[0].runtime.isSubagent, true)
	})

	it("supplies the current Plan parent context to explicit command Utility authorization", async () => {
		const h = harness(true)
		h.settings.mode = "plan"
		await h.executor.authorizeTaskletPermission(request(), signal())
		assert.deepEqual(h.decide.firstCall.args[0].runtime, { cwd: "/workspace", mode: "plan", isSubagent: true })
	})

	it("rechecks every exact write path against changed parent edit policy and deny rules", async () => {
		sinon.stub(HostProvider, "workspace").value({ getWorkspacePaths: async () => ({ paths: ["/workspace"] }) })
		const h = harness()
		const write = request("edit_ast", { kind: "paths", paths: ["src/a.ts", "src/private.ts"] })
		assert.equal((await h.executor.authorizeTaskletPermission(write, signal())).approved, false)
		h.settings.autoApprovalSettings.actions.editFiles = true
		h.change()
		const approved = await h.executor.authorizeTaskletPermission(write, signal())
		assert.equal(approved.approved, true)
		h.permissions.validateTool.withArgs("edit_ast", "src/private.ts").returns({ allowed: false, reason: "denied" })
		h.permissions.revision++
		assert.throws(approved.assertCurrent, /authority changed/)
		// Explicit owner authorization retains the parent's established legacy semantics.
		// With edit auto-approval removed, no broader path grant may authorize the denied file.
		h.settings.autoApprovalSettings.actions.editFiles = false
		h.change()
		assert.equal((await h.executor.authorizeTaskletPermission(write, signal())).approved, false)
		sinon.assert.calledWithExactly(h.permissions.validateTool, "edit_ast", "src/private.ts")
	})

	it("requires an actual Utility approval, not merely eligibility", async () => {
		const h = harness(true)
		h.decide.resolves({ decision: "escalate", reason: "ask user" })
		assert.equal((await h.executor.authorizeTaskletPermission(request(), signal())).approved, false)
		h.decide.resolves({ decision: "approve", reason: "allowed" })
		assert.equal((await h.executor.authorizeTaskletPermission(request(), signal())).approved, true)
	})

	it("rejects stale Utility decisions on configuration or rule changes", async () => {
		for (const rules of [false, true]) {
			const h = harness(true)
			h.decide.callsFake(async () => {
				if (rules) h.permissions.revision++
				else h.change()
				return { decision: "approve", reason: "allowed" }
			})
			await assert.rejects(h.executor.authorizeTaskletPermission(request(), signal()), /authority changed/)
		}
	})

	it("does not invent legacy browser shortcuts or authorize missing metadata", async () => {
		const h = harness()
		h.settings.autoApprovalSettings.actions.useBrowser = true
		h.permissions.validateTool.returns({ allowed: true, reason: "allowed", matchedPattern: "**" })
		assert.equal((await h.executor.authorizeTaskletPermission(request("browser_action", {
			kind: "browser", url: "https://example.com",
		}), signal())).approved, false)
		const missing = request()
		delete missing.permissionOperation
		h.settings.yoloModeToggled = true
		assert.equal((await h.executor.authorizeTaskletPermission(missing, signal())).approved, false)
	})

	it("keeps manual custom permissions out of Utility and rejects mismatched descriptors", async () => {
		const h = harness(true)
		assert.equal((await h.executor.authorizeTaskletPermission(request("custom_tool", {
			kind: "tool", manualOnly: true,
		}), signal())).approved, false)
		assert.equal((await h.executor.authorizeTaskletPermission(request("custom_tool"), signal())).approved, false)
		sinon.assert.notCalled(h.decide)
	})

	it("checks every resolved edit path and keeps external Utility writes manual without unrestricted approval", async () => {
		sinon.stub(HostProvider, "workspace").value({ getWorkspacePaths: async () => ({ paths: ["/workspace"] }) })
		const h = harness(true)
		h.settings.autoApprovalSettings.actions.editFiles = true
		assert.equal((await h.executor.authorizeTaskletPermission(request("edit_ast", {
			kind: "paths", paths: ["src/a.ts", "/outside/reference.ts"],
		}), signal())).approved, false)
		sinon.assert.notCalled(h.decide)
	})

	for (const setting of ["yoloModeToggled", "autoApproveAllToggled"] as const) {
		for (const operation of ["command", "browser", "external write"] as const) {
			it(`matches the complete ordinary Utility permission path for ${setting} and denied ${operation}`, async () => {
				sinon.stub(HostProvider, "workspace").value({ getWorkspacePaths: async () => ({ paths: ["/workspace"] }) })
				const h = harness(true)
				h.settings[setting] = true
				h.permissions.validateTool.returns({ allowed: false, reason: "denied" })
				const autoApprover = (h.executor as any).requestAutoApprover() as AutoApprove
				let childRequest: TaskInteractionRequest
				if (operation === "command") {
					assert.deepEqual(resolveCommandApproval(["echo hello"], true, autoApprover, h.permissions), {
						required: true, utilityEligible: false,
					})
					childRequest = request()
				} else if (operation === "browser") {
					assert.equal(resolveBrowserLaunchPermission("https://example.com", autoApprover, h.permissions), "manual_only")
					childRequest = request("browser_action", { kind: "browser", url: "https://example.com" })
				} else {
					assert.equal(await autoApprover.resolveToolPathPermission(DiracDefaultTool.FILE_NEW, "/outside/file.ts"), "manual_only")
					childRequest = request("write_to_file", { kind: "paths", paths: ["/outside/file.ts"] })
				}
				const createCard = sinon.stub().rejects(new Error("Unrestricted ordinary approval must not ask the user"))
				const ordinaryCard = await createCardFromMessenger({
					autoApprover,
					taskMessenger: { routesToOwner: false, createCard },
					permissionDecisionBinding: { service: { decide: h.decide }, authorityMode: "act", configurationRevision: 1 },
				} as unknown as TaskConfig, {
					header: childRequest.card.header, requireApproval: true, permissionRequestKind: "manual_tool",
				}, [])
				assert.equal((await ordinaryCard.waitForInteraction()).action, DiracAskResponse.APPROVE)
				const authorization = await h.executor.authorizeTaskletPermission(childRequest, signal())
				assert.equal(authorization.approved, true)
				authorization.assertCurrent()
				sinon.assert.notCalled(createCard)
				sinon.assert.notCalled(h.decide)
				h.permissions.revision++
				assert.throws(authorization.assertCurrent, /authority changed/)
			})
		}
	}

	it("does not let unrestricted approval bypass missing, mismatched or empty operation descriptors", async () => {
		const h = harness(true)
		h.settings.yoloModeToggled = true
		const missing = request()
		delete missing.permissionOperation
		for (const input of [
			missing,
			request("custom_tool"),
			request("custom_tool", { kind: "browser", url: "https://example.com" }),
			request("custom_tool", { kind: "paths", paths: ["src/a.ts"] }),
			request("execute_command", { kind: "commands", commands: [] }),
			request("edit_file", { kind: "paths", paths: [] }),
			request("execute_command", { kind: "tool", manualOnly: false }),
		]) {
			assert.equal((await h.executor.authorizeTaskletPermission(input, signal())).approved, false)
		}
		sinon.assert.notCalled(h.decide)
	})

	it("enforces strict Plan at authorization and after a user escalation without banning commands", async () => {
		const h = harness()
		h.settings.mode = "plan"
		h.settings.yoloModeToggled = true
		const write = request("edit_file", { kind: "paths", paths: ["src/a.ts"] })
		assert.throws(() => h.executor.assertTaskletPermissionAllowed(write), /Plan Mode/)
		await assert.rejects(h.executor.authorizeTaskletPermission(write, signal()), /Plan Mode/)
		assert.equal((await h.executor.authorizeTaskletPermission(request(), signal())).approved, true)
	})

	it("rejects authority changes during asynchronous path checks", async () => {
		const h = harness(true)
		sinon.stub(HostProvider, "workspace").value({
			getWorkspacePaths: async () => {
				h.change()
				return { paths: ["/workspace"] }
			}
		})
		await assert.rejects(h.executor.authorizeTaskletPermission(request("edit_ast", {
			kind: "paths", paths: ["src/a.ts"],
		}), signal()), /authority changed/)
		sinon.assert.notCalled(h.decide)
	})

	it("cancellation invalidates a result before the child is released", async () => {
		const h = harness()
		h.settings.yoloModeToggled = true
		const abort = new AbortController()
		const result = await h.executor.authorizeTaskletPermission(request(), abort.signal)
		abort.abort()
		assert.throws(result.assertCurrent, /abort/i)
	})
})
