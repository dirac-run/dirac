import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { addedLineNumbers, checkAnyRatchet, findAddedAnyUsages } from "./check-any-ratchet.mjs"

const checker = fileURLToPath(new URL("./check-any-ratchet.mjs", import.meta.url))
const gate = fileURLToPath(new URL("./check-architecture.sh", import.meta.url))

function inspect(source, added = source.split("\n").map((_, i) => i + 1), file = "src/example.ts") {
	return findAddedAnyUsages(file, source, new Set(added))
}

test("ignores the reported documentation false positive, comments and literal text", () => {
	const source = [
		'const field = { enum: ["any", "all"], instruction: "Wait only: any target settled (default) or all targets settled." }',
		'const text = "as any / : any"',
		"// value as any; value: any",
		"/* multiline",
		"value as any; value: any",
		"*/",
		"const template = `as any and : any`",
		"const regex = /as any|: any/",
		"const any = 1; const anything = 2",
	].join("\n")
	assert.deepEqual(inspect(source), [])
})

test("finds real assertions and annotations, including arrays, without duplicate lines", () => {
	const source = [
		"const cast = value as any",
		"let value: any",
		"let values: any[]",
		"function call(input: any): any { return input as any }",
		"type Shape = { value: any; method(): any }",
		"const arrow = (): any => 1",
		"const castArray = value as any[]",
		"let union: any | string",
	].join("\n")
	assert.deepEqual(inspect(source), source.split("\n").map((line) => `src/example.ts:${line}`))
})

test("preserves the annotation/assertion scope rather than banning every explicit any form", () => {
	assert.deepEqual(inspect("type Alias = any\nlet list: Array<any>\nconst x = <any>value\nlet other: anything"), [])
})

test("renaming a file does not turn unchanged legacy any into a new violation", (t) => {
	const { cwd, git, write, base } = repository(t)
	git("mv", "src/existing.ts", "src/renamed.ts")
	assert.deepEqual(checkAnyRatchet(base, cwd), [])
	write("src/renamed.ts", "let legacy: any\nconst safe = 1\nlet added: any\n")
	assert.deepEqual(checkAnyRatchet(base, cwd), ["src/renamed.ts:let added: any"])
})

test("handles TSX text versus actual type syntax and template expressions", () => {
	const source = [
		'const view = <div title="as any">Wait only: any target</div>',
		"const typed = (value: any) => <div>{value}</div>",
		"const template = `text as any ${value as any}`",
	].join("\n")
	assert.deepEqual(inspect(source, [1, 2, 3], "webview-ui/src/view.tsx"), [
		`webview-ui/src/view.tsx:${source.split("\n")[1]}`,
		`webview-ui/src/view.tsx:${source.split("\n")[2]}`,
	])
})

test("parses complete files so added lines inside existing multiline comments remain ignored", () => {
	assert.deepEqual(inspect("/*\nvalue as any\n*/\nlet old: any\nconst safe = 1", [2, 5]), [])
})

test("detects multiline and comment-separated annotations only when the any line is added", () => {
	const source = "let x:\n  any\nconst y = x as /* explanation */ any\nlet z: // explanation\n any"
	assert.deepEqual(inspect(source, [2, 3, 5]), [
		"src/example.ts:  any", "src/example.ts:const y = x as /* explanation */ any", "src/example.ts: any",
	])
	assert.deepEqual(inspect(source, [1, 4]), [])
})

test("tracks added line numbers across replacement, deletion and insertion hunks", () => {
	const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -2,2 +2,2 @@\n-old\n-older\n+new\n+newer\n@@ -9 +8,0 @@\n-deleted\n@@ -12,0 +12 @@\n+last\n\\ No newline at end of file\n"
	assert.deepEqual([...addedLineNumbers(diff)], [2, 3, 12])
})

function repository(t) {
	const cwd = mkdtempSync(join(tmpdir(), "dirac-any-ratchet-"))
	t.after(() => rmSync(cwd, { recursive: true, force: true }))
	const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
	const write = (file, text) => {
		mkdirSync(dirname(join(cwd, file)), { recursive: true })
		writeFileSync(join(cwd, file), text)
	}
	git("init", "-b", "master")
	git("config", "user.name", "Ratchet test")
	git("config", "user.email", "ratchet@example.invalid")
	write("src/existing.ts", "let legacy: any\nconst safe = 1\n")
	write("src/deleted.ts", "let removed: any\n")
	git("add", ".")
	git("commit", "-m", "baseline")
	const base = git("rev-parse", "HEAD")
	return { cwd, git, write, base }
}

test("checks committed, staged and unstaged additions across source roots; retains exclusions", (t) => {
	const { cwd, git, write, base } = repository(t)
	write("src/existing.ts", "let legacy: any\nconst safe = 1\nlet committed: any\n")
	git("add", ".")
	git("commit", "-m", "new code")
	write("cli/src/staged.ts", "const staged = value as any\n")
	write('webview-ui/src/quoted "name.tsx', "let staged: any\n")
	write("src/ignored.test.ts", "let testOnly: any\n")
	write("src/__tests__/ignored.ts", "let testOnly: any\n")
	write("scripts/outside.ts", "let outside: any\n")
	git("add", ".")
	write("src/existing.ts", "let legacy: any\nconst safe = 1\nlet committed: any\nlet unstaged: any\n")
	write("src/untracked.ts", "let untracked: any\n")
	rmSync(join(cwd, "src/deleted.ts"))
	assert.deepEqual(checkAnyRatchet(base, cwd).sort(), [
		"cli/src/staged.ts:const staged = value as any",
		"src/existing.ts:let committed: any",
		"src/existing.ts:let unstaged: any",
		'webview-ui/src/quoted "name.tsx:let staged: any',
	].sort())
})

test("the architecture gate passes prose, fails genuine any, and propagates checker errors", (t) => {
	const { cwd, git, write } = repository(t)
	mkdirSync(join(cwd, "scripts"))
	copyFileSync(gate, join(cwd, "scripts/check-architecture.sh"))
	// Import the real checker from its installed dependency context.
	write("scripts/check-any-ratchet.mjs", `import { checkAnyRatchet } from ${JSON.stringify(new URL("./check-any-ratchet.mjs", import.meta.url).href)}\nfor (const v of checkAnyRatchet(process.argv[2])) console.log(v)\n`)
	write("scripts/architecture-baseline.txt", "# test baseline\n")
	write("scripts/architecture-allowlist.txt", "# test allowlist\n")
	git("checkout", "-b", "feature")
	const run = () => spawnSync("bash", ["scripts/check-architecture.sh", "--only", "check_any_ratchet"], { cwd, encoding: "utf8" })
	write("src/existing.ts", 'let legacy: any\nconst safe = 1\nconst text = "Wait only: any target settled"\n')
	let result = run()
	assert.equal(result.status, 0, result.stdout + result.stderr)
	assert.match(result.stdout, /0 known-debt violation\(s\), 0 new/)
	write("src/existing.ts", readFileSync(join(cwd, "src/existing.ts"), "utf8") + "let newValue: any\n")
	result = run()
	assert.equal(result.status, 1, result.stdout + result.stderr)
	assert.match(result.stdout, /1 NEW violation/)
	assert.match(result.stdout, /src\/existing.ts:let newValue: any/)
	write("scripts/check-any-ratchet.mjs", 'throw new Error("checker broke")\n')
	result = run()
	assert.equal(result.status, 2)
	assert.match(result.stderr, /Critical failure in check_any_ratchet/)
	assert.match(result.stderr, /checker broke/)
})

test("CLI rejects missing or invalid merge bases rather than silently passing", (t) => {
	assert.equal(spawnSync(process.execPath, [checker], { encoding: "utf8" }).status, 2)
	const { cwd } = repository(t)
	assert.notEqual(spawnSync(process.execPath, [checker, "not-a-revision"], { cwd, encoding: "utf8" }).status, 0)
})
