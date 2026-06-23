import { MergeWorktreeRequest } from "@shared/proto/dirac/worktree"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import proxyquire from "proxyquire"
import * as sinon from "sinon"

// Creates a fake simple-git instance with stubbed methods
function createFakeGit(overrides: Partial<Record<string, sinon.SinonStub>> = {}) {
	return {
		revparse: overrides.revparse ?? sinon.stub(),
		status: overrides.status ?? sinon.stub(),
		merge: overrides.merge ?? sinon.stub(),
		diff: overrides.diff ?? sinon.stub(),
		raw: overrides.raw ?? sinon.stub(),
		deleteLocalBranch: overrides.deleteLocalBranch ?? sinon.stub(),
	}
}

describe("mergeWorktree", () => {
	let sandbox: sinon.SinonSandbox
	let mergeWorktree: typeof import("../mergeWorktree").mergeWorktree
	let getWorkspacePathStub: sinon.SinonStub
	let listWorktreesStub: sinon.SinonStub
	let simpleGitFake: sinon.SinonStub
	let telemetryStubs: { captureWorktreeMergeAttempted: sinon.SinonStub }
	let targetGit: ReturnType<typeof createFakeGit>
	let sourceGit: ReturnType<typeof createFakeGit>

	const sourceWorktreePath = "/repo/.worktrees/feature"
	const targetBranch = "main"
	const sourceBranch = "feature-branch"

	const makeRequest = (overrides: Partial<MergeWorktreeRequest> = {}): MergeWorktreeRequest =>
		MergeWorktreeRequest.create({ worktreePath: sourceWorktreePath, targetBranch, deleteAfterMerge: false, ...overrides })

	// Sets up the happy-path mocks: clean working trees, valid branches, successful merge
	function setupHappyPathMocks() {
		getWorkspacePathStub.resolves("/repo")
		listWorktreesStub.resolves({
			worktrees: [
				{
					path: "/repo",
					branch: targetBranch,
					commitHash: "abc",
					isCurrent: true,
					isBare: false,
					isDetached: false,
					isLocked: false,
				},
			],
			isGitRepo: true,
		})
		sourceGit.revparse.resolves(sourceBranch)
		sourceGit.status.resolves({ isClean: () => true })
		targetGit.status.resolves({ isClean: () => true })
		targetGit.merge.resolves()
		simpleGitFake.withArgs("/repo").returns(targetGit)
		simpleGitFake.withArgs(sourceWorktreePath).returns(sourceGit)
	}

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		getWorkspacePathStub = sandbox.stub()
		listWorktreesStub = sandbox.stub()
		telemetryStubs = { captureWorktreeMergeAttempted: sandbox.stub() }
		targetGit = createFakeGit()
		sourceGit = createFakeGit()
		simpleGitFake = sandbox.stub()

		// Load mergeWorktree with mocked dependencies via proxyquire
		mergeWorktree = proxyquire("../mergeWorktree", {
			"simple-git": { default: simpleGitFake, "@global": true },
			"@utils/path": { getWorkspacePath: getWorkspacePathStub, "@global": true },
			"@utils/git-worktree": { listWorktrees: listWorktreesStub, "@global": true },
			"@/services/telemetry": { telemetryService: telemetryStubs, "@global": true },
		}).mergeWorktree
	})

	afterEach(() => sandbox.restore())

	// --- Validation / guard clause tests ---

	it("fails when no workspace path is available", async () => {
		getWorkspacePathStub.resolves("")

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.message).to.include("No workspace folder found")
		expect(listWorktreesStub.called).to.be.false
	})

	it("fails when worktreePath is missing", async () => {
		getWorkspacePathStub.resolves("/repo")

		const result = await mergeWorktree({} as any, makeRequest({ worktreePath: "" }))

		expect(result.success).to.be.false
		expect(result.message).to.include("Worktree path is required")
	})

	it("fails when targetBranch is missing", async () => {
		getWorkspacePathStub.resolves("/repo")

		const result = await mergeWorktree({} as any, makeRequest({ targetBranch: "" }))

		expect(result.success).to.be.false
		expect(result.message).to.include("Target branch is required")
	})

	// --- Worktree lookup tests ---

	it("fails when target branch is not checked out in any worktree", async () => {
		getWorkspacePathStub.resolves("/repo")
		listWorktreesStub.resolves({ worktrees: [], isGitRepo: true })

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.message).to.include("not checked out in any worktree")
	})

	it("returns unexpected error when listWorktrees throws", async () => {
		getWorkspacePathStub.resolves("/repo")
		listWorktreesStub.rejects(new Error("git crashed"))

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.message).to.include("Unexpected error")
		expect(result.message).to.include("git crashed")
	})

	// --- Source branch resolution tests ---

	it("fails when revparse throws to get source branch name", async () => {
		setupHappyPathMocks()
		sourceGit.revparse.rejects(new Error("not a git repo"))

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.message).to.include("Failed to get branch name")
	})

	it("fails when source worktree is in detached HEAD state", async () => {
		setupHappyPathMocks()
		sourceGit.revparse.resolves("HEAD")

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.message).to.include("detached HEAD")
		expect(result.sourceBranch).to.equal("HEAD")
	})

	// --- Uncommitted changes tests ---

	it("fails when source worktree has uncommitted changes", async () => {
		setupHappyPathMocks()
		sourceGit.status.resolves({ isClean: () => false })

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.message).to.include("uncommitted changes")
		expect(result.sourceBranch).to.equal(sourceBranch)
	})

	it("continues when source status check throws (swallows error)", async () => {
		setupHappyPathMocks()
		sourceGit.status.rejects(new Error("status unavailable"))

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.true
	})

	it("fails when target worktree has uncommitted changes", async () => {
		setupHappyPathMocks()
		targetGit.status.resolves({ isClean: () => false })

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.message).to.include("Target worktree")
		expect(result.message).to.include("uncommitted changes")
	})

	it("continues when target status check throws (swallows error)", async () => {
		setupHappyPathMocks()
		targetGit.status.rejects(new Error("status unavailable"))

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.true
	})

	// --- Merge conflict tests ---

	it("detects merge conflicts, aborts merge, and returns conflicting files", async () => {
		setupHappyPathMocks()
		targetGit.merge.rejects(new Error("merge conflict"))
		targetGit.diff.resolves("src/a.ts\nsrc/b.ts\n")

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.hasConflicts).to.be.true
		expect(result.conflictingFiles).to.deep.equal(["src/a.ts", "src/b.ts"])
		expect(result.sourceBranch).to.equal(sourceBranch)
		expect(result.targetBranch).to.equal(targetBranch)
		expect(targetGit.merge.secondCall.args[0]).to.deep.equal(["--abort"])
		expect(telemetryStubs.captureWorktreeMergeAttempted.calledOnce).to.be.true
		expect(telemetryStubs.captureWorktreeMergeAttempted.firstCall.args).to.deep.equal([false, true, false])
	})

	it("returns non-conflict failure when merge throws but diff shows no conflicts", async () => {
		setupHappyPathMocks()
		targetGit.merge.rejects(new Error("some other error"))
		targetGit.diff.resolves("")

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.hasConflicts).to.be.false
		expect(result.message).to.include("Merge failed")
		expect(telemetryStubs.captureWorktreeMergeAttempted.firstCall.args).to.deep.equal([false, false, false])
	})

	it("returns non-conflict failure when both merge and diff throw", async () => {
		setupHappyPathMocks()
		targetGit.merge.rejects(new Error("merge boom"))
		targetGit.diff.rejects(new Error("diff boom"))

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.success).to.be.false
		expect(result.hasConflicts).to.be.false
		expect(result.message).to.include("Merge failed")
	})

	it("ignores errors when aborting a conflicted merge", async () => {
		setupHappyPathMocks()
		targetGit.merge.onFirstCall().rejects(new Error("conflict"))
		targetGit.merge.onSecondCall().rejects(new Error("abort failed"))
		targetGit.diff.resolves("src/conflict.ts\n")

		const result = await mergeWorktree({} as any, makeRequest())

		expect(result.hasConflicts).to.be.true
		expect(result.conflictingFiles).to.deep.equal(["src/conflict.ts"])
	})

	// --- Successful merge tests ---

	it("merges successfully without deleting worktree", async () => {
		setupHappyPathMocks()

		const result = await mergeWorktree({} as any, makeRequest({ deleteAfterMerge: false }))

		expect(result.success).to.be.true
		expect(result.message).to.include("Successfully merged")
		expect(result.message).to.not.include("removed worktree")
		expect(result.sourceBranch).to.equal(sourceBranch)
		expect(result.targetBranch).to.equal(targetBranch)
		expect(targetGit.raw.called).to.be.false
		expect(telemetryStubs.captureWorktreeMergeAttempted.firstCall.args).to.deep.equal([true, false, false])
	})

	it("merges successfully and deletes worktree when deleteAfterMerge is true", async () => {
		setupHappyPathMocks()
		targetGit.raw.resolves()
		targetGit.deleteLocalBranch.resolves()

		const result = await mergeWorktree({} as any, makeRequest({ deleteAfterMerge: true }))

		expect(result.success).to.be.true
		expect(result.message).to.include("removed worktree")
		expect(targetGit.raw.firstCall.args[0]).to.deep.equal(["worktree", "remove", sourceWorktreePath, "--force"])
		expect(targetGit.deleteLocalBranch.calledOnce).to.be.true
		expect(targetGit.deleteLocalBranch.firstCall.args[0]).to.equal(sourceBranch)
		expect(telemetryStubs.captureWorktreeMergeAttempted.firstCall.args).to.deep.equal([true, false, true])
	})

	it("returns success with warning when worktree deletion fails after successful merge", async () => {
		setupHappyPathMocks()
		targetGit.raw.rejects(new Error("worktree busy"))

		const result = await mergeWorktree({} as any, makeRequest({ deleteAfterMerge: true }))

		expect(result.success).to.be.true
		expect(result.message).to.include("failed to delete worktree")
		expect(result.message).to.include("worktree busy")
		expect(telemetryStubs.captureWorktreeMergeAttempted.called).to.be.false
	})

	it("ignores branch deletion errors after worktree removal", async () => {
		setupHappyPathMocks()
		targetGit.raw.resolves()
		targetGit.deleteLocalBranch.rejects(new Error("branch not found"))

		const result = await mergeWorktree({} as any, makeRequest({ deleteAfterMerge: true }))

		expect(result.success).to.be.true
		expect(result.message).to.include("removed worktree")
	})
})
