import { strict as assert } from "node:assert"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller } from "@core/controller"
import { deleteRemoteConfigFromCache, writeRemoteConfigToCache } from "@core/storage/disk"
import * as openFileIntegration from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/dirac/common"
import type { RemoteConfig } from "@shared/remote-config/schema"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"
import { openFile } from "../openFile"

describe("openFile (FB-37)", () => {
	let sandbox: sinon.SinonSandbox
	let mockController: Controller
	let openFileIntegrationStub: sinon.SinonStub
	let secretKeyMap: Map<string, string | undefined>
	let testGlobalStorageDir: string
	const testOrgId = `test-org-${Date.now()}`

	beforeEach(async () => {
		sandbox = sinon.createSandbox()
		secretKeyMap = new Map()

		testGlobalStorageDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-openfile-storage-"))
		setVscodeHostProviderMock({ globalStorageFsPath: testGlobalStorageDir })

		mockController = {
			stateManager: {
				getSecretKey: (key: string) => secretKeyMap.get(key),
				setSecretKey: (key: string, value: string | undefined) => secretKeyMap.set(key, value),
			},
		} as any

		openFileIntegrationStub = sandbox.stub(openFileIntegration, "openFile").resolves()
	})

	afterEach(async () => {
		sandbox.restore()
		await deleteRemoteConfigFromCache(testOrgId)
		HostProvider.reset()
		await fs.rm(testGlobalStorageDir, { recursive: true, force: true }).catch(() => {})
	})

	describe("Local file opening", () => {
		it("delegates local file paths to openFileIntegration directly", async () => {
			const request = StringRequest.create({ value: "/workspace/src/index.ts" })
			const result = await openFile(mockController, request)

			assert.deepEqual(result, Empty.create())
			sinon.assert.calledOnceWithExactly(openFileIntegrationStub, "/workspace/src/index.ts")
		})

		it("returns Empty when request value is empty", async () => {
			const request = StringRequest.create({ value: "" })
			const result = await openFile(mockController, request)

			assert.deepEqual(result, Empty.create())
			sinon.assert.notCalled(openFileIntegrationStub)
		})
	})

	describe("Remote file opening", () => {
		it("opens a remote rule from cached remote config with read-only header", async () => {
			secretKeyMap.set("dirac:diracAccountId", testOrgId)

			const remoteConfig: RemoteConfig = {
				version: "1.0",
				globalRules: [
					{
						name: "company-standards.md",
						contents: "Always follow TypeScript best practices.",
						alwaysEnabled: true,
					},
				],
			}
			await writeRemoteConfigToCache(testOrgId, remoteConfig)

			const request = StringRequest.create({ value: "remote://rule/company-standards.md" })
			const result = await openFile(mockController, request)

			assert.deepEqual(result, Empty.create())
			sinon.assert.calledOnce(openFileIntegrationStub)

			const openedPath = openFileIntegrationStub.firstCall.args[0]
			assert.ok(openedPath.includes("dirac-remote-rule-company-standards.md"))

			// Verify temp file content
			const fileContent = await fs.readFile(openedPath, "utf-8")
			assert.ok(fileContent.includes("# ⚠️ READ-ONLY: This rule is managed by your organization."))
			assert.ok(fileContent.includes("Always follow TypeScript best practices."))

			// Clean up temp file
			await fs.rm(openedPath, { force: true }).catch(() => {})
		})

		it("opens a remote workflow from cached remote config with read-only header", async () => {
			secretKeyMap.set("dirac:diracAccountId", testOrgId)

			const remoteConfig: RemoteConfig = {
				version: "1.0",
				globalWorkflows: [
					{
						name: "deploy-pipeline.md",
						contents: "Run npm test then deploy.",
						alwaysEnabled: true,
					},
				],
			}
			await writeRemoteConfigToCache(testOrgId, remoteConfig)

			const request = StringRequest.create({ value: "remote://workflow/deploy-pipeline.md" })
			const result = await openFile(mockController, request)

			assert.deepEqual(result, Empty.create())
			sinon.assert.calledOnce(openFileIntegrationStub)

			const openedPath = openFileIntegrationStub.firstCall.args[0]
			assert.ok(openedPath.includes("dirac-remote-workflow-deploy-pipeline.md"))

			const fileContent = await fs.readFile(openedPath, "utf-8")
			assert.ok(fileContent.includes("# ⚠️ READ-ONLY: This workflow is managed by your organization."))
			assert.ok(fileContent.includes("Run npm test then deploy."))

			await fs.rm(openedPath, { force: true }).catch(() => {})
		})

		it("throws when not signed in to a Dirac organization", async () => {
			secretKeyMap.delete("dirac:diracAccountId")

			const request = StringRequest.create({ value: "remote://rule/company-standards.md" })
			await assert.rejects(
				() => openFile(mockController, request),
				/Not signed in to a Dirac organization; cannot open remote rule: company-standards.md/,
			)
			sinon.assert.notCalled(openFileIntegrationStub)
		})

		it("throws when remote item is not found in cache", async () => {
			secretKeyMap.set("dirac:diracAccountId", testOrgId)
			await writeRemoteConfigToCache(testOrgId, { version: "1.0", globalRules: [] })

			const request = StringRequest.create({ value: "remote://rule/nonexistent-rule.md" })
			await assert.rejects(() => openFile(mockController, request), /Remote rule not found: nonexistent-rule.md/)
			sinon.assert.notCalled(openFileIntegrationStub)
		})

		it("throws when remote URI has invalid format", async () => {
			const request = StringRequest.create({ value: "remote://invalid/something.md" })
			await assert.rejects(
				() => openFile(mockController, request),
				/Invalid remote file URI: remote:\/\/invalid\/something.md/,
			)
			sinon.assert.notCalled(openFileIntegrationStub)
		})
	})
})
