import * as fs from "fs/promises"
import { after, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import "should"
import { listFiles } from "../list-files"

function normalizeForComparison(value: string): string {
	return path.normalize(value)
}

describe("listFiles ignore patterns", () => {
	const tmpDir = path.join(os.tmpdir(), `dirac-list-files-ignore-test-${Math.random().toString(36).slice(2)}`)

	after(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
	})

	it("ignores .log files and node_modules recursively", async () => {
		await fs.mkdir(tmpDir, { recursive: true })

		const logFile = path.join(tmpDir, "test.log")
		const txtFile = path.join(tmpDir, "test.txt")
		const nodeModulesDir = path.join(tmpDir, "node_modules")
		const nodeModulesFile = path.join(nodeModulesDir, "index.js")

		await fs.writeFile(logFile, "log content")
		await fs.writeFile(txtFile, "txt content")
		await fs.mkdir(nodeModulesDir)
		await fs.writeFile(nodeModulesFile, "js content")

		const [files] = await listFiles(tmpDir, true, 200)
		const normalizedFiles = files.map((f) => f.path).map(normalizeForComparison)

		normalizedFiles.should.containEql(normalizeForComparison(txtFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(logFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(nodeModulesFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(nodeModulesDir))
	})

	it("prunes ignored directories before descending into them", async () => {
		await fs.mkdir(tmpDir, { recursive: true })

		const txtFile = path.join(tmpDir, "src", "main.ts")
		const targetDepFile = path.join(tmpDir, "target", "dependency", "bad.jar")
		const buildDepFile = path.join(tmpDir, "build", "dependencies", "bad.jar")

		await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
		await fs.mkdir(path.join(tmpDir, "target", "dependency"), { recursive: true })
		await fs.mkdir(path.join(tmpDir, "build", "dependencies"), { recursive: true })
		await fs.writeFile(txtFile, "export const ok = true\n")
		await fs.writeFile(targetDepFile, "")
		await fs.writeFile(buildDepFile, "")

		const [files] = await listFiles(tmpDir, true, 200)
		const normalizedFiles = files.map((f) => f.path).map(normalizeForComparison)

		normalizedFiles.should.containEql(normalizeForComparison(txtFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(targetDepFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(buildDepFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(path.join(tmpDir, "target", "dependency")))
	})

	it("skips hidden directories when not explicitly targeting one", async () => {
		await fs.mkdir(tmpDir, { recursive: true })

		const visibleFile = path.join(tmpDir, "src", "main.ts")
		const hiddenFile = path.join(tmpDir, ".hidden", "secret.ts")

		await fs.mkdir(path.join(tmpDir, "src"), { recursive: true })
		await fs.mkdir(path.join(tmpDir, ".hidden"), { recursive: true })
		await fs.writeFile(visibleFile, "export const ok = true\n")
		await fs.writeFile(hiddenFile, "export const secret = 1\n")

		const [files] = await listFiles(tmpDir, true, 200)
		const normalizedFiles = files.map((f) => f.path).map(normalizeForComparison)

		normalizedFiles.should.containEql(normalizeForComparison(visibleFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(hiddenFile))
		normalizedFiles.should.not.containEql(normalizeForComparison(path.join(tmpDir, ".hidden")))
	})
})
