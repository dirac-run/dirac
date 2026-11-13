import assert from "node:assert/strict"
import { describe, it } from "mocha"
import sinon from "sinon"
import {
	classifyCommandCapabilities,
	COMMAND_CAPABILITY_CATEGORIES,
	DEFAULT_COMMAND_CAPABILITIES,
	getMissingCommandCapabilities,
	isSafeCommand,
	mergeCommandCapabilities,
} from "../CommandSafetyChecker"
import { LEGACY_READ_COMMANDS } from "./legacyReadCommands"

// Classify strings only. Never execute candidate commands.
describe("CommandSafetyChecker", () => {
	for (const command of [
		"git diff --ext-diff", "git log --ext-diff", "git show --textconv",
		"git hash-object file.txt", "git hash-object --path=file.txt file.txt",
		"gi''t diff --ext-''diff", "pwd && git diff --ext-diff", "(git show --textconv)",
	]) {
		it(`requires approval for underclassified Git helpers: ${JSON.stringify(command)}`, () => {
			assert.equal(classifyCommandCapabilities(command), -1)
			assert.equal(isSafeCommand(command, (1 << 30) - 1), false)
		})
	}

	it("keeps explicit helper-free Git diff automatic", () => {
		assert.equal(isSafeCommand("git diff --no-ext-diff --no-textconv"), true)
	})

	for (const platform of ["win32", "android", "unknown"]) {
		it(`does not apply Bash capabilities on unsupported platform ${platform}`, () => {
			const stub = sinon.stub(process, "platform").value(platform)
			try {
				assert.equal(classifyCommandCapabilities("echo safe # & del important.txt"), -1)
				assert.equal(isSafeCommand("echo safe # & del important.txt", (1 << 30) - 1), false)
				assert.equal(isSafeCommand("git status"), false)
			} finally {
				stub.restore()
			}
		})
	}

	it("packs the exact ten-category default policy", () => {
		assert.deepEqual(COMMAND_CAPABILITY_CATEGORIES, [
			"filesystem", "network", "processes", "execution", "credentials", "software",
			"configuration", "devices", "remote_resources", "system",
		])
		assert.deepEqual(
			COMMAND_CAPABILITY_CATEGORIES.map((_, index) => (DEFAULT_COMMAND_CAPABILITIES >>> (index * 3)) & 7),
			[3, 0, 3, 0, 0, 3, 3, 1, 0, 3],
		)
	})

	for (const command of ["ls -la", "git status", "cat README.md", "ps", "uname -a", "pwd && ls | head -20"]) {
		it(`approves known default capabilities: ${JSON.stringify(command)}`, () => {
			assert.equal(isSafeCommand(command), true)
		})
	}

	it("reports only above-default capabilities, ordered mutate/read/use then category", () => {
		const required = (7 << 0) | (1 << 3) | (7 << 6) | (3 << 12) | (1 << 24)
		assert.deepEqual(getMissingCommandCapabilities(required), [
			{ category: "filesystem", index: 0, access: 7 },
			{ category: "processes", index: 2, access: 7 },
			{ category: "credentials", index: 4, access: 3 },
			{ category: "network", index: 1, access: 1 },
			{ category: "remote_resources", index: 8, access: 1 },
		])
	})

	it("identifies known execution, filesystem and network deficits", () => {
		assert.deepEqual(getMissingCommandCapabilities(classifyCommandCapabilities("npm test")), [
			{ category: "execution", index: 3, access: 1 },
		])
		assert.deepEqual(getMissingCommandCapabilities(classifyCommandCapabilities("ls > out.txt")), [
			{ category: "filesystem", index: 0, access: 7 },
		])
		assert.deepEqual(getMissingCommandCapabilities(classifyCommandCapabilities("curl https://example.com")), [
			{ category: "remote_resources", index: 8, access: 3 },
			{ category: "network", index: 1, access: 1 },
		])
	})

	it("merges grants monotonically and only covers the requested capabilities", () => {
		const execution = 1 << 9
		const grants = mergeCommandCapabilities(DEFAULT_COMMAND_CAPABILITIES, execution)
		assert.equal(isSafeCommand("npm test", grants), true)
		assert.equal(isSafeCommand("rm file.txt", grants), false)
		assert.equal(mergeCommandCapabilities(grants, 0), grants)
		assert.equal(mergeCommandCapabilities(grants, 3 << 9), grants | (3 << 9))
		assert.throws(() => mergeCommandCapabilities(DEFAULT_COMMAND_CAPABILITIES, -1), /cannot be granted/)
	})

	for (const command of [
		"unknown_command_xyz", "ls $OPTIONS", "ls *.ts", "ls $(pwd)",
		"ls && unknown_command_xyz", "ls | unknown_command_xyz", "bash -c 'unknown_command_xyz'",
		"pwd && npm test -- --runInBand 2>&1",
	]) {
		it(`keeps the whole unknown input manual: ${JSON.stringify(command)}`, () => {
			assert.equal(classifyCommandCapabilities(command), -1)
			assert.equal(getMissingCommandCapabilities(classifyCommandCapabilities(command)), undefined)
			assert.equal(isSafeCommand(command, (1 << 30) - 1), false)
		})
	}

	it("uses the published whole-command shell model, not legacy body extraction", () => {
		assert.equal(isSafeCommand("(ls)"), true)
		assert.equal(isSafeCommand("cat < file.txt"), true)
		assert.equal(isSafeCommand("find . ! -delete"), false)
		assert.equal(isSafeCommand("bash -c 'ls'"), false)
	})

	it("migrates the 116 legacy read fixtures to 108 automatic and eight prompted commands", () => {
		const prompted = LEGACY_READ_COMMANDS.filter((command) => !isSafeCommand(command))
		assert.equal(LEGACY_READ_COMMANDS.length, 116)
		assert.equal(LEGACY_READ_COMMANDS.length - prompted.length, 108)
		assert.deepEqual(prompted, [
			"git branch",
			"nl -ba src/index.ts | sed -n '115,250p'",
			"sed -n '1p' file.txt",
			"sed -n '1787,1790p' src/core/task/index.ts",
			"sed -e '1,5p' file.txt",
			"sed -n '1,5p' file.txt | head -20",
			"sed -n '1,$p' input.txt",
			"nl -ba src/index.ts | sed -n '1,20p'",
		])
	})
})
