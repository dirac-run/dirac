import * as disk from "@core/storage/disk"
import type { HistoryItem, TaskHistoryItem } from "@shared/HistoryItem"
import { GetTaskHistoryRequest } from "@shared/proto/dirac/task"
import { expect } from "chai"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { TaskHistoryController } from "../TaskHistoryController"
import { processTaskHistory } from "../ui/processTaskHistory"
import { getTaskHistory } from "./getTaskHistory"

function task(id: string, workspace: Partial<TaskHistoryItem> = {}): TaskHistoryItem {
	return {
		id,
		ts: 1,
		task: id,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		...workspace,
	}
}

function controllerWithHistory(history: HistoryItem[], primaryRootPath = "/workspace/current"): Controller {
	return {
		stateManager: {
			getGlobalStateKey: () => history,
		},
		ensureWorkspaceManager: async () => ({
			getPrimaryRoot: () => ({ path: primaryRootPath }),
		}),
	} as unknown as Controller
}

describe("getTaskHistory workspace filtering", () => {
	const history = [
		task("root", { workspaceRootPath: "/workspace/current/" }),
		task("cwd", { cwdOnTaskInitialization: "/workspace/current" }),
		task("shadow", { shadowGitConfigWorkTree: "/workspace/current" }),
		task("other", { workspaceRootPath: "/workspace/other" }),
		task("unattributed"),
		task("authoritative-root", {
			workspaceRootPath: "/workspace/other",
			cwdOnTaskInitialization: "/workspace/current",
		}),
	]

	it("returns only records attributable to the current workspace when requested", async () => {
		const result = await getTaskHistory(
			controllerWithHistory(history),
			GetTaskHistoryRequest.create({ currentWorkspaceOnly: true }),
		)

		expect(result.tasks.map((item) => item.id)).to.deep.equal(["root", "cwd", "shadow"])
	})

	it("retains an explicit all-workspaces view", async () => {
		const result = await getTaskHistory(
			controllerWithHistory(history),
			GetTaskHistoryRequest.create({ currentWorkspaceOnly: false }),
		)

		expect(result.tasks.map((item) => item.id)).to.have.members(history.map((item) => item.id))
	})

	it("keeps preview and full workspace history aligned newest-first", async () => {
		const currentWorkspace = "/workspace/current"
		const taskHistory = [
			task("current-middle", { ts: 30, workspaceRootPath: currentWorkspace }),
			task("other-newest", { ts: 50, workspaceRootPath: "/workspace/other" }),
			task("current-newest", { ts: 40, cwdOnTaskInitialization: currentWorkspace }),
			task("current-oldest", { ts: 20, shadowGitConfigWorkTree: currentWorkspace }),
			task("unattributed-newest", { ts: 60 }),
		]

		const previewHistory = processTaskHistory(taskHistory, currentWorkspace)
		const fullHistory = await getTaskHistory(
			controllerWithHistory(taskHistory, currentWorkspace),
			GetTaskHistoryRequest.create({ currentWorkspaceOnly: true, sortBy: "newest" }),
		)

		expect(previewHistory.map((item) => item.id)).to.deep.equal(["current-newest", "current-middle", "current-oldest"])
		expect(fullHistory.tasks.map((item) => item.id)).to.deep.equal(previewHistory.map((item) => item.id))
		expect(fullHistory.tasks.slice(0, 3).map((item) => item.id)).to.deep.equal(
			previewHistory.slice(0, 3).map((item) => item.id),
		)
	})

	describe("getPromptHistory resilience", () => {
		afterEach(() => sinon.restore())

		it("falls back to the summary task prompt when a legacy transcript is unreadable", async () => {
			const warn = sinon.stub(Logger, "warn")
			const getSavedDiracMessages = sinon.stub(disk, "getSavedDiracMessages")
			getSavedDiracMessages
				.withArgs("legacy-unreadable")
				.rejects(new Error("Saved task transcript uses an unsupported or unreadable format"))
			getSavedDiracMessages.withArgs("valid-empty").resolves([])

			const historyController = new TaskHistoryController({
				getGlobalStateKey: () => [
					task("legacy-unreadable", {
						ts: 20,
						task: "legacy prompt text",
						workspaceRootPath: "/workspace/current",
					}),
					task("valid-empty", {
						ts: 10,
						task: "second prompt text",
						workspaceRootPath: "/workspace/current",
					}),
				],
			} as any)

			const prompts = await historyController.getPromptHistory("/workspace/current")

			expect(prompts).to.deep.equal([
				{ text: "legacy prompt text", ts: 20 },
				{ text: "second prompt text", ts: 10 },
			])
			sinon.assert.calledOnce(warn)
		})
	})
})
