import * as assert from "assert"
import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import { FileEditProvider } from "../FileEditProvider"
import { FileOperationManager } from "../FileOperationManager"

class TestFileEditProvider extends FileEditProvider {
	async initialize(absolutePath: string, editType: "create" | "modify" = "modify") {
		this.absolutePath = absolutePath
		this.relPath = absolutePath
		this.editType = editType
		this.isEditing = true
		this.fileOpManager = new FileOperationManager(absolutePath, editType)
		await this.fileOpManager.setup()
		await this.openDiffEditor()
	}

	async write(content: string) {
		await this.replaceText(content, { startLine: 0, endLine: await this.getDocumentLineCount() }, undefined)
		await this.saveDocument()
	}
}

describe("FileEditProvider cancellation cleanup", () => {
	let root: string
	let providers: TestFileEditProvider[]

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-editor-ownership-"))
		providers = [new TestFileEditProvider(), new TestFileEditProvider(), new TestFileEditProvider()]
	})

	afterEach(async () => {
		await Promise.all(providers.map((provider) => provider.reset()))
		await fs.rm(root, { recursive: true, force: true })
	})

	it("releases one provider's buffer while preserving all written files and sibling buffers", async () => {
		const files = ["a.ts", "b.ts", "c.ts"].map((file) => path.join(root, file))
		await Promise.all(files.map((file) => fs.writeFile(file, "original")))
		await Promise.all(providers.map((provider, index) => provider.initialize(files[index])))
		await Promise.all(providers.map((provider, index) => provider.write(`edit ${index}`)))
		await providers[0].reset()
		assert.deepStrictEqual(await Promise.all(files.map((file) => fs.readFile(file, "utf8"))), [
			"edit 0",
			"edit 1",
			"edit 2",
		])
		assert.deepStrictEqual(await Promise.all(providers.map((provider) => provider.getContent())), [
			undefined,
			"edit 1",
			"edit 2",
		])
	})

	it("preserves a sibling's later shared-file write without reconciling independent buffers", async () => {
		const file = path.join(root, "shared.ts")
		await fs.writeFile(file, "original")
		await Promise.all(providers.map((provider) => provider.initialize(file)))
		await providers[0].write("owner write")
		await providers[1].write("sibling write")
		await providers[0].reset()
		assert.strictEqual(await fs.readFile(file, "utf8"), "sibling write")
		assert.strictEqual(await providers[0].getContent(), undefined)
		assert.strictEqual(await providers[1].getContent(), "sibling write")
		assert.strictEqual(await providers[2].getContent(), "original")
	})

	it("preserves a shared newly created file after a sibling saves it", async () => {
		const file = path.join(root, "created.ts")
		await providers[0].initialize(file, "create")
		await Promise.all(providers.slice(1).map((provider) => provider.initialize(file)))
		await providers[1].write("sibling write")
		await providers[0].reset()
		assert.strictEqual(await fs.readFile(file, "utf8"), "sibling write")
		assert.strictEqual(await providers[1].getContent(), "sibling write")
		assert.strictEqual(await providers[2].getContent(), "")
	})
})
