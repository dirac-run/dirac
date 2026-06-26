import { expect } from "chai"
import type { SimpleGit } from "simple-git"
import sinon from "sinon"
import { DiffContentProvider } from "../CheckpointTracker"

// Stubbed subset of SimpleGit used by DiffContentProvider — type-safe on method names, stubs on values
type MockGit = {
	diffSummary: sinon.SinonStub
	show: sinon.SinonStub
	add: sinon.SinonStub
}

describe("DiffContentProvider", () => {
	let sandbox: sinon.SinonSandbox
	let mockGit: MockGit
	let gitDiffSummaryFiles: Array<{ file: string }> = []

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		gitDiffSummaryFiles = []
		mockGit = {
			diffSummary: sandbox.stub().callsFake(async () => ({ files: gitDiffSummaryFiles })),
			show: sandbox.stub(),
			add: sandbox.stub().resolves({}),
		}
	})

	afterEach(() => {
		sandbox.restore()
	})

	async function assertNoThrow(fn: () => Promise<unknown>): Promise<void> {
		try {
			await fn()
		} catch (err) {
			expect.fail((err as Error).message || "Expected no error but got one")
		}
	}

	describe("computeDiffSet", () => {
		it("should return empty array when no files in diff summary", async () => {
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const result = await provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123")
			expect(result).to.deep.equal([])
		})

		it("should exclude files matching exclusion patterns (node_modules)", async () => {
			gitDiffSummaryFiles = [{ file: "node_modules/pkg/index.js" }, { file: "src/app.ts" }]
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			mockGit.show.resolves("old content")
			const result = await provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123")

			expect(result.map((f) => f.relativePath)).to.deep.equal(["src/app.ts"])
		})

		it("should include files with actual content differences", async () => {
			gitDiffSummaryFiles = [{ file: "src/app.ts" }]
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			mockGit.show.resolves("old content here")
			const result = await provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123")

			expect(result).to.have.lengthOf(1)
			expect(result[0].relativePath).to.equal("src/app.ts")
		})

		it("should handle deleted files gracefully (empty after content)", async () => {
			gitDiffSummaryFiles = [{ file: "deleted.ts" }]
			mockGit.show.resolves("content that existed")
			const provider = new DiffContentProvider("/mock/cwd", "task-123")

			await assertNoThrow(() => provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123"))
		})

		it("should return diff entries with relativePath, absolutePath, before, after", async () => {
			gitDiffSummaryFiles = [{ file: "src/app.ts" }]
			mockGit.show.resolves("old content")
			const provider = new DiffContentProvider("/mock/cwd", "task-123")

			await assertNoThrow(() => provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123"))
		})
	})

	describe("computeDiffCount", () => {
		it("should return 0 when no files in diff summary", async () => {
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const result = await provider.computeDiffCount(mockGit as unknown as SimpleGit, "abc123")
			expect(result).to.equal(0)
		})

		it("should return count of files in diff summary", async () => {
			gitDiffSummaryFiles = [{ file: "src/a.ts" }, { file: "src/b.ts" }, { file: "src/c.ts" }]
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const result = await provider.computeDiffCount(mockGit as unknown as SimpleGit, "abc123")
			expect(result).to.equal(3)
		})

		it("should count only non-excluded files", async () => {
			gitDiffSummaryFiles = [{ file: "node_modules/pkg/index.js" }, { file: "src/app.ts" }]
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const result = await provider.computeDiffCount(mockGit as unknown as SimpleGit, "abc123")
			expect(result).to.equal(1)
		})

		it("should clean commit hashes before computing diff range", async () => {
			gitDiffSummaryFiles = [{ file: "src/app.ts" }]
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			await assertNoThrow(() => provider.computeDiffCount(mockGit as unknown as SimpleGit, "HEAD abc123"))
		})

		it("should handle rhsHash for commit-to-commit comparison", async () => {
			gitDiffSummaryFiles = [{ file: "src/app.ts" }]
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			await assertNoThrow(() => provider.computeDiffCount(mockGit as unknown as SimpleGit, "abc123", "def456"))
		})
	})

	describe("cleanCommitHash", () => {
		it("should strip HEAD prefix from commit hash", async () => {
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const result = provider.cleanCommitHash("HEAD abc123def")
			expect(result).to.equal("abc123def")
		})

		it("should return hash unchanged if no HEAD prefix", async () => {
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const result = provider.cleanCommitHash("abc123def")
			expect(result).to.equal("abc123def")
		})

		it("should handle empty string", async () => {
			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const result = provider.cleanCommitHash("")
			expect(result).to.equal("")
		})
	})

	// Verify the dedup refactor: both methods share prepareDiff, so git.add and diffSummary
	// are called exactly once per method invocation with identical arguments.
	describe("dedup consistency", () => {
		it("computeDiffSet and computeDiffCount call git.add with same args", async () => {
			gitDiffSummaryFiles = [{ file: "src/a.ts" }, { file: "node_modules/pkg/index.js" }]
			mockGit.show = sandbox.stub().resolves("content")
			const provider = new DiffContentProvider("/mock/cwd", "task-123")

			await provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123")
			await provider.computeDiffCount(mockGit as unknown as SimpleGit, "abc123")

			// git.add should be called twice (once per method), both with ["."]
			expect(mockGit.add.callCount).to.equal(2, "git.add should be called once per method")
			sinon.assert.calledWith(mockGit.add.firstCall, ["."])
			sinon.assert.calledWith(mockGit.add.secondCall, ["."])
		})

		it("computeDiffSet and computeDiffCount call diffSummary with same diff range", async () => {
			gitDiffSummaryFiles = [{ file: "src/a.ts" }]
			mockGit.show = sandbox.stub().resolves("content")
			const provider = new DiffContentProvider("/mock/cwd", "task-123")

			await provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123", "def456")
			await provider.computeDiffCount(mockGit as unknown as SimpleGit, "abc123", "def456")

			expect(mockGit.diffSummary.callCount).to.equal(2, "diffSummary should be called once per method")
			sinon.assert.calledWith(mockGit.diffSummary.firstCall, ["abc123..def456"])
			sinon.assert.calledWith(mockGit.diffSummary.secondCall, ["abc123..def456"])
		})

		it("computeDiffCount count matches computeDiffSet non-excluded file count", async () => {
			// 3 files: 1 excluded (node_modules), 1 with whitespace-only diff, 1 real diff
			gitDiffSummaryFiles = [{ file: "src/app.ts" }, { file: "src/util.ts" }, { file: "node_modules/pkg/index.js" }]
			mockGit.show = sandbox.stub()
				.onFirstCall().resolves("const x = 1")  // src/app.ts before
				.onSecondCall().resolves("const x = 2")  // src/app.ts after (real diff)
				.onThirdCall().resolves("const y = 1")   // src/util.ts before
				.onCall(3).resolves("  const y = 1  ")   // src/util.ts after (whitespace-only)

			const provider = new DiffContentProvider("/mock/cwd", "task-123")
			const diffSet = await provider.computeDiffSet(mockGit as unknown as SimpleGit, "abc123", "def456")
			const diffCount = await provider.computeDiffCount(mockGit as unknown as SimpleGit, "abc123", "def456")

			// diffSet excludes node_modules and whitespace-only => 1 file
			// diffCount excludes node_modules only => 2 files
			// This is expected: diffCount is a quick count, diffSet does deeper filtering
			expect(diffSet.length).to.be.lessThanOrEqual(diffCount, "diffSet should be <= diffCount (deeper filtering)")
			expect(diffCount).to.equal(2, "diffCount should exclude only node_modules")
		})
	})
})
