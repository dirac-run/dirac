import { strict as assert } from "node:assert"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { after, before, describe, it } from "mocha"
import { expectLoggerErrors } from "@/test/loggerGuard"
import { getCommitInfo, getLatestGitCommitHash, getWorkingState, searchCommits } from "../git"

const execFileAsync = promisify(execFile)

describe("git utilities injection safety and operations (FB-32)", () => {
	let tmpDir: string
	let headHash: string
	let initialHash: string

	before(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-git-test-"))

		// Initialize a real git repo for testing
		await execFileAsync("git", ["init"], { cwd: tmpDir })
		await execFileAsync("git", ["config", "user.name", "Dirac Test"], { cwd: tmpDir })
		await execFileAsync("git", ["config", "user.email", "test@dirac.run"], { cwd: tmpDir })

		// Commit 1: Initial commit
		await fs.writeFile(path.join(tmpDir, "file1.txt"), "first line\n")
		await execFileAsync("git", ["add", "file1.txt"], { cwd: tmpDir })
		await execFileAsync("git", ["commit", "-m", "Initial commit with feature foo"], { cwd: tmpDir })
		const { stdout: hash1 } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmpDir })
		initialHash = hash1.trim()

		// Commit 2: Second commit
		await fs.writeFile(path.join(tmpDir, "file2.txt"), "second line\n")
		await execFileAsync("git", ["add", "file2.txt"], { cwd: tmpDir })
		await execFileAsync("git", ["commit", "-m", "Fix: sanitize query; injection test $(whoami)"], { cwd: tmpDir })
		const { stdout: hash2 } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tmpDir })
		headHash = hash2.trim()
	})

	after(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
	})

	describe("searchCommits", () => {
		it("searches commits by message safely without shell injection", async () => {
			const queryWithMetachars = "; echo 'injected' && git status # $HOME `whoami`"
			const results = await searchCommits(queryWithMetachars, tmpDir)
			// No commits match the literal string, but no shell injection occurs and it returns cleanly
			assert.deepEqual(results, [])
		})

		it("finds commits matching message query", async () => {
			const results = await searchCommits("Initial commit", tmpDir)
			assert.strictEqual(results.length, 1)
			assert.strictEqual(results[0].hash, initialHash)
			assert.strictEqual(results[0].subject, "Initial commit with feature foo")
			assert.strictEqual(results[0].author, "Dirac Test")
		})

		it("finds commits by hash query fallback", async () => {
			const results = await searchCommits(initialHash.slice(0, 7), tmpDir)
			assert.strictEqual(results.length, 1)
			assert.strictEqual(results[0].hash, initialHash)
		})

		it("returns empty array for non-repo directory", async () => {
			expectLoggerErrors()
			const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-non-repo-"))
			try {
				const results = await searchCommits("test", emptyDir)
				assert.deepEqual(results, [])
			} finally {
				await fs.rm(emptyDir, { recursive: true, force: true })
			}
		})
	})

	describe("getCommitInfo", () => {
		it("retrieves commit info, summary, and diff safely", async () => {
			const info = await getCommitInfo(headHash, tmpDir)
			assert.ok(info.includes(`Commit: ${headHash.slice(0, 7)}`))
			assert.ok(info.includes("Author: Dirac Test"))
			assert.ok(info.includes("Fix: sanitize query; injection test $(whoami)"))
			assert.ok(info.includes("file2.txt"))
		})

		it("handles invalid or injected commit hashes safely", async () => {
			expectLoggerErrors()
			const maliciousHash = "HEAD; echo 'pwned'"
			const info = await getCommitInfo(maliciousHash, tmpDir)
			// Should return failure message, not execute shell command
			assert.ok(info.includes("Failed to get commit info"))
		})
	})

	describe("getWorkingState & getLatestGitCommitHash", () => {
		it("returns latest commit hash", async () => {
			const latestHash = await getLatestGitCommitHash(tmpDir)
			assert.strictEqual(latestHash, headHash)
		})

		it("returns working state when changes are present", async () => {
			await fs.writeFile(path.join(tmpDir, "file1.txt"), "modified line\n")
			const state = await getWorkingState(tmpDir)
			assert.ok(state.includes("file1.txt"))
			// Revert modification
			await execFileAsync("git", ["checkout", "file1.txt"], { cwd: tmpDir })
		})
	})
})
