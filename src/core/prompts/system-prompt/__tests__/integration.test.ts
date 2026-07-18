/**
 * System Prompt Integration Tests with Snapshot Testing
 *
 * This test suite validates that system prompts remain consistent across different
 * context configurations using snapshot testing.
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

export const mockProviderInfo = {
	providerId: "test",
	model: { id: "fast", info: { supportsPromptCache: false } },
	mode: "act" as const,
}

const makeProviderInfo = (modelId: string, providerId = "test") => ({
	providerId,
	model: { ...mockProviderInfo.model, id: modelId },
	mode: "act" as const,
	customPrompt: providerId.includes("lmstudio") ? "compact" : undefined,
})

const baseContext: SystemPromptContext = {
	cwd: "/test/project",
	ide: "TestIde",
	supportsBrowserUse: true,
	diracWebToolsEnabled: true,
	subagentsEnabled: true,
	browserSettings: { viewport: { width: 1280, height: 720 } },
	globalDiracRulesFileInstructions: "Follow global rules",
	localDiracRulesFileInstructions: "Follow local rules",
	preferredLanguageInstructions: "Prefer TypeScript",
	isTesting: true,
	providerInfo: mockProviderInfo,
}

type TestRunner = Mocha.Context & { skip(): void; timeout(ms: number): void }

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
		dynamicSubagentToolNames: new Set(),
	}
}

async function runPromptTest(
	testCtx: TestRunner,
	context: SystemPromptContext,
	modelId: string,
	handler: (
		result: Awaited<ReturnType<typeof getSystemPrompt>> & { tools: ToolRequestSnapshot["nativeTools"] },
	) => Promise<void>,
): Promise<void> {
	testCtx.timeout(TEST_TIMEOUT)
	const toolSnapshot = emptyToolSnapshot()
	const result = await getSystemPrompt(context, toolSnapshot)
	await handler({ ...result, tools: toolSnapshot.nativeTools })
}

// ============================================================================
// Test Data
// ============================================================================

const contextVariations: Array<{ name: string; override: Partial<SystemPromptContext> }> = [
	{ name: "basic", override: {} },
	{ name: "no-browser", override: { supportsBrowserUse: false } },
]

const modelTestCases = [
	{ modelId: "claude-4-5-sonnet", providerId: "anthropic" }, // Anthropic format
	{ modelId: "gpt-5", providerId: "openai" }, // OpenAI format
	{ modelId: "gemini-3", providerId: "gemini" }, // Gemini format
	{ modelId: "gemini-3", providerId: "vertex" }, // Vertex/Gemini format
]

// ============================================================================
// Tests
// ============================================================================

describe("Prompt System Integration Tests", () => {
	before(async () => {
		SymbolIndexService.getInstance().setPersistenceEnabled(false)
		SymbolIndexService.getInstance().setSkipRepoCheck(true)
		console.log(UPDATE_SNAPSHOTS ? "🔄 SNAPSHOT UPDATE MODE" : "✅ SNAPSHOT TEST MODE")
		await fs.mkdir(SNAPSHOTS_DIR, { recursive: true }).catch(() => { })
	})

	describe("Snapshot Testing", () => {
		for (const { modelId, providerId } of modelTestCases) {
			describe(`Model: ${modelId} (${providerId})`, () => {
				it(`should generate consistent native tools object`, async function () {
					const providerInfo = makeProviderInfo(modelId, providerId)

					const context: SystemPromptContext = {
						...baseContext,
						providerInfo,
					}

					await runPromptTest(this, context, modelId, async ({ tools }) => {
						const snapshotName = `${providerId}_${modelId.replace(/[^a-zA-Z0-9]/g, "_")}.tools.snap`
						await assertJsonSnapshot(snapshotName, tools)
					})
				})

				for (const { name: contextName, override } of contextVariations) {
					it(`should generate consistent prompt with ${contextName} context`, async function () {
						const providerInfo = makeProviderInfo(modelId, providerId)
						const context: SystemPromptContext = {
							...baseContext,
							...override,
							providerInfo,
						}

						await runPromptTest(this, context, modelId, async ({ systemPrompt, tools }) => {
							expect(systemPrompt).to.be.a("string").with.length.greaterThan(100)

							const snapshotName = `${providerId}_${modelId.replace(/[^a-zA-Z0-9]/g, "_")}-${contextName}.snap`
							await assertSnapshot(snapshotName, systemPrompt)
						})
					})
				}
			})
		}
	})

	describe("Parallel Tool Calling", () => {
		it(`should include parallel tool-calling guidance when enabled`, async function () {
			const context: SystemPromptContext = {
				...baseContext,
				enableParallelToolCalling: true,
			}

			await runPromptTest(this, context, "default", async ({ systemPrompt }) => {
				expect(systemPrompt).to.include(
					"You may use multiple tools in a single response when the operations are independent",
				)
			})
		})
	})

	describe("Context-Specific Features", () => {
		const featureTests = [{ name: "user instructions when provided", context: {}, check: "USER'S CUSTOM INSTRUCTIONS" }]

		for (const { name, context, check } of featureTests) {
			it(`should include ${name}`, async function () {
				await runPromptTest(this, { ...baseContext, ...context }, "default", async ({ systemPrompt }) => {
					expect(systemPrompt.toLowerCase()).to.include(check.toLowerCase())
				})
			})
		}
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
