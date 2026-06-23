import { Controller } from "@core/controller"
import { workspaceResolver } from "@core/workspace"
import * as fileSearchModule from "@services/search/file-search"
import * as telemetryModule from "@services/telemetry"
import { FileSearchRequest, FileSearchType } from "@shared/proto/dirac/file"
import * as conversionModule from "@shared/proto-conversions/file/search-result-conversion"
import * as pathUtils from "@utils/path"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { searchFiles } from "../searchFiles"

describe("searchFiles", () => {
	let sandbox: sinon.SinonSandbox
	let mockController: Controller
	let searchWorkspaceFilesStub: sinon.SinonStub
	let searchWorkspaceFilesMultirootStub: sinon.SinonStub
	let getWorkspacePathStub: sinon.SinonStub
	let convertStub: sinon.SinonStub
	let telemetryStubs: { captureMentionSearchResults: sinon.SinonStub; captureMentionFailed: sinon.SinonStub }
	let loggerErrorStub: sinon.SinonStub
	let resolveWorkspacePathStub: sinon.SinonStub
	let getActiveEditorStub: sinon.SinonStub

	const sampleResults = [
		{ path: "src/a.ts", type: "file" as const, label: "a.ts" },
		{ path: "src/b.ts", type: "file" as const, label: "b.ts" },
	]

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		mockController = { ensureWorkspaceManager: sandbox.stub().resolves(undefined) } as any
		searchWorkspaceFilesStub = sandbox.stub(fileSearchModule, "searchWorkspaceFiles")
		searchWorkspaceFilesMultirootStub = sandbox.stub(fileSearchModule, "searchWorkspaceFilesMultiroot")
		getWorkspacePathStub = sandbox.stub(pathUtils, "getWorkspacePath")
		convertStub = sandbox.stub(conversionModule, "convertSearchResultsToProtoFileInfos")
		loggerErrorStub = sandbox.stub(Logger, "error")
		resolveWorkspacePathStub = sandbox.stub(workspaceResolver, "resolveWorkspacePath")
		telemetryStubs = {
			captureMentionSearchResults: sandbox.stub().resolves(),
			captureMentionFailed: sandbox.stub().resolves(),
		}
		sandbox.stub(telemetryModule, "telemetryService").value(telemetryStubs as any)
		getActiveEditorStub = sandbox.stub().resolves({ filePath: "" })
		sandbox.stub(HostProvider, "window" as any).value({ getActiveEditor: getActiveEditorStub } as any)
	})

	afterEach(() => sandbox.restore())

	const makeRequest = (overrides: Partial<FileSearchRequest> = {}): FileSearchRequest =>
		FileSearchRequest.create({ query: "test", limit: 20, ...overrides })

	it("returns converted results and echoes mentionsRequestId for a single-root search", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.resolves(sampleResults)
		convertStub.returns([{ path: "src/a.ts" }, { path: "src/b.ts" }] as any)

		const result = await searchFiles(mockController, makeRequest({ mentionsRequestId: "req-1" }))

		expect(searchWorkspaceFilesStub.calledOnce).to.be.true
		expect(searchWorkspaceFilesMultirootStub.called).to.be.false
		expect(result.mentionsRequestId).to.equal("req-1")
		expect(result.results).to.have.lengthOf(2)
		expect(telemetryStubs.captureMentionSearchResults.calledOnce).to.be.true
	})

	it("uses multiroot search when workspace manager reports multiple roots", async () => {
		;(mockController as any).ensureWorkspaceManager = sandbox.stub().resolves({ getRoots: () => ["/root1", "/root2"] })
		searchWorkspaceFilesMultirootStub.resolves(sampleResults)
		convertStub.returns([{ path: "src/a.ts" }] as any)

		const result = await searchFiles(mockController, makeRequest({ workspaceHint: "root1" }))

		expect(searchWorkspaceFilesMultirootStub.calledOnce).to.be.true
		expect(searchWorkspaceFilesStub.called).to.be.false
		expect(searchWorkspaceFilesMultirootStub.firstCall.args[4]).to.equal("root1")
		expect(result.results).to.have.lengthOf(1)
	})

	it("returns empty results and captures telemetry when no workspace path is available", async () => {
		getWorkspacePathStub.resolves(undefined)

		const result = await searchFiles(mockController, makeRequest())

		expect(result.results).to.deep.equal([])
		expect(searchWorkspaceFilesStub.called).to.be.false
		expect(loggerErrorStub.calledOnce).to.be.true
		expect(telemetryStubs.captureMentionFailed.calledOnce).to.be.true
	})

	it("maps FILE selectedType to 'file' string filter for the search service", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.resolves([])
		convertStub.returns([] as any)

		await searchFiles(mockController, makeRequest({ selectedType: FileSearchType.FILE }))

		expect(searchWorkspaceFilesStub.firstCall.args[3]).to.equal("file")
		expect(telemetryStubs.captureMentionSearchResults.firstCall.args[2]).to.equal("file")
	})

	it("maps FOLDER selectedType to 'folder' string filter for the search service", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.resolves([])
		convertStub.returns([] as any)

		await searchFiles(mockController, makeRequest({ selectedType: FileSearchType.FOLDER }))

		expect(searchWorkspaceFilesStub.firstCall.args[3]).to.equal("folder")
		expect(telemetryStubs.captureMentionSearchResults.firstCall.args[2]).to.equal("folder")
	})

	it("defaults limit to 20 when not specified", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.resolves([])
		convertStub.returns([] as any)

		await searchFiles(mockController, makeRequest({ limit: undefined }))

		expect(searchWorkspaceFilesStub.firstCall.args[2]).to.equal(20)
	})

	it("moves the active editor file to position 0 when prioritizeActiveFile is set", async () => {
		getWorkspacePathStub.resolves("/workspace")
		const results = [
			{ path: "src/a.ts", type: "file" as const, label: "a.ts" },
			{ path: "src/active.ts", type: "file" as const, label: "active.ts" },
		]
		searchWorkspaceFilesStub.resolves(results)
		convertStub.callsFake((r: any[]) => r)
		getActiveEditorStub.resolves({ filePath: "/workspace/src/active.ts" })
		resolveWorkspacePathStub.withArgs("/workspace", "", "searchFiles.prioritize").returns("/workspace")
		resolveWorkspacePathStub
			.withArgs("/workspace/src/active.ts", "", "searchFiles.prioritize")
			.returns("/workspace/src/active.ts")

		const result = await searchFiles(mockController, makeRequest({ prioritizeActiveFile: true }))

		expect(result.results[0].path).to.equal("src/active.ts")
	})

	it("does not reorder when the active file is already first", async () => {
		getWorkspacePathStub.resolves("/workspace")
		const results = [
			{ path: "src/active.ts", type: "file" as const, label: "active.ts" },
			{ path: "src/a.ts", type: "file" as const, label: "a.ts" },
		]
		searchWorkspaceFilesStub.resolves(results)
		convertStub.callsFake((r: any[]) => r)
		getActiveEditorStub.resolves({ filePath: "/workspace/src/active.ts" })
		resolveWorkspacePathStub.returnsArg(0)

		const result = await searchFiles(mockController, makeRequest({ prioritizeActiveFile: true }))

		expect(result.results[0].path).to.equal("src/active.ts")
	})

	it("skips prioritization when active editor has no filePath", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.resolves(sampleResults)
		convertStub.callsFake((r: any[]) => r)
		getActiveEditorStub.resolves({ filePath: undefined })

		const result = await searchFiles(mockController, makeRequest({ prioritizeActiveFile: true }))

		expect(result.results[0].path).to.equal("src/a.ts")
	})

	it("swallows prioritizeActiveFile errors and still returns results", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.resolves(sampleResults)
		convertStub.callsFake((r: any[]) => r)
		getActiveEditorStub.rejects(new Error("editor unavailable"))

		const result = await searchFiles(mockController, makeRequest({ prioritizeActiveFile: true }))

		expect(result.results).to.have.lengthOf(2)
		expect(loggerErrorStub.called).to.be.true
	})

	it("returns empty results and captures permission_denied telemetry on permission errors", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.rejects(new Error("permission denied"))

		const result = await searchFiles(mockController, makeRequest())

		expect(result.results).to.deep.equal([])
		expect(telemetryStubs.captureMentionFailed.calledOnce).to.be.true
		expect(telemetryStubs.captureMentionFailed.firstCall.args[1]).to.equal("permission_denied")
	})

	it("returns empty results and captures unknown error type on generic errors", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.rejects(new Error("disk failure"))

		const result = await searchFiles(mockController, makeRequest({ selectedType: FileSearchType.FILE }))

		expect(result.results).to.deep.equal([])
		expect(telemetryStubs.captureMentionFailed.firstCall.args[0]).to.equal("file")
		expect(telemetryStubs.captureMentionFailed.firstCall.args[1]).to.equal("unknown")
	})

	it("defaults mention type to 'folder' for unfiltered searches on error", async () => {
		searchWorkspaceFilesStub.rejects(new Error("boom"))

		await searchFiles(mockController, makeRequest())

		expect(telemetryStubs.captureMentionFailed.firstCall.args[0]).to.equal("folder")
	})

	it("passes empty query string to the search service when query is unset", async () => {
		getWorkspacePathStub.resolves("/workspace")
		searchWorkspaceFilesStub.resolves([])
		convertStub.returns([] as any)

		await searchFiles(mockController, makeRequest({ query: undefined }))

		expect(searchWorkspaceFilesStub.firstCall.args[0]).to.equal("")
	})
})
