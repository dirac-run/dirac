import { strict as assert } from "node:assert"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, it } from "mocha"
import proxyquire from "proxyquire"
import simpleGit from "simple-git"
import sinon from "sinon"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { GitOperations } from "./CheckpointGitOperations"
import { withCheckpointRepositoryLock } from "./CheckpointLockUtils"
import { hashWorkingDir, validateWorkspacePath } from "./CheckpointUtils"
import type CheckpointTracker from "./CheckpointTracker"

function gate() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => { resolve = done })
	return { promise, resolve }
}

/** Real shadow repositories and Git commands; only host publication/folder leases are mocked. */
describe("checkpoint repository exclusion across trackers", function () {
	this.timeout(20_000)
	let temporary: string
	let workspace: string
	let Tracker: typeof CheckpointTracker
	let attempts: number
	let operationEntries: number
	let releases: Array<() => void>
	let pending: Promise<unknown>[]
	let publish: (event: { operation: string; isActive: boolean; taskId: string }) => Promise<void>

	async function gitPath(cwdHash: string) {
		const directory = path.join(temporary, "checkpoints", cwdHash)
		await fs.mkdir(directory, { recursive: true })
		return path.join(directory, ".git")
	}

	function track<T>(promise: Promise<T>): Promise<T> {
		pending.push(promise)
		return promise
	}

	async function attempted(count: number) {
		// Await actual entry to the exclusion helper, not a sleep guessing when Git starts.
		const deadline = Date.now() + 5000
		while (attempts < count) {
			assert.ok(Date.now() < deadline, "Checkpoint operation did not reach repository exclusion")
			await new Promise<void>((resolve) => setImmediate(resolve))
		}
		await new Promise<void>((resolve) => setImmediate(resolve))
	}

	beforeEach(async () => {
		temporary = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-checkpoint-concurrency-"))
		workspace = path.join(temporary, "workspace")
		await fs.mkdir(workspace)
		await fs.writeFile(path.join(workspace, "source.ts"), "initial\n")
		attempts = 0
		operationEntries = 0
		releases = []
		pending = []
		publish = async () => { }
		Tracker = proxyquire.noCallThru().load("./CheckpointTracker", {
			"@core/controller/checkpoints/subscribeToCheckpoints": { sendCheckpointEvent: (event: Parameters<typeof publish>[0]) => publish(event) },
			"@/services/telemetry": { telemetryService: { captureCheckpointUsage() { } } },
			"./CheckpointUtils": { getShadowGitPath: gitPath, hashWorkingDir, validateWorkspacePath },
			"./CheckpointLockUtils": {
				tryAcquireCheckpointLockWithRetry: async () => ({ acquired: true, skipped: false }),
				releaseCheckpointLock: async () => { },
				withCheckpointRepositoryLock: <T>(repository: string, operation: () => Promise<T>) => {
					attempts++
					return withCheckpointRepositoryLock(repository, () => {
						operationEntries++
						return operation()
					})
				},
			},
		}).default
	})

	afterEach(async () => {
		for (const release of releases) release()
		await Promise.allSettled(pending)
		sinon.restore()
		await fs.rm(temporary, { recursive: true, force: true })
	})

	async function trackers() {
		const first = (await Tracker.create("root", true, workspace))!
		const second = (await Tracker.create("sibling", true, workspace))!
		const git = simpleGit(path.dirname(await gitPath(hashWorkingDir(workspace))))
		return { first, second, git, initial: (await git.revparse(["HEAD"])).trim() }
	}

	it("does not hold the repository while publishing a completed checkpoint", async () => {
		const { first, second, initial } = await trackers()
		const entered = gate()
		const resume = gate()
		releases.push(resume.resolve)
		publish = async (event) => {
			if (event.taskId === "root" && event.operation === "CHECKPOINT_COMMIT" && !event.isActive) {
				entered.resolve()
				await resume.promise
			}
		}
		const commit = track(first.commit())
		await entered.promise
		await track(second.resetHead(initial))
		resume.resolve()
		await commit
	})

	function pauseFirstStage() {
		const entered = gate()
		const resume = gate()
		releases.push(resume.resolve)
		const original = GitOperations.prototype.addCheckpointFiles
		let calls = 0
		sinon.stub(GitOperations.prototype, "addCheckpointFiles").callsFake(async function (this: GitOperations, ...args) {
			const result = await original.apply(this, args)
			if (++calls === 1) {
				entered.resolve()
				await resume.promise
			}
			return result
		})
		return { entered: entered.promise, resume: resume.resolve }
	}

	it("keeps a sibling reset outside staging-through-commit", async () => {
		const { first, second, git, initial } = await trackers()
		await fs.writeFile(path.join(workspace, "source.ts"), "first checkpoint\n")
		const paused = pauseFirstStage()
		const commit = track(first.commit())
		await paused.entered
		const entries = operationEntries
		const target = attempts + 1
		const reset = track(second.resetHead(initial))
		await attempted(target)
		assert.equal(operationEntries, entries)
		paused.resume()
		const hash = await commit
		await reset
		assert.equal(await git.show([`${hash}:source.ts`]), "first checkpoint\n")
		assert.equal(await fs.readFile(path.join(workspace, "source.ts"), "utf8"), "initial\n")
	})

	it("keeps another staging operation out of an already staged commit", async () => {
		const { first, second, git } = await trackers()
		await fs.writeFile(path.join(workspace, "source.ts"), "first checkpoint\n")
		const paused = pauseFirstStage()
		const firstCommit = track(first.commit())
		await paused.entered
		// Ordinary workspace writes remain allowed; they must not replace the staged snapshot.
		await fs.writeFile(path.join(workspace, "source.ts"), "second checkpoint\n")
		const entries = operationEntries
		const target = attempts + 1
		const secondCommit = track(second.commit())
		await attempted(target)
		assert.equal(operationEntries, entries)
		paused.resume()
		const [firstHash, secondHash] = await Promise.all([firstCommit, secondCommit])
		assert.equal(await git.show([`${firstHash}:source.ts`]), "first checkpoint\n")
		assert.equal(await git.show([`${secondHash}:source.ts`]), "second checkpoint\n")
	})

	for (const method of ["getDiffSet", "getDiffCount"] as const) {
		it(`holds ${method} through result collection before a sibling reset`, async () => {
			const { first, second, initial } = await trackers()
			await fs.writeFile(path.join(workspace, "source.ts"), "changed\n")
			const paused = pauseFirstStage()
			const diff = track<Awaited<ReturnType<CheckpointTracker[typeof method]>>>(first[method](initial))
			await paused.entered
			const entries = operationEntries
			const target = attempts + 1
			const reset = track(second.resetHead(initial))
			await attempted(target)
			assert.equal(operationEntries, entries)
			paused.resume()
			const result = await diff
			if (typeof result === "number") assert.equal(result, 1)
			else assert.deepEqual(result.map(({ relativePath, before, after }) => ({ relativePath, before, after })), [
				{ relativePath: "source.ts", before: "initial\n", after: "changed\n" },
			])
			await reset
		})
	}

	it("serializes initialization/recovery and permits independent repositories", async () => {
		const entered = gate()
		const resume = gate()
		releases.push(resume.resolve)
		const original = GitOperations.prototype.initShadowGit
		let calls = 0
		sinon.stub(GitOperations.prototype, "initShadowGit").callsFake(async function (this: GitOperations, ...args) {
			if (++calls === 1) {
				entered.resolve()
				await resume.promise
			}
			return original.apply(this, args)
		})
		const first = track(Tracker.create("root", true, workspace))
		await entered.promise
		const second = track(Tracker.create("sibling", true, workspace))
		await attempted(2)
		assert.equal(calls, 1)
		const independent = path.join(temporary, "independent")
		await fs.mkdir(independent)
		assert.ok(await track(Tracker.create("other", true, independent)))
		assert.equal(calls, 2)
		resume.resolve()
		assert.ok((await Promise.all([first, second])).every(Boolean))
		const git = simpleGit(path.dirname(await gitPath(hashWorkingDir(workspace))))
		assert.equal((await git.log()).total, 1)
		assert.equal(await git.show(["HEAD:source.ts"]), "initial\n")
	})

	it("releases the repository after a failed operation so a waiting sibling can proceed", async () => {
		expectLoggerErrors()
		const { first, second, git } = await trackers()
		await fs.writeFile(path.join(workspace, "source.ts"), "after failure\n")
		const entered = gate()
		const resume = gate()
		releases.push(resume.resolve)
		const original = GitOperations.prototype.addCheckpointFiles
		let calls = 0
		sinon.stub(GitOperations.prototype, "addCheckpointFiles").callsFake(async function (this: GitOperations, ...args) {
			if (++calls === 1) {
				entered.resolve()
				await resume.promise
				throw new Error("injected staging failure")
			}
			return original.apply(this, args)
		})
		const failed = track(assert.rejects(first.commit(), /injected staging failure/))
		await entered.promise
		const entries = operationEntries
		const target = attempts + 1
		const next = track(second.commit())
		await attempted(target)
		assert.equal(operationEntries, entries)
		resume.resolve()
		await failed
		const hash = await next
		assert.equal(await git.show([`${hash}:source.ts`]), "after failure\n")
	})
})
