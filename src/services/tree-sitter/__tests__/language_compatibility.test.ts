import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { TaskState } from "@core/task/TaskState"
import { FindSymbolReferencesTool } from "@core/task/tools/modules/find_symbol_references/FindSymbolReferencesTool"
import { GetFunctionTool } from "@core/task/tools/modules/get_function/GetFunctionTool"
import { ReplaceSymbolTool } from "@core/task/tools/modules/replace_symbol/ReplaceSymbolTool"
import { GetFileSkeletonTool } from "@core/task/tools/modules/get_file_skeleton"
import { ToolValidator } from "@core/task/tools/ToolValidator"
import { ToolExecutorCoordinator } from "@core/task/tools/ToolExecutorCoordinator"
import { DiracDefaultTool } from "@shared/tools"
import { stripHashes } from "@shared/utils/line-hashing"
import { AnchorStateManager } from "@utils/AnchorStateManager"
import { after, before, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import { HostProvider } from "@/hosts/host-provider"
import * as diagnosticsProvidersModule from "@/integrations/diagnostics/getDiagnosticsProviders"
import { SymbolIndexService } from "@/services/symbol-index/SymbolIndexService"
import { DiracAskResponse } from "@shared/WebviewMessage"
import { createMockContext } from "@core/task/tools/__tests__/helpers/mockTaskConfig"

const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === "true" || process.argv.includes("--update-snapshots")
const FIXTURES_DIR = path.join(__dirname, "fixtures")
let workingFixturesDir = ""
let fixtureHashBeforeSuite = ""

async function hashFixtureDirectory(directory: string): Promise<string> {
	const hash = createHash("sha256")
	const entries = await fs.readdir(directory, { withFileTypes: true })
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const entryPath = path.join(directory, entry.name)
		const relativePath = path.relative(directory, entryPath)
		hash.update(relativePath)
		if (entry.isDirectory()) {
			hash.update(await hashFixtureDirectory(entryPath))
		} else {
			hash.update(await fs.readFile(entryPath))
		}
	}
	return hash.digest("hex")
}

function createMockConfig(cwd: string) {
	const taskState = new TaskState()
	const callbacks = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves({ response: DiracAskResponse.APPROVE }),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
		removeLastPartialMessageIfExistsWithType: sinon.stub().resolves(),
		sayAndCreateMissingParamError: sinon.stub().resolves("missing_param_error"),
		cancelTask: sinon.stub().resolves(),
		setActiveHookExecution: sinon.stub().resolves(),
		clearActiveHookExecution: sinon.stub().resolves(),
	}

	return {
		taskId: "test-task",
		ulid: "test-ulid",
		cwd,
		taskState,
		callbacks,
		messageState: {
			getApiConversationHistory: sinon.stub().returns([]),
		},

		api: {
			getModel: () => ({ id: "test-model", info: { supportsImages: false } }),
		},
		services: {
			stateManager: {
				getApiConfiguration: () => ({
					planModeApiProvider: "openai",
					actModeApiProvider: "openai",
				}),
				getGlobalSettingsKey: (key: string) => {
					if (key === "mode") return "act"
					if (key === "hooksEnabled") return false
					return undefined
				},
			},
			fileContextTracker: {
				markFileAsEditedByDirac: sinon.stub(),
				trackFileContext: sinon.stub().resolves(),
			},
			diracIgnoreController: {
				validateAccess: () => true,
				filterPaths: (paths: string[]) => paths,
			},
			diffViewProvider: {
				editType: undefined,
				open: sinon.stub().resolves(),
				update: sinon.stub().resolves(),
				reset: sinon.stub().resolves(),
				saveChanges: sinon.stub().resolves({ finalContent: "" }),
				applyAndSaveSilently: sinon.stub().resolves({ finalContent: "" }),
				applyAndSaveBatchSilently: sinon.stub().resolves(new Map()),
				showReview: sinon.stub().resolves(),
				hideReview: sinon.stub().resolves(),
				scrollToFirstDiff: sinon.stub().resolves(),
				undoUserEdits: sinon.stub().resolves(),
			} as any,
		},
		context: createMockContext(),
		taskMessenger: {
			createCard: sinon.stub().resolves({
				id: "mock-card-id",
				update: sinon.stub().resolves(),
				finalize: sinon.stub().resolves(),
				waitForInteraction: sinon.stub().resolves({ action: "approve" }),
				appendBody: sinon.stub().resolves(),
			}),
			upsertText: sinon.stub().resolves(),
			streamText: sinon.stub().resolves({ write: sinon.stub(), end: sinon.stub() }),
		},
	} as any
}

async function assertSnapshot(filePath: string, actual: string) {
	const strippedActual = stripHashes(actual)
	if (UPDATE_SNAPSHOTS) {
		await fs.mkdir(path.dirname(filePath), { recursive: true })
		await fs.writeFile(filePath, strippedActual, "utf-8")
		return
	}

	try {
		const expected = await fs.readFile(filePath, "utf-8")
		assert.strictEqual(strippedActual, expected, `Snapshot mismatch for ${filePath}`)
	} catch (error: any) {
		if (error.code === "ENOENT") {
			throw new Error(`Snapshot not found: ${filePath}. Run with UPDATE_SNAPSHOTS=true to create it.`)
		}
		throw error
	}
}

describe("Language Compatibility Tests (Big Four)", () => {
	const languages = [
		{ name: "typescript", ext: "ts" },
		{ name: "python", ext: "py" },
		{ name: "rust", ext: "rs" },
		{ name: "cpp", ext: "cpp" },
		{ name: "go", ext: "go" },
		{ name: "c", ext: "c" },
		{ name: "csharp", ext: "cs" },
		{ name: "ruby", ext: "rb" },
		{ name: "java", ext: "java" },
		{ name: "php", ext: "php" },
		{ name: "swift", ext: "swift" },
		{ name: "kotlin", ext: "kt" },
		{ name: "zig", ext: "zig" },
	]

	const validator = new ToolValidator({ validateAccess: () => true } as any)
	const handlers = {
		skeleton: new GetFileSkeletonTool(),
		getFunction: new GetFunctionTool(),
		references: new FindSymbolReferencesTool(),
		replace: new ReplaceSymbolTool(),
	}

	before(async function () {
		this.timeout(30_000)
		fixtureHashBeforeSuite = await hashFixtureDirectory(FIXTURES_DIR)
		workingFixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-fixtures-"))
		await fs.cp(FIXTURES_DIR, workingFixturesDir, { recursive: true })
		SymbolIndexService.getInstance().setPersistenceEnabled(false)
		SymbolIndexService.getInstance().setSkipRepoCheck(true)
		if (!HostProvider.isInitialized()) {
			HostProvider.initialize(
				"extension",
				null as any,
				null as any,
				null as any,
				null as any,
				{
					workspaceClient: {
						saveOpenDocumentIfDirty: sinon.stub().resolves(),
						getWorkspacePaths: sinon.stub().resolves({ paths: [workingFixturesDir] }),
						prepareDiagnostics: sinon.stub().resolves({}),
						getDiagnostics: sinon.stub().resolves({ fileDiagnostics: [] }),
					},
				} as any,
				null as any,
				null as any,
				null as any,
				"/tmp",
				"/tmp",
				async (_cwd: string) => undefined,
			)
		}

		// Mock diagnostics provider to prevent timeouts during linter polling
		sinon.stub(diagnosticsProvidersModule, "getDiagnosticsProviders").returns([
			{
				capturePreSaveState: sinon.stub().resolves([]),
				getDiagnosticsFeedback: sinon.stub().resolves({
					fixedCount: 0,
					newProblemsMessage: "",
				}),
				getDiagnosticsFeedbackForFiles: sinon
					.stub()
					.callsFake(async (data) => data.map(() => ({ newProblemsMessage: "", fixedCount: 0 }))),
			} as any,
		])
	})

	after(async function () {
		this.timeout(30_000)
		sinon.restore()
		await fs.rm(workingFixturesDir, { recursive: true, force: true })
		if (!UPDATE_SNAPSHOTS) {
			assert.strictEqual(
				await hashFixtureDirectory(FIXTURES_DIR),
				fixtureHashBeforeSuite,
				"Tree-sitter fixtures were mutated",
			)
		}
	})

	for (const lang of languages) {
		describe(`Language: ${lang.name}`, () => {
			let langDir: string
			let samplePath: string
			let config: any

			beforeEach(async () => {
				langDir = path.join(workingFixturesDir, lang.name)
				samplePath = path.join(langDir, `sample.${lang.ext}`)
				config = createMockConfig(langDir)
				AnchorStateManager.reset("test-ulid")
			})

			it("get_file_skeleton", async () => {
				const coordinator = new ToolExecutorCoordinator()
				coordinator.registerModularTool(handlers.skeleton)
				const result = await coordinator.execute(config, {
					name: DiracDefaultTool.GET_FILE_SKELETON,
					params: { paths: [`sample.${lang.ext}`] },
				} as any)
				await assertSnapshot(path.join(FIXTURES_DIR, lang.name, "get_file_skeleton.txt"), result as string)
			})

			describe("Complex Tool Tests", () => {
				let testCases: any
				before(async () => {
					const testsJson = await fs.readFile(path.join(langDir, "tests.json"), "utf-8")
					testCases = JSON.parse(testsJson)
				})

				it("get_function", async () => {
					for (const test of testCases.get_function) {
						const testConfig = createMockConfig(langDir)
						const coordinator = new ToolExecutorCoordinator()
						coordinator.registerModularTool(handlers.getFunction)
						const result = await coordinator.execute(testConfig, {
							name: DiracDefaultTool.GET_FUNCTION,
							params: {
								paths: [`sample.${lang.ext}`],
								function_names: test.symbols,
							},
						} as any)
						await assertSnapshot(
							path.join(FIXTURES_DIR, lang.name, `get_function_${test.name}.txt`),
							result as string,
						)
					}
				})

				it("find_symbol_references", async () => {
					for (const test of testCases.find_symbol_references) {
						const testConfig = createMockConfig(langDir)
						const coordinator = new ToolExecutorCoordinator()
						coordinator.registerModularTool(handlers.references)
						const result = await coordinator.execute(testConfig, {
							name: DiracDefaultTool.FIND_SYMBOL_REFERENCES,
							params: {
								paths: [`sample.${lang.ext}`],
								symbols: test.symbols,
								find_type: test.find_type || "both",
							},
						} as any)
						await assertSnapshot(
							path.join(FIXTURES_DIR, lang.name, `find_symbol_references_${test.name}.txt`),
							result as string,
						)
					}
				})

				it("replace_symbol", async () => {
					// Backup sample file content
					const originalContent = await fs.readFile(samplePath, "utf-8")
					try {
						for (const test of testCases.replace_symbol) {
							const testConfig = createMockConfig(langDir)
							const coordinator = new ToolExecutorCoordinator()
							coordinator.registerModularTool(handlers.replace)
							const result = await coordinator.execute(testConfig, {
								name: DiracDefaultTool.REPLACE_SYMBOL,
								params: {
									path: `sample.${lang.ext}`,
									symbol: test.symbol,
									text: test.text,
								},
							} as any)
							await assertSnapshot(
								path.join(FIXTURES_DIR, lang.name, `replace_symbol_${test.name}.txt`),
								result as string,
							)
							// Restore original content after each replace test
							await fs.writeFile(samplePath, originalContent, "utf-8")
						}
					} finally {
						await fs.writeFile(samplePath, originalContent, "utf-8")
					}
				})
			})
		})
	}
})
