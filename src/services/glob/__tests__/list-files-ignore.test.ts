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
	})
})
