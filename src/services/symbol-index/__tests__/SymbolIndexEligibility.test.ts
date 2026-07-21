import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, it } from "mocha"
import "should"
import sinon from "sinon"
import { SymbolIndexEligibility } from "../SymbolIndexEligibility"

const execFileAsync = promisify(execFile)

describe("SymbolIndexEligibility", () => {
	let projectRoot: string

	beforeEach(async () => {
		projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-symbol-eligibility-"))
		await execFileAsync("git", ["init", "-q"], { cwd: projectRoot })
		await execFileAsync("git", ["config", "user.email", "symbol-index@example.com"], { cwd: projectRoot })
		await execFileAsync("git", ["config", "user.name", "Symbol Index Test"], { cwd: projectRoot })
	})

	afterEach(async () => {
		sinon.restore()
		await fs.rm(projectRoot, { recursive: true, force: true })
	})

	it("uses Git ignore sources, negations, tracked-file rules, and standard generated exclusions", async () => {
		await fs.mkdir(path.join(projectRoot, "nested"), { recursive: true })
		await fs.mkdir(path.join(projectRoot, "generated"), { recursive: true })
		await fs.writeFile(path.join(projectRoot, ".gitignore"), "ignored.ts\ntracked.ts\n")
		await fs.writeFile(path.join(projectRoot, "nested", ".gitignore"), "*.ts\n!keep.ts\n")
		await fs.writeFile(path.join(projectRoot, "ignored.ts"), "export const ignored = 1\n")
		await fs.writeFile(path.join(projectRoot, "tracked.ts"), "export const tracked = 1\n")
		await fs.writeFile(path.join(projectRoot, "nested", "drop.ts"), "export const drop = 1\n")
		await fs.writeFile(path.join(projectRoot, "nested", "keep.ts"), "export const keep = 1\n")
		await fs.writeFile(path.join(projectRoot, "generated", "tracked.ts"), "export const generated = 1\n")
		await execFileAsync("git", ["add", "-f", "tracked.ts", "generated/tracked.ts"], { cwd: projectRoot })

		const result = await new SymbolIndexEligibility(projectRoot).enumerate()

		result.isGitWorkspace.should.be.true()
		result.paths.has("tracked.ts").should.be.true()
		result.paths.has(path.join("nested", "keep.ts")).should.be.true()
		result.paths.has("ignored.ts").should.be.false()
		result.paths.has(path.join("nested", "drop.ts")).should.be.false()
		result.paths.has(path.join("generated", "tracked.ts")).should.be.false()
	})

	it("returns watch directories for ignored-only subtrees", async () => {
		await fs.mkdir(path.join(projectRoot, "ignored-only", "nested"), { recursive: true })
		await fs.writeFile(path.join(projectRoot, ".gitignore"), "ignored-only/**/*.ts\n")
		await fs.writeFile(path.join(projectRoot, "ignored-only", ".gitignore"), "*.ts\n")
		await fs.writeFile(path.join(projectRoot, "ignored-only", "nested", "hidden.ts"), "export const hidden = 1\n")

		const result = await new SymbolIndexEligibility(projectRoot).enumerate()

		result.paths.has(path.join("ignored-only", "nested", "hidden.ts")).should.be.false()
		result.watchDirectories.has("ignored-only").should.be.true()
		result.watchDirectories.has(path.join("ignored-only", "nested")).should.be.true()
	})

	it("honors info excludes and configured global excludes", async () => {
		const globalExclude = path.join(projectRoot, "global-ignore")
		await fs.writeFile(globalExclude, "global.ts\n")
		await execFileAsync("git", ["config", "core.excludesFile", globalExclude], { cwd: projectRoot })
		await fs.writeFile(path.join(projectRoot, ".git", "info", "exclude"), "info.ts\n")
		await fs.writeFile(path.join(projectRoot, "info.ts"), "export const info = 1\n")
		await fs.writeFile(path.join(projectRoot, "global.ts"), "export const global = 1\n")
		await fs.writeFile(path.join(projectRoot, "allowed.ts"), "export const allowed = 1\n")

		const result = await new SymbolIndexEligibility(projectRoot).enumerate()

		result.paths.has("allowed.ts").should.be.true()
		result.paths.has("info.ts").should.be.false()
		result.paths.has("global.ts").should.be.false()
	})

	it("reflects newly ignored and newly unignored files on the next enumeration", async () => {
		await fs.writeFile(path.join(projectRoot, "dynamic.ts"), "export const dynamic = 1\n")
		const eligibility = new SymbolIndexEligibility(projectRoot)
		;(await eligibility.enumerate()).paths.has("dynamic.ts").should.be.true()

		await fs.writeFile(path.join(projectRoot, ".gitignore"), "dynamic.ts\n")
		;(await eligibility.enumerate()).paths.has("dynamic.ts").should.be.false()

		await fs.writeFile(path.join(projectRoot, ".gitignore"), "")
		;(await eligibility.enumerate()).paths.has("dynamic.ts").should.be.true()
	})

	it("fails closed when authoritative Git eligibility enumeration fails", async () => {
		const eligibility = new SymbolIndexEligibility(projectRoot)
		const runGit = sinon.stub(eligibility as any, "runGit")
		runGit.onFirstCall().resolves({ code: 0, stdout: Buffer.from("true\n"), stderr: "" })
		runGit.onSecondCall().resolves({ code: 1, stdout: Buffer.alloc(0), stderr: "injected failure" })

		let error: Error | null = null
		try {
			await eligibility.enumerate()
		} catch (caught) {
			error = caught as Error
		}

		error?.message.should.match(/Git eligibility enumeration failed/)
		runGit.callCount.should.equal(2)
	})
})
