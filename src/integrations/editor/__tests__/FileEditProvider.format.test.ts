import * as assert from "assert"
import childProcess from "child_process"
import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import sinon from "sinon"
import { ExternalDiffViewProvider } from "@/hosts/external/ExternalDiffviewProvider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import type { DiffViewProvider } from "../DiffViewProvider"
import { FileEditProvider } from "../FileEditProvider"

const providers: Array<[string, () => DiffViewProvider]> = [
	["FileEditProvider", () => new FileEditProvider()],
	["ExternalDiffViewProvider", () => new ExternalDiffViewProvider()],
]

for (const [name, create] of providers) {
	describe(`${name}.format workspace containment`, () => {
		let root: string
		let cwd: string
		let execStub: sinon.SinonStub

		beforeEach(async () => {
			root = await fs.mkdtemp(path.join(os.tmpdir(), "format-containment-"))
			cwd = path.join(root, "proj")
			await fs.mkdir(cwd)
			await fs.mkdir(`${cwd}-evil`)
			setVscodeHostProviderMock({
				hostBridgeClient: {
					workspaceClient: { getWorkspacePaths: async () => ({ paths: [cwd] }) },
				} as any,
			})
			execStub = sinon.stub(childProcess, "exec").callsFake(((
				_cmd: string,
				_opts: unknown,
				cb: (err: null, out: object) => void,
			) => {
				cb(null, { stdout: "", stderr: "" })
			}) as unknown as typeof childProcess.exec)
		})

		afterEach(async () => {
			execStub.restore()
			await fs.rm(root, { recursive: true, force: true })
		})

		it("formats a file inside the workspace", async () => {
			const file = path.join(cwd, "x.ts")
			await fs.writeFile(file, "inside")
			assert.strictEqual(await create().format(file), "inside")
			assert.strictEqual(execStub.callCount, 1)
		})

		// Regression: `path.startsWith(cwd)` accepted a sibling directory sharing cwd's prefix.
		it("does not format a file in a sibling directory sharing the prefix", async () => {
			const file = path.join(`${cwd}-evil`, "x.ts")
			await fs.writeFile(file, "outside")
			assert.strictEqual(await create().format(file), "outside")
			assert.strictEqual(execStub.callCount, 0)
		})
	})
}
