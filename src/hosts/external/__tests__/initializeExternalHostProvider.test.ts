import { strict as assert } from "node:assert"
import { buildDiagnosticsTrait } from "@core/task/tools/adapters/traits/DiagnosticsTraitBuilder"
import { diagnostics_scan_spec } from "@core/task/tools/modules/diagnostics_scan"
import { afterEach, beforeEach, describe, it } from "mocha"
import proxyquire from "proxyquire"
import sinon from "sinon"
import { getHostCapabilities, meetsHostCapabilityRequirement } from "@/hosts/host-capabilities"
import { HostProvider } from "@/hosts/host-provider"
import type { DiracExtensionContext } from "@/shared/dirac"

describe("external host initialization", () => {
	beforeEach(() => HostProvider.reset())
	afterEach(() => HostProvider.reset())

	it("preserves editor diagnostics through the dirac-core startup path", async () => {
		const filePaths = ["/workspace/file.ts"]
		const fileDiagnostics = [{ filePath: filePaths[0], diagnostics: [] }]
		const workspaceClient = {
			prepareDiagnostics: sinon.stub().resolves({ success: true }),
			getDiagnostics: sinon.stub().resolves({ fileDiagnostics }),
		}
		const { initializeExternalHostProvider } = proxyquire.noCallThru().load("../initializeExternalHostProvider", {
			"./host-bridge-client-manager": {
				ExternalHostBridgeClientManager: class {
					workspaceClient = workspaceClient
				},
			},
		}) as typeof import("../initializeExternalHostProvider")

		initializeExternalHostProvider({} as DiracExtensionContext, "/extension", "/data")

		assert.equal(getHostCapabilities().editorDiagnostics, true)
		assert.equal(meetsHostCapabilityRequirement(diagnostics_scan_spec), true)
		assert.equal(HostProvider.get().hostBridge.workspaceClient, workspaceClient)
		const diagnostics = buildDiagnosticsTrait()
		assert.ok(diagnostics)
		await diagnostics.prepare(filePaths)
		assert.deepEqual(await diagnostics.getRaw(filePaths), fileDiagnostics)
		sinon.assert.calledOnceWithExactly(workspaceClient.prepareDiagnostics, { filePaths })
		sinon.assert.calledOnceWithExactly(workspaceClient.getDiagnostics, { filePaths })
	})
})
