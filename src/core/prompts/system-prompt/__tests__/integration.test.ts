/**
 * System Prompt Integration Tests with Snapshot Testing
 *
 * This suite snapshots the provider-neutral system prompt and each distinct native
 * tool-schema serialization family.
 *
 * Usage:
 * - Run tests normally: `npm run test:unit`
 *   Tests will fail if generated prompts don't match existing snapshots
 *
 * - Update snapshots: `npm run test:unit -- --update-snapshots`
 *   This will regenerate all snapshot files with current prompt output
 *
 * When tests fail:
 * 1. Review the differences shown in the error message
 * 2. Determine if changes are intentional (e.g., prompt improvements)
 * 3. If changes are correct, run with --update-snapshots to update baselines
 * 4. If changes are unintentional, investigate why prompt generation changed
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { SymbolIndexService } from "@/services/symbol-index/SymbolIndexService"
import { expect } from "chai"
import { getSystemPrompt } from "../index"
import type { SystemPromptContext } from "../types"
import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import { ToolDiscoveryService } from "@core/task/tools/discovery/ToolDiscoveryService"
import { DiracToolSet } from "../registry/DiracToolSet"
import { toolSpecFunctionDeclarations, toolSpecInputSchema } from "../spec"
import { mockProviderInfo } from "./test-helpers"
import { PromptBuilder } from "../registry/PromptBuilder"

// ============================================================================
// Configuration
// ============================================================================

const UPDATE_SNAPSHOTS = process.argv.includes("--update-snapshots") || process.env.UPDATE_SNAPSHOTS === "true"
const SNAPSHOTS_DIR = path.join(__dirname, "__snapshots__")
const TEST_TIMEOUT = 30000
const MAX_DIFF_LINES = 10

// ============================================================================
// Snapshot Helpers
// ============================================================================

const formatSnapshotError = (snapshotName: string, details: string): string => `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ SNAPSHOT MISMATCH: ${snapshotName}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${details}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 To update snapshots: npm run test:unit -- --update-snapshots
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`

const compareStrings = (expected: string, actual: string): string | null => {
	if (expected === actual) {
		return null
	}

	const expectedLines = expected.split("\n")
	const actualLines = actual.split("\n")
	const diffs: string[] = []

	for (let i = 0; i < Math.max(expectedLines.length, actualLines.length) && diffs.length < MAX_DIFF_LINES; i++) {
		const exp = expectedLines[i] || ""
		const act = actualLines[i] || ""
		if (exp !== act) {
			diffs.push(`Line ${i + 1}:`)
			if (exp) {
				diffs.push(`  - Expected: ${exp.substring(0, 100)}${exp.length > 100 ? "..." : ""}`)
			}
			if (act) {
				diffs.push(`  + Actual:   ${act.substring(0, 100)}${act.length > 100 ? "..." : ""}`)
			}
		}
	}

	return [
		`Expected: ${expected.length} chars, ${expectedLines.length} lines`,
		`Actual: ${actual.length} chars, ${actualLines.length} lines`,
		"",
		...diffs,
		diffs.length >= MAX_DIFF_LINES ? "... and more differences" : "",
	].join("\n")
}

async function assertSnapshot(name: string, content: string): Promise<void> {
	const snapshotPath = path.join(SNAPSHOTS_DIR, name)

	if (UPDATE_SNAPSHOTS) {
		await fs.writeFile(snapshotPath, content, "utf-8")
		console.log(`Updated snapshot: ${name} (${content.length} chars)`)
		return
	}

	try {
		const existing = await fs.readFile(snapshotPath, "utf-8")
		const diff = compareStrings(existing, content)
		if (diff) {
			throw new Error(formatSnapshotError(name, diff))
		}
		console.log(`✓ Snapshot matches: ${name}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(formatSnapshotError(name, `Snapshot does not exist. Run with --update-snapshots to create it.`))
		}
		throw error
	}
}

async function assertJsonSnapshot(name: string, actual: unknown): Promise<void> {
	const snapshotPath = path.join(SNAPSHOTS_DIR, name)

	if (UPDATE_SNAPSHOTS) {
		await fs.writeFile(snapshotPath, JSON.stringify(actual, null, 2), "utf-8")
		console.log(`Updated snapshot: ${name}`)
		return
	}

	try {
		const existing = await fs.readFile(snapshotPath, "utf-8")
		const expected = JSON.parse(existing)
		expect(actual).to.deep.equal(expected)
		console.log(`✓ Snapshot matches: ${name}`)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(formatSnapshotError(name, `Snapshot does not exist. Run with --update-snapshots to create it.`))
		}
		throw error
	}
}

// ============================================================================
// Test Context Helpers
// ============================================================================

const makeProviderInfo = (providerId: string, modelId: string) => ({
	providerId,
	model: { ...mockProviderInfo.model, id: modelId },
	mode: "act" as const,
})

const baseContext: SystemPromptContext = {
	cwd: "/test/project",
	ide: "TestIde",
	supportsBrowserUse: true,
	diracWebToolsEnabled: true,
	subagentsEnabled: true,
	lowVerbosityEnabled: true,
	browserSettings: { viewport: { width: 1280, height: 720 } },
	globalDiracRulesFileInstructions: "Follow global rules",
	localDiracRulesFileInstructions: "Follow local rules",
	preferredLanguageInstructions: "Prefer TypeScript",
	isTesting: true,
	providerInfo: mockProviderInfo,
}

type TestRunner = Mocha.Context & { timeout(ms: number): void }

function emptyToolSnapshot(): ToolRequestSnapshot {
	return {
		inventoryVersion: 0,
		requestId: "test",
		promptVisibleSpecs: [],
		inventoryEnabledTools: [],
		activeSkillIds: [],
		nativeTools: [],
		coordinator: { has: () => false } as any,
		executableToolNames: new Set(),
	}
}

function builtinToolSnapshot(context: SystemPromptContext): ToolRequestSnapshot {
	const inventoryEnabledTools = ToolDiscoveryService.scanBuiltinTools()
	const contextFilteredSpecs = inventoryEnabledTools
		.map((tool) => tool.spec)
		.filter((spec) => !spec.contextRequirements || spec.contextRequirements(context))
	const promptVisibleSpecs = DiracToolSet.withSubagentRoleSpecs(contextFilteredSpecs, context)
	const nativeTools = DiracToolSet.convertSpecsToNativeTools(promptVisibleSpecs, context)
	const executableToolNames = new Set(inventoryEnabledTools.map((tool) => tool.spec.name))
	return {
		inventoryVersion: 1,
		requestId: "test-builtins",
		promptVisibleSpecs,
		inventoryEnabledTools,
		activeSkillIds: [],
		nativeTools,
		coordinator: { has: (name: string) => executableToolNames.has(name) } as any,
		executableToolNames,
	}
}

function assertConsolidatedAstSpecs(snapshot: ToolRequestSnapshot): void {
	const astSpecs = snapshot.promptVisibleSpecs.filter((spec) => spec.name.endsWith("_ast"))
	expect(astSpecs.map((spec) => spec.name)).to.deep.equal(["edit_ast", "inspect_ast"])
	const inspect = astSpecs.find((spec) => spec.name === "inspect_ast")!
	const edit = astSpecs.find((spec) => spec.name === "edit_ast")!
	expect(inspect.description).to.include("Prefer inspect_ast")
	expect(inspect.description).to.include("never modifies files")
	expect(inspect.parameters?.find((parameter) => parameter.name === "operation")?.enum).to.deep.equal([
		"outline",
		"implementation",
		"definitions",
		"references",
		"occurrences",
	])
	expect(edit.description).to.include("AST-aware rename")
	expect(edit.description).to.include("whole-definition replacement")
	expect(edit.parameters?.find((parameter) => parameter.name === "operation")?.enum).to.deep.equal(["rename", "replace"])
	expect(edit.parameters?.find((parameter) => parameter.name === "targets")?.type).to.equal("array")
}

async function runPromptTest(
	testCtx: TestRunner,
	context: SystemPromptContext,
	handler: (
		result: Awaited<ReturnType<typeof getSystemPrompt>> & { tools: ToolRequestSnapshot["nativeTools"] },
	) => Promise<void>,
): Promise<void> {
	testCtx.timeout(TEST_TIMEOUT)
	const toolSnapshot = builtinToolSnapshot(context)
	assertConsolidatedAstSpecs(toolSnapshot)
	const result = await getSystemPrompt(context, toolSnapshot)
	await handler({ ...result, tools: toolSnapshot.nativeTools })
}

// ============================================================================
// Test Data
// ============================================================================

const nativeToolSchemaCases = [
	{
		name: "Anthropic",
		snapshotName: "anthropic.tools.snap",
		providerInfo: makeProviderInfo("anthropic", "claude-4-5-sonnet"),
	},
	{
		name: "OpenAI-compatible",
		snapshotName: "openai.tools.snap",
		providerInfo: makeProviderInfo("openai", "gpt-5"),
	},
	{
		name: "Gemini",
		snapshotName: "gemini.tools.snap",
		providerInfo: makeProviderInfo("gemini", "gemini-3"),
	},
]

const providerNeutralityCases = [
	...nativeToolSchemaCases.map(({ providerInfo }) => providerInfo),
	makeProviderInfo("vertex", "gemini-3"),
]

// ============================================================================
// Tests
// ============================================================================

describe("Prompt System Integration Tests", () => {
	before(async () => {
		SymbolIndexService.getInstance().setPersistenceEnabled(false)
		SymbolIndexService.getInstance().setSkipRepoCheck(true)
		console.log(UPDATE_SNAPSHOTS ? "🔄 SNAPSHOT UPDATE MODE" : "✓ SNAPSHOT TEST MODE")
		await fs.mkdir(SNAPSHOTS_DIR, { recursive: true }).catch(() => { })
	})

	describe("Snapshot Testing", () => {
		it("should generate a consistent provider-neutral system prompt", async function () {
			await runPromptTest(this, baseContext, async ({ systemPrompt }) => {
				expect(systemPrompt).to.be.a("string").with.length.greaterThan(100)
				await assertSnapshot("base.snap", systemPrompt)
			})
		})

		it("should not customize the system prompt by provider or model", async function () {
			this.timeout(TEST_TIMEOUT)
			const prompts: string[] = []

			for (const providerInfo of providerNeutralityCases) {
				const context: SystemPromptContext = { ...baseContext, providerInfo }
				const toolSnapshot = builtinToolSnapshot(context)
				assertConsolidatedAstSpecs(toolSnapshot)
				prompts.push((await getSystemPrompt(context, toolSnapshot)).systemPrompt)
			}

			for (const prompt of prompts.slice(1)) {
				expect(prompt).to.equal(prompts[0])
			}
		})

		for (const { name, snapshotName, providerInfo } of nativeToolSchemaCases) {
			it(`should generate consistent ${name} native tools`, async function () {
				const context: SystemPromptContext = { ...baseContext, providerInfo }

				await runPromptTest(this, context, async ({ tools }) => {
					await assertJsonSnapshot(snapshotName, tools)
				})
			})
		}
	})

	describe("Native Converter Routing", () => {
		it("should use Gemini schemas only for Vertex Gemini models", () => {
			expect(DiracToolSet.getNativeConverter("vertex", "gemini-3")).to.equal(toolSpecFunctionDeclarations)
			expect(DiracToolSet.getNativeConverter("vertex", "claude-sonnet")).to.equal(toolSpecInputSchema)
		})
	})

	describe("Stable Operating Contract", () => {
		it("should describe tool batching without depending on native parallel support", async function () {
			await runPromptTest(this, baseContext, async ({ systemPrompt }) => {
				expect(systemPrompt).to.include("grouping independent operations into one tool call")
				expect(systemPrompt).to.include("calling multiple independent tools in the same response")
			})
		})

		it("should remain stable across task modes", async function () {
			const actPrompt = await new PromptBuilder({
				...baseContext,
				providerInfo: { ...baseContext.providerInfo, mode: "act" },
			}).build()
			const planPrompt = await new PromptBuilder({
				...baseContext,
				providerInfo: { ...baseContext.providerInfo, mode: "plan" },
			}).build()

			expect(planPrompt).to.equal(actPrompt)
			expect(actPrompt).to.include(
				"The initial mode is provided at task start, and you will be notified every time the mode switches.",
			)
			expect(actPrompt).to.not.include("In each user message")
		})
	})

	describe("Context-Specific Features", () => {
		it("should include user instructions when provided", async function () {
			await runPromptTest(this, baseContext, async ({ systemPrompt }) => {
				expect(systemPrompt).to.include("USER'S CUSTOM INSTRUCTIONS")
			})
		})
	})

	describe("Error Handling", () => {
		it("should handle completely invalid context gracefully", async function () {
			this.timeout(TEST_TIMEOUT)
			const { systemPrompt } = await getSystemPrompt({} as SystemPromptContext, emptyToolSnapshot())
			expect(systemPrompt).to.be.a("string")
		})

		it("should handle undefined context properties", async function () {
			this.timeout(TEST_TIMEOUT)
			const contextWithNulls: SystemPromptContext = {
				cwd: undefined,
				ide: "",
				supportsBrowserUse: undefined,
				providerInfo: mockProviderInfo,
			}

			const { systemPrompt } = await getSystemPrompt(contextWithNulls, emptyToolSnapshot())
			expect(systemPrompt).to.be.a("string")
		})
	})
})
