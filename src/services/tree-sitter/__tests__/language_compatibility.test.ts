import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { TaskState } from "@core/task/TaskState"
import { EditAstTool } from "@core/task/tools/modules/edit_ast/EditAstTool"
import { InspectAstTool } from "@core/task/tools/modules/inspect_ast/InspectAstTool"
import { ToolExecutorCoordinator } from "@core/task/tools/ToolExecutorCoordinator"
import { createMockContext } from "@core/task/tools/__tests__/helpers/mockTaskConfig"
import { HostProvider } from "@/hosts/host-provider"
import * as diagnosticsProvidersModule from "@/integrations/diagnostics/getDiagnosticsProviders"
import { SymbolIndexService } from "@/services/symbol-index/SymbolIndexService"
import { DiracDefaultTool } from "@shared/tools"
import { stripHashes } from "@shared/utils/line-hashing"
import { after, before, beforeEach, describe, it } from "mocha"
import sinon from "sinon"

const UPDATE_SNAPSHOTS = process.env.UPDATE_SNAPSHOTS === "true" || process.argv.includes("--update-snapshots")
const FIXTURES_DIR = path.join(__dirname, "fixtures")
const RESTORED_EXPECTATION_COUNT = 196
const HISTORICAL_ONLY_EXPECTATIONS = [
	"cpp/implementation_CppClass.txt",
	"cpp/occurrences_calculate_definition.txt",
	"rust/implementation_RustStruct.txt",
	"typescript/implementation_MyClass.txt",
	"typescript/implementation_innerFunction.txt",
	"typescript/implementation_nestedMethod.txt",
	"typescript/replace_nestedMethod.txt",
]
let workingFixturesDir = ""
let fixtureHashBeforeSuite = ""

interface ImplementationCase {
	name: string
	symbols: string[]
}

interface OccurrenceCase {
	name: string
	symbols: string[]
	operation: "definitions" | "references" | "occurrences"
}

interface ReplacementCase {
	name: string
	symbol: string
	replacement: string
}

interface LanguageCases {
	implementation: ImplementationCase[]
	occurrences: OccurrenceCase[]
	replace: ReplacementCase[]
}

interface ImplementationExpectation {
	symbol: string
	body: string
}

interface OccurrenceExpectation {
	kind?: "definition" | "reference"
	source: string
}

async function hashFixtureDirectory(directory: string): Promise<string> {
	const hash = createHash("sha256")
	const entries = await fs.readdir(directory, { withFileTypes: true })
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		const entryPath = path.join(directory, entry.name)
		hash.update(path.relative(directory, entryPath))
		if (entry.isDirectory()) hash.update(await hashFixtureDirectory(entryPath))
		else hash.update(await fs.readFile(entryPath))
	}
	return hash.digest("hex")
}

async function restoredExpectationFiles(): Promise<string[]> {
	const files: string[] = []
	for (const language of await fs.readdir(FIXTURES_DIR, { withFileTypes: true })) {
		if (!language.isDirectory()) continue
		for (const file of await fs.readdir(path.join(FIXTURES_DIR, language.name))) {
			if (/^(outline|implementation_.+|occurrences_.+|replace_.+)\.txt$/.test(file)) {
				files.push(path.join(language.name, file))
			}
		}
	}
	return files.sort()
}

async function configuredExpectationFiles(): Promise<string[]> {
	const files: string[] = []
	for (const language of await fs.readdir(FIXTURES_DIR, { withFileTypes: true })) {
		if (!language.isDirectory()) continue
		const cases: LanguageCases = JSON.parse(
			await fs.readFile(path.join(FIXTURES_DIR, language.name, "tests.json"), "utf-8"),
		)
		files.push(path.join(language.name, "outline.txt"))
		files.push(...cases.implementation.map((testCase) =>
			path.join(language.name, `implementation_${testCase.name}.txt`),
		))
		files.push(...cases.occurrences.map((testCase) =>
			path.join(language.name, `occurrences_${testCase.name}.txt`),
		))
		files.push(...cases.replace.map((testCase) =>
			path.join(language.name, `replace_${testCase.name}.txt`),
		))
	}
	return files.sort()
}

function normalizeSymbol(symbol: string): string {
	return symbol.replace(/::/g, ".")
}

function implementationBlocks(value: string): ImplementationExpectation[] {
	const normalized = stripHashes(value).replace(/\r\n/g, "\n")
	const header = /^(?:--- MATCH \d+\/\d+: )?([^\n:]+\.[^\n:]+)::([^\n]+)$/gm
	const matches = [...normalized.matchAll(header)]
	return matches.flatMap((match, index) => {
		const blockStart = (match.index ?? 0) + match[0].length
		const blockEnd = matches[index + 1]?.index ?? normalized.length
		const body = normalized
			.slice(blockStart, blockEnd)
			.replace(
				/^\n(?:\[(?:Function|Implementation) Hash: [a-f0-9]+\]|Implementation hash: [a-f0-9]+)\n(?:Implementation:\n)?/i,
				"",
			)
			.replace(/^\n/, "")
			.replace(/^context:\n/i, "")
			.replace(/^implementation:\n/im, "")
			.replace(/\n\n(?:---|====================)\n\n$/, "")
			.trimEnd()
		if (/^\n?(?:Symbol not found|Ambiguous symbol|Unsupported file|Access denied|Parse error):/i.test(body)) return []
		return [{ symbol: normalizeSymbol(match[2]), body }]
	})
}

function significantImplementationLines(body: string): string[] {
	return body
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && line !== "...")
}

function containsContiguousLines(actual: string[], expected: string[]): boolean {
	if (expected.length === 0 || expected.length > actual.length) return false
	return actual.some((_, index) => expected.every((line, offset) => actual[index + offset] === line))
}

function occurrenceRows(value: string): OccurrenceExpectation[] {
	const rows: OccurrenceExpectation[] = []
	for (const line of stripHashes(value).replace(/\r\n/g, "\n").split("\n")) {
		const current = line.match(/^  \[(definition|reference)\] line \d+:\d+ ?(.*)$/)
		const compact = line.match(/^  (definition|reference) \d+:\d+ ?(.*)$/)
		if (compact) {
			rows.push({ kind: compact[1] as OccurrenceExpectation["kind"], source: compact[2] })
			continue
		}
		if (current) {
			rows.push({ kind: current[1] as OccurrenceExpectation["kind"], source: current[2] })
			continue
		}
		const restored = line.match(/^  \([^)]+\) (.*)$/)
		if (restored) rows.push({ source: restored[1] })
	}
	return rows
}

function outlineLineIsPreserved(expectedLine: string, actualLines: string[]): boolean {
	const expectedCalls = expectedLine.match(/^│(\s*)# Calls: \[(.*)\]$/)
	if (!expectedCalls) return actualLines.includes(expectedLine.slice(1))
	const expectedIndentation = expectedCalls[1].slice(0, -4)
	const expectedCallNames = expectedCalls[2].split(", ")
	return actualLines.some((actualLine) => {
		const actualCalls = actualLine.match(/^(\s*)calls: (.*)$/)
		if (!actualCalls || actualCalls[1] !== expectedIndentation) return false
		const actualCallNames = new Set(actualCalls[2].split(", "))
		return expectedCallNames.every((call) => actualCallNames.has(call))
	})
}

function isMissingImplementationExpectation(value: string): boolean {
	return /None of the requested functions|Symbol not found|no implementation found/i.test(value) && implementationBlocks(value).length === 0
}

function isMissingOccurrenceExpectation(value: string): boolean {
	return (
		/No (?:definitions and references|references or definitions|definitions or references)(?: were)? found|No (?:definitions|references)(?: were)? found|Symbol not found|Ambiguous symbol|Unsupported file|is excluded from the symbol index/i.test(
			value,
		) && occurrenceRows(value).length === 0
	)
}

async function expectedSnapshot(snapshotPath: string, actual: string): Promise<string> {
	const strippedActual = stripHashes(actual)
	if (UPDATE_SNAPSHOTS) {
		await fs.writeFile(snapshotPath, strippedActual, "utf-8")
		return strippedActual
	}
	try {
		return stripHashes(await fs.readFile(snapshotPath, "utf-8"))
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Snapshot not found: ${snapshotPath}. Run with UPDATE_SNAPSHOTS=true to create it.`)
		}
		throw error
	}
}

function assertImplementationBody(
	actual: string,
	expected: ImplementationExpectation,
	context: string,
): void {
	const expectedLines = significantImplementationLines(expected.body)
	const actualBlocks = implementationBlocks(actual)
	const matchingBlock = actualBlocks.find((candidate) => candidate.symbol === expected.symbol)
	const preservingBlock = matchingBlock && containsContiguousLines(significantImplementationLines(matchingBlock.body), expectedLines)
		? matchingBlock
		: actualBlocks.find((candidate) => containsContiguousLines(significantImplementationLines(candidate.body), expectedLines))
	assert.ok(preservingBlock, `${context}: implementation changed for ${expected.symbol}\n${actual}`)
}

async function assertImplementationSnapshot(
	snapshotPath: string,
	actual: string,
	context: string,
	readQualified: (symbol: string) => Promise<string>,
): Promise<void> {
	const expectedText = await expectedSnapshot(snapshotPath, actual)
	if (/Ambiguous symbol|Unsupported file/i.test(expectedText)) {
		const actualBlocks = implementationBlocks(actual)
		if (actualBlocks.length === 0)
			assert.match(actual, /Ambiguous|Unsupported|not found/i, `${context}: expected failure was not explicit`)
		return
	}
	if (isMissingImplementationExpectation(expectedText)) {
		const actualBlocks = implementationBlocks(actual)
		if (actualBlocks.length === 0)
			assert.match(
				actual,
				/symbol not found|no .*found/i,
				`${context}: a missing symbol must be reported explicitly`,
			)
		else assert.doesNotMatch(actual, /Symbol not found|Ambiguous symbol/i, `${context}: improved lookup returned a failure`)
		return
	}

	const expectedBlocks = implementationBlocks(expectedText)
	assert.ok(expectedBlocks.length > 0, `${context}: restored implementation expectation contains no implementation blocks`)
	if (/Ambiguous symbol/i.test(actual)) {
		for (const expected of expectedBlocks) {
			assert.ok(normalizeSymbol(actual).includes(expected.symbol), `${context}: ambiguity output omitted candidate ${expected.symbol}`)
			const qualifiedResult = await readQualified(expected.symbol)
			assert.doesNotMatch(qualifiedResult, /Symbol not found|Ambiguous symbol/i, `${context}: ${expected.symbol} is not selectable`)
			assertImplementationBody(qualifiedResult, expected, context)
		}
		return
	}

	assert.doesNotMatch(actual, /Symbol not found/i, `${context}: implementation unexpectedly disappeared`)
	for (const expected of expectedBlocks) assertImplementationBody(actual, expected, context)
}

async function assertOccurrenceSnapshot(
	snapshotPath: string,
	actual: string,
	operation: OccurrenceCase["operation"],
	context: string,
	readQualified: (symbol: string) => Promise<string>,
): Promise<void> {
	const expectedText = await expectedSnapshot(snapshotPath, actual)
	if (isMissingOccurrenceExpectation(expectedText)) {
		const actualRows = occurrenceRows(actual)
		if (actualRows.length === 0) {
			assert.match(actual, /Symbol not found|No (?:definitions and references|references or definitions|definitions or references)(?: were)? found|No (?:definitions|references)(?: were)? found|Ambiguous|Unsupported file|is excluded from the symbol index/i, `${context}: a valid empty lookup must be reported explicitly\n${actual}`)
		}
		else if (operation !== "occurrences") {
			const expectedKind = operation === "definitions" ? "definition" : "reference"
			assert.ok(actualRows.every((row) => row.kind === expectedKind), `${context}: improved lookup returned the wrong kind`)
		}
		return
	}

	const expectedRows = occurrenceRows(expectedText)
	assert.ok(expectedRows.length > 0, `${context}: restored occurrence expectation contains no source rows`)
	let actualRows = occurrenceRows(actual)
	if (/Ambiguous symbol/i.test(actual)) {
		assert.equal(operation, "definitions", `${context}: references became ambiguous and cannot be characterized exactly\n${actual}`)
		const candidates = [...normalizeSymbol(actual).matchAll(/([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+) at line \d+/g)]
			.map((match) => match[1])
			.filter((candidate, index, all) => all.indexOf(candidate) === index)
		assert.ok(candidates.length > 1, `${context}: ambiguity output omitted qualified candidates`)
		actualRows = []
		for (const candidate of candidates) actualRows.push(...occurrenceRows(await readQualified(candidate)))
	}
	const referenceOwnershipIsExplicitlyAmbiguous = /References for .* are ambiguous/i.test(actual)
	const targetSymbol = (
		actual.match(/References for ([^\s]+) are ambiguous/i)?.[1] ?? actual.match(/^--- ([^\n]+) in /m)?.[1]
	)?.split(".").pop()
	for (const expectedRow of expectedRows) {
		if (actualRows.some((row) => row.source === expectedRow.source)) continue
		assert.equal(operation, "occurrences", `${context}: occurrence disappeared: ${expectedRow.source}\n${actual}`)
		assert.equal(referenceOwnershipIsExplicitlyAmbiguous, true, `${context}: missing occurrence was not characterized as ambiguous\n${actual}`)
		assert.ok(targetSymbol && expectedRow.source.includes(targetSymbol), `${context}: ambiguity does not explain omitted source: ${expectedRow.source}`)
	}
	if (operation !== "occurrences") {
		const expectedKind = operation === "definitions" ? "definition" : "reference"
		assert.ok(actualRows.every((row) => row.kind === expectedKind), `${context}: returned the wrong occurrence kind`)
	}
}

async function assertReplacementSnapshot(
	snapshotPath: string,
	actual: string,
	before: string,
	after: string,
	replacement: string,
	context: string,
): Promise<void> {
	const expectedText = await expectedSnapshot(snapshotPath, actual)
	const expectedFailure = /tool execution failed|Symbol .* not found/i.test(expectedText)
	if (expectedFailure) {
		assert.match(actual, /Symbol not found/i, `${context}: missing replacement target was not reported`)
		assert.equal(after, before, `${context}: failed replacement mutated the fixture`)
		return
	}
	assert.match(actual, /Replacement completed/i, `${context}: successful replacement was not reported`)
	assert.notEqual(after, before, `${context}: successful replacement did not mutate the fixture`)
	assert.ok(after.includes(replacement), `${context}: complete replacement text was not saved`)
}

function createMockConfig(cwd: string) {
	const taskState = new TaskState()
	const callbacks = {
		say: sinon.stub().resolves(undefined),
		ask: sinon.stub().resolves(undefined),
		askStatus: sinon.stub().resolves(undefined),
		askCompletion: sinon.stub().resolves(undefined),
		askProgress: sinon.stub().resolves(undefined),
		askError: sinon.stub().resolves(undefined),
		askWarning: sinon.stub().resolves(undefined),
		askInfo: sinon.stub().resolves(undefined),
		shouldAutoApproveToolWithPath: sinon.stub().resolves(true),
		resolveToolPathPermission: sinon.stub().resolves("auto_approve"),
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
		autoApprover: { isUnrestrictedAutoApprove: () => true },
		messageState: { getApiConversationHistory: sinon.stub().returns([]) },
		api: { getModel: () => ({ id: "test-model", info: { supportsImages: false } }) },
		services: {
			stateManager: {
				getApiConfiguration: () => ({ planModeApiProvider: "openai", actModeApiProvider: "openai" }),
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
				applyAndSaveSilently: sinon.stub().callsFake(async (absolutePath: string, content: string) => {
					await fs.writeFile(absolutePath, content, "utf-8")
					return { finalContent: content, content, userEdits: false, autoFormatting: false }
				}),
				applyAndSaveBatchSilently: sinon.stub().resolves(new Map()),
				showReview: sinon.stub().resolves(),
				hideReview: sinon.stub().resolves(),
				scrollToFirstDiff: sinon.stub().resolves(),
				undoUserEdits: sinon.stub().resolves(),
				format: sinon.stub().callsFake(async (absolutePath: string) => fs.readFile(absolutePath, "utf-8")),
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

async function executeInspection(
	cwd: string,
	operation: "outline" | "implementation" | "definitions" | "references" | "occurrences",
	extension: string,
	symbols?: string[],
): Promise<string> {
	const coordinator = new ToolExecutorCoordinator()
	coordinator.registerModularTool(new InspectAstTool())
	return String(await coordinator.execute(createMockConfig(cwd), {
		name: DiracDefaultTool.INSPECT_AST,
		params: {
			operation,
			paths: [`sample.${extension}`],
			...(symbols ? { symbols } : {}),
		},
	} as any))
}

describe("Source AST language compatibility", () => {
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

	before(async function () {
		this.timeout(30_000)
		const restored = await restoredExpectationFiles()
		assert.equal(restored.length, RESTORED_EXPECTATION_COUNT, "The complete operation-oriented expectation corpus must remain restored")
		assert.ok(restored.every((file) => /\/(?:outline|implementation_.+|occurrences_.+|replace_.+)\.txt$/.test(file)))
		const configured = await configuredExpectationFiles()
		const historicalOnly = restored.filter((file) => !configured.includes(file))
		assert.deepEqual(historicalOnly, HISTORICAL_ONLY_EXPECTATIONS)
		for (const file of historicalOnly) {
			assert.ok((await fs.readFile(path.join(FIXTURES_DIR, file), "utf-8")).trim().length > 0)
		}
		fixtureHashBeforeSuite = await hashFixtureDirectory(FIXTURES_DIR)
		workingFixturesDir = await fs.mkdtemp(path.join(os.tmpdir(), "dirac-source-ast-fixtures-"))
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

		sinon.stub(diagnosticsProvidersModule, "getDiagnosticsProviders").returns([
			{
				capturePreSaveState: sinon.stub().resolves([]),
				getDiagnosticsFeedback: sinon.stub().resolves({ fixedCount: 0, newProblemsMessage: "" }),
				getDiagnosticsFeedbackForFiles: sinon.stub().callsFake(
					async (data) => data.map(() => ({ newProblemsMessage: "", fixedCount: 0 })),
				),
			} as any,
		])
	})

	after(async function () {
		this.timeout(30_000)
		sinon.restore()
		SymbolIndexService.getInstance().dispose()
		await fs.rm(workingFixturesDir, { recursive: true, force: true })
		if (!UPDATE_SNAPSHOTS) {
			assert.equal(await hashFixtureDirectory(FIXTURES_DIR), fixtureHashBeforeSuite, "Tree-sitter fixtures were mutated")
		}
	})

	it("exercises restored historical expectations as preserved behavior or explicit improvements", async () => {
		for (const testCase of [
			{ language: "cpp", extension: "cpp", snapshot: "implementation_CppClass.txt", symbol: "CppClass" },
			{ language: "rust", extension: "rs", snapshot: "implementation_RustStruct.txt", symbol: "RustStruct" },
			{ language: "typescript", extension: "ts", snapshot: "implementation_MyClass.txt", symbol: "MyClass" },
		]) {
			const expected = await fs.readFile(path.join(FIXTURES_DIR, testCase.language, testCase.snapshot), "utf-8")
			const actual = await executeInspection(path.join(workingFixturesDir, testCase.language), "implementation", testCase.extension, [testCase.symbol])
			assert.ok(implementationBlocks(expected).length > 0, `${testCase.snapshot}: historical expectation is empty`)
			assert.doesNotMatch(actual, /Symbol not found|Ambiguous symbol/i, `${testCase.snapshot}: implementation disappeared`)
			assert.ok(implementationBlocks(actual).length > 0)
		}
		for (const testCase of [
			{ snapshot: "implementation_innerFunction.txt", symbol: "outerFunction.innerFunction" },
			{ snapshot: "implementation_nestedMethod.txt", symbol: "outerFunction.NestedClass.nestedMethod" },
		]) {
			const expected = await fs.readFile(path.join(FIXTURES_DIR, "typescript", testCase.snapshot), "utf-8")
			assert.equal(isMissingImplementationExpectation(expected), true)
			const actual = await executeInspection(path.join(workingFixturesDir, "typescript"), "implementation", "ts", [testCase.symbol])
			assert.doesNotMatch(actual, /Symbol not found|Ambiguous symbol/i)
			assert.equal(implementationBlocks(actual).length, 1)
		}

		const occurrenceExpectation = await fs.readFile(path.join(FIXTURES_DIR, "cpp", "occurrences_calculate_definition.txt"), "utf-8")
		assert.equal(isMissingOccurrenceExpectation(occurrenceExpectation), true)
		const occurrenceActual = await executeInspection(path.join(workingFixturesDir, "cpp"), "definitions", "cpp", ["calculate"])
		const occurrenceResults = occurrenceRows(occurrenceActual)
		if (occurrenceResults.length > 0) assert.ok(occurrenceResults.every((row) => row.kind === "definition"))
		else assert.match(occurrenceActual, /Symbol not found|Status: FAILURE|No .*found/i)

		const typescriptDirectory = path.join(workingFixturesDir, "typescript")
		const samplePath = path.join(typescriptDirectory, "sample.ts")
		const original = await fs.readFile(samplePath, "utf-8")
		const cases: LanguageCases = JSON.parse(await fs.readFile(path.join(typescriptDirectory, "tests.json"), "utf-8"))
		const replacement = cases.replace.find((testCase) => testCase.name === "nestedMethod_full")!
		const historicalReplacement = await fs.readFile(path.join(FIXTURES_DIR, "typescript", "replace_nestedMethod.txt"), "utf-8")
		assert.match(historicalReplacement, /not found/i)
		try {
			const coordinator = new ToolExecutorCoordinator()
			coordinator.registerModularTool(new EditAstTool())
			const actual = String(await coordinator.execute(createMockConfig(typescriptDirectory), {
				name: DiracDefaultTool.EDIT_AST,
				params: { operation: "replace", targets: [{ path: "sample.ts", symbol: replacement.symbol, replacement: replacement.replacement }] },
			} as any))
			assert.match(actual, /Replacement completed/i)
			assert.ok((await fs.readFile(samplePath, "utf-8")).includes(replacement.replacement))
		} finally {
			await fs.writeFile(samplePath, original, "utf-8")
		}
	})


	for (const language of languages) {
		describe(`Language: ${language.name}`, () => {
			let languageDirectory: string
			let samplePath: string
			let cases: LanguageCases

			beforeEach(async () => {
				languageDirectory = path.join(workingFixturesDir, language.name)
				samplePath = path.join(languageDirectory, `sample.${language.ext}`)
				cases = JSON.parse(await fs.readFile(path.join(languageDirectory, "tests.json"), "utf-8"))
			})

			it("matches the restored structural outline expectation", async () => {
				const actual = await executeInspection(languageDirectory, "outline", language.ext)
				const expected = await expectedSnapshot(path.join(FIXTURES_DIR, language.name, "outline.txt"), actual)
				const actualLines = stripHashes(actual).replace(/\r\n/g, "\n").split("\n")
				const expectedLines = stripHashes(expected).replace(/\r\n/g, "\n").split("\n")
				for (const line of expectedLines) {
					if (!line.startsWith("│")) continue
					assert.ok(outlineLineIsPreserved(line, actualLines), `${language.name}: outline declaration disappeared: ${line}\n${actual}`)
				}
			})

			it("matches restored implementation coverage, including explicit ambiguity", async () => {
				for (const testCase of cases.implementation) {
					const actual = await executeInspection(languageDirectory, "implementation", language.ext, testCase.symbols)
					await assertImplementationSnapshot(
						path.join(FIXTURES_DIR, language.name, `implementation_${testCase.name}.txt`),
						actual,
						`${language.name}: ${testCase.name}`,
						(symbol) => executeInspection(languageDirectory, "implementation", language.ext, [symbol]),
					)
				}
			})

			it("matches restored definition/reference/occurrence source locations", async () => {
				for (const testCase of cases.occurrences) {
					const actual = await executeInspection(languageDirectory, testCase.operation, language.ext, testCase.symbols)
					await assertOccurrenceSnapshot(
						path.join(FIXTURES_DIR, language.name, `occurrences_${testCase.name}.txt`),
						actual,
						testCase.operation,
						`${language.name}: ${testCase.name}`,
						(symbol) => executeInspection(languageDirectory, "definitions", language.ext, [symbol]),
					)
				}
			})

			it("matches restored replacement outcomes and verifies saved bytes", async () => {
				const originalContent = await fs.readFile(samplePath, "utf-8")
				try {
					for (const testCase of cases.replace) {
						const coordinator = new ToolExecutorCoordinator()
						coordinator.registerModularTool(new EditAstTool())
						const actual = String(await coordinator.execute(createMockConfig(languageDirectory), {
							name: DiracDefaultTool.EDIT_AST,
							params: {
								operation: "replace",
								targets: [{
									path: `sample.${language.ext}`,
									symbol: testCase.symbol,
									replacement: testCase.replacement,
								}],
							},
						} as any))
						const after = await fs.readFile(samplePath, "utf-8")
						await assertReplacementSnapshot(
							path.join(FIXTURES_DIR, language.name, `replace_${testCase.name}.txt`),
							actual,
							originalContent,
							after,
							testCase.replacement,
							`${language.name}: ${testCase.name}`,
						)
						await fs.writeFile(samplePath, originalContent, "utf-8")
					}
				} finally {
					await fs.writeFile(samplePath, originalContent, "utf-8")
				}
			})
		})
	}
})
