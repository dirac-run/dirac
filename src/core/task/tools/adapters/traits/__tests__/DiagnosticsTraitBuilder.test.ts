import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import sinon from "sinon"
import { setHostCapabilities } from "@/hosts/host-capabilities"
import { HostProvider } from "@/hosts/host-provider"
import { buildDiagnosticsTrait } from "../DiagnosticsTraitBuilder"

describe("DiagnosticsTraitBuilder host availability", () => {
	afterEach(() => {
		sinon.restore()
		setHostCapabilities(undefined)
	})

	it("omits diagnostics until the host advertises editor diagnostics", () => {
		setHostCapabilities(undefined)
		assert.equal(buildDiagnosticsTrait(), undefined)
		setHostCapabilities({})
		assert.equal(buildDiagnosticsTrait(), undefined)
	})

	it("delegates preparation and collection on a capable host", async () => {
		setHostCapabilities({ editorDiagnostics: true })
		const fileDiagnostics = [{ filePath: "/workspace/file.ts", diagnostics: [] }]
		const workspaceClient = {
			prepareDiagnostics: sinon.stub().resolves({ success: true }),
			getDiagnostics: sinon.stub().resolves({ fileDiagnostics }),
		}
		sinon.stub(HostProvider, "get").returns({ hostBridge: { workspaceClient } } as never)

		const diagnostics = buildDiagnosticsTrait()
		assert.ok(diagnostics)
		await diagnostics.prepare(["/workspace/file.ts"])
		assert.deepEqual(await diagnostics.getRaw(["/workspace/file.ts"]), fileDiagnostics)
		sinon.assert.calledOnceWithExactly(workspaceClient.prepareDiagnostics, { filePaths: ["/workspace/file.ts"] })
		sinon.assert.calledOnceWithExactly(workspaceClient.getDiagnostics, { filePaths: ["/workspace/file.ts"] })
	})
})
