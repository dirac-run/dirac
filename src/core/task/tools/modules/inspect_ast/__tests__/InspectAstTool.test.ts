import { strict as assert } from "node:assert"
import { CardStatus } from "@shared/ExtensionMessage"
import type { IToolEnvironment } from "../../../interfaces/IToolEnvironment"
import { InspectAstTool, inspect_ast_spec } from "../InspectAstTool"

function definition(qualifiedName = "main", declarationLine = 0) {
	return {
		simpleName: qualifiedName.split(".").at(-1)!,
		qualifiedName,
		kind: "function" as const,
		nameRange: { startIndex: 0, endIndex: 4, startLine: declarationLine, startColumn: 0, endLine: declarationLine, endColumn: 4 },
		definitionRange: { startIndex: 0, endIndex: 18, startLine: declarationLine, startColumn: 0, endLine: declarationLine, endColumn: 18 },
		replacementRange: { startIndex: 0, endIndex: 18, startLine: declarationLine, startColumn: 0, endLine: declarationLine, endColumn: 18 },
		declarationLine,
		declarationText: `function ${qualifiedName.split(".").at(-1)}() {}`,
		indentation: "",
		calls: [],
		contextLines: [],
	}
}

function makeCard(params: any) {
	return {
		...params,
		id: "card-1",
		header: params.header,
		initialHeader: params.header,
		status: params.status,
		collapsed: params.collapsed,
		renderType: params.renderType ?? "text",
		updates: [] as any[],
		finalStatuses: [] as CardStatus[],
		async update(patch: any) {
			this.updates.push(patch)
			Object.assign(this, patch)
		},
		async finalize(status: CardStatus) {
			this.finalStatuses.push(status)
			this.status = status
		},
		async appendBody() { },
		async waitForInteraction() { return { action: "", response: "" } },
	}
}

function createEnvironment(options: {
	subagent?: boolean
	result?: any
	outlineResult?: any
	implementationResult?: any
	occurrenceResult?: any
} = {}) {
	let mistakeCount = 3
	const cards: any[] = []
	const telemetry: any[] = []
	const taskContext = new Map<string, unknown>()
	const outlineResult = options.outlineResult ?? options.result ?? {
		files: [{
			path: "src/a.ts",
			absolutePath: "/repo/src/a.ts",
			status: "success",
			definitions: [],
			lines: [],
		}],
	}
	const env = {
		config: { isSubagentExecution: options.subagent === true },
		context: {
			task: {
				get: async (key: string) => taskContext.get(key),
				getEntries: async (key: string, entryKeys: readonly string[]) => {
					const entries = (taskContext.get(key) ?? {}) as Record<string, unknown>
					return Object.fromEntries(entryKeys.filter((entryKey) => entries[entryKey] !== undefined).map((entryKey) => [entryKey, entries[entryKey]]))
				},
				set: async (key: string, value: unknown) => taskContext.set(key, value),
				update: async <T>(key: string, updater: (value: T | undefined) => T) =>
					taskContext.set(key, updater(taskContext.get(key) as T | undefined)),
				updateEntries: async (key: string, updates: Record<string, unknown>, deletions: readonly string[] = []) => {
					const entries = (taskContext.get(key) ?? {}) as Record<string, unknown>
					Object.assign(entries, updates)
					for (const entryKey of deletions) delete entries[entryKey]
					taskContext.set(key, entries)
				},
			},
		},
		orchestration: {
			getTaskState: () => mistakeCount,
			setTaskState: (_key: string, value: number) => { mistakeCount = value },
		},
		ui: {
			createCard: async (params: any) => {
				const card = makeCard(params)
				cards.push(card)
				return card
			},
			upsertText: async () => { },
		},
		telemetry: { captureCustomMetadata: (metadata: any) => telemetry.push(metadata) },
		sourceAst: {
			outline: async () => outlineResult,
			implementations: async () => options.implementationResult ?? ({ targets: [] }),
			occurrences: async () => options.occurrenceResult ?? ({ targets: [], occurrences: [] }),
			getAnchorFingerprint: () => null,
		},
	} as unknown as IToolEnvironment
	return { env, cards, telemetry, getMistakeCount: () => mistakeCount }
}

describe("InspectAstTool", () => {
	it("advertises a strongly directive read-only schema", () => {
		assert.equal(inspect_ast_spec.name, "inspect_ast")
		assert.match(inspect_ast_spec.description, /Prefer inspect_ast over broad read_file or text search/)
		assert.match(inspect_ast_spec.description, /never modifies files/)
		const operationParameter = inspect_ast_spec.parameters?.find((parameter) => parameter.name === "operation")
		assert.deepEqual(operationParameter?.enum, [
			"outline",
			"implementation",
			"definitions",
			"references",
			"occurrences",
		])
		assert.equal(typeof operationParameter?.instruction, "string")
		const instruction = operationParameter!.instruction as string
		assert.match(instruction, /outline takes source-file paths \(no symbols\)/)
		assert.match(instruction, /implementation takes source-file paths plus symbols/)
		assert.match(instruction, /file or directory scopes plus symbols/)
		assert.match(instruction, /definition locations, reference locations, or both/)
	})

	it("creates exact metadata cards and terminates them", async () => {
		const main = definition()
		const { env, cards, telemetry, getMistakeCount } = createEnvironment({
			result: {
				files: [{
					path: "src/a.ts",
					absolutePath: "/repo/src/a.ts",
					status: "success",
					definitions: [main],
					lines: [{ lineNumber: 1, text: main.declarationText }],
				}],
			},
		})

		const output = await new InspectAstTool().processCall({ operation: "outline", paths: ["src/a.ts"] }, env)
		assert.match(output, /function main/)
		assert.doesNotMatch(output, /RESULT|Status:/)
		assert.equal(cards.length, 1)
		assert.deepEqual(cards[0].rawInput, {
			tool: "inspect_ast",
			operation: "outline",
			path: "src/a.ts",
			includeAnchors: false,
		})
		assert.equal(cards[0].initialHeader, "Inspecting outline of src/a.ts")
		assert.equal(cards[0].updates[0].header, "Inspected src/a.ts")
		assert.deepEqual(cards[0].updates[0].locations, [{ path: "src/a.ts", line: 1 }])
		assert.deepEqual(cards[0].finalStatuses, [CardStatus.SUCCESS])
		assert.equal(telemetry[0].operation, "outline")
		assert.equal(telemetry[0].resultGroupCount, 1)
		assert.equal(getMistakeCount(), 0)
	})

	it("reduces Cartesian implementation results to one block and card per symbol", async () => {
		const run = definition("A.run")
		const { env, cards, telemetry } = createEnvironment({
			implementationResult: {
				targets: [{
					path: "src/a.ts",
					absolutePath: "/repo/src/a.ts",
					symbol: "A.run",
					status: "success",
					definition: run,
					contentHash: "hash-a",
					lines: [{ lineNumber: 1, text: "run() {}" }],
				}, {
					path: "src/b.ts",
					absolutePath: "/repo/src/b.ts",
					symbol: "A.run",
					status: "success",
					definition: run,
					contentHash: "hash-b",
					lines: [{ lineNumber: 1, text: "run() {}" }],
				}, {
					path: "src/a.ts",
					symbol: "B.load",
					status: "not_found",
				}, {
					path: "src/b.ts",
					symbol: "B.load",
					status: "not_found",
				}],
			},
		})

		const output = await new InspectAstTool().processCall({
			operation: "implementation",
			paths: ["src/a.ts", "src/b.ts"],
			symbols: ["A.run", "B.load"],
		}, env)

		assert.equal(
			output,
			"src/a.ts::A.run\nrun() {}\n\n---\n\nsrc/b.ts::A.run\nrun() {}\n\n---\n\nB.load: no implementation found in src/a.ts, src/b.ts",
		)
		assert.equal(cards.length, 2)
		assert.deepEqual(cards[0].rawInput.paths, ["src/a.ts", "src/b.ts"])
		assert.equal(cards[0].rawInput.symbol, "A.run")
		assert.equal(cards[0].initialHeader, "Inspecting implementation of A.run in src/a.ts (+1 more)")
		assert.equal(cards[0].updates[0].header, "Extracted A.run from src/a.ts (+1 more)")
		assert.equal(cards[1].initialHeader, "Inspecting implementation of B.load in src/a.ts (+1 more)")
		assert.equal(cards[1].updates[0].header, "No match for B.load in src/a.ts (+1 more)")
		assert.deepEqual(cards[0].finalStatuses, [CardStatus.SUCCESS])
		assert.deepEqual(cards[1].finalStatuses, [CardStatus.ERROR])
		assert.equal(telemetry[0].backendTargetCount, 4)
		assert.equal(telemetry[0].resultGroupCount, 2)
		assert.equal(telemetry[0].successfulGroupCount, 1)
		assert.equal(telemetry[0].failureGroupCount, 1)
	})

	it("includes concrete relative file paths in every occurrence-operation header", async () => {
		for (const operation of ["definitions", "references", "occurrences"] as const) {
			const { env, cards } = createEnvironment({
				occurrenceResult: {
					targets: [{
						path: "src",
						symbol: "load",
						status: "success",
						occurrences: [{
							absolutePath: "/repo/src/services/UserService.ts",
							displayPath: "src/services/UserService.ts",
							symbol: "load",
							kind: operation === "references" ? "reference" : "definition",
							startLine: 4,
							startColumn: 1,
							endLine: 4,
							endColumn: 5,
						}, {
							absolutePath: "/repo/src/controllers/UserController.ts",
							displayPath: "src/controllers/UserController.ts",
							symbol: "load",
							kind: "reference",
							startLine: 8,
							startColumn: 2,
							endLine: 8,
							endColumn: 6,
						}],
					}],
					occurrences: [],
				},
			})

			await new InspectAstTool().processCall({ operation, paths: ["src"], symbols: ["load"] }, env)

			assert.equal(cards[0].initialHeader, `Finding ${operation} for load in src`)
			assert.equal(
				cards[0].updates[0].header,
				`Found ${operation} for load in src/controllers/UserController.ts (+1 more)`,
			)
		}
	})

	it("middle-truncates long relative paths in card headers", async () => {
		const longPath = `src/${"nested/".repeat(10)}UserService.ts`
		const { env, cards } = createEnvironment({
			outlineResult: {
				files: [{
					path: longPath,
					absolutePath: `/repo/${longPath}`,
					status: "success",
					definitions: [definition()],
					lines: [{ lineNumber: 1, text: "function main() {}" }],
				}],
			},
		})

		await new InspectAstTool().processCall({ operation: "outline", paths: [longPath] }, env)

		const expectedPath = `${longPath.slice(0, 30)}…${longPath.slice(-29)}`
		assert.equal(cards[0].initialHeader, `Inspecting outline of ${expectedPath}`)
		assert.equal(cards[0].updates[0].header, `Inspected ${expectedPath}`)
	})

	it("preserves successful source output when card or telemetry observability fails", async () => {
		const main = definition()
		const { env, cards } = createEnvironment({
			result: {
				files: [{
					path: "src/a.ts",
					absolutePath: "/repo/src/a.ts",
					status: "success",
					definitions: [main],
					lines: [{ lineNumber: 1, text: main.declarationText }],
				}],
			},
		})
		const originalCreateCard = env.ui.createCard
			; (env.ui as any).createCard = async (params: any) => {
				const created = await originalCreateCard(params)
				created.update = async () => { throw new Error("card unavailable") }
				return created
			}
			; (env.telemetry as any).captureCustomMetadata = () => { throw new Error("telemetry unavailable") }

		const output = await new InspectAstTool().processCall({ operation: "outline", paths: ["src/a.ts"] }, env)

		assert.match(output, /function main/)
		assert.match(output, /Observability warning/)
		assert.match(output, /card update failed/)
		assert.match(output, /telemetry failed/)
		assert.deepEqual(cards[0].finalStatuses, [CardStatus.SUCCESS])
	})

	it("continues inspection when card creation is unavailable", async () => {
		const main = definition()
		const { env } = createEnvironment({
			result: {
				files: [{
					path: "src/a.ts",
					absolutePath: "/repo/src/a.ts",
					status: "success",
					definitions: [main],
					lines: [{ lineNumber: 1, text: main.declarationText }],
				}],
			},
		})
			; (env.ui as any).createCard = async () => { throw new Error("cards unavailable") }

		const output = await new InspectAstTool().processCall({ operation: "outline", paths: ["src/a.ts"] }, env)

		assert.match(output, /function main/)
		assert.match(output, /card creation failed/)
	})

	for (const order of [["tasklet", "main", "sibling"], ["main", "tasklet", "sibling"]] as const) {
		it(`isolates implementation-read history in ${order.join(" → ")} order`, async () => {
			const main = definition()
			const target = {
				path: "src/a.ts",
				absolutePath: "/repo/src/a.ts",
				symbol: "main",
				status: "success",
				definition: main,
				contentHash: "original-hash",
				lines: [{ lineNumber: 1, text: "function main() {}", anchor: "Apple" }],
			}
			const implementationResult = { targets: [target] }
			const parent = createEnvironment({ implementationResult }).env
			const environments = {
				main: parent,
				tasklet: createEnvironment({ implementationResult }).env,
				sibling: createEnvironment({ implementationResult }).env,
			}
			const args = { operation: "implementation" as const, paths: ["src/a.ts"], symbols: ["main"] }

			for (const agent of order) {
				const firstRead = await new InspectAstTool().processCall(args, environments[agent])
				assert.match(firstRead, /function main\(\) \{\}/)
				const repeatedRead = await new InspectAstTool().processCall(args, environments[agent])
				assert.match(repeatedRead, /unchanged/)
			}

			target.contentHash = "updated-hash"
			target.lines[0].text = "function main() { return 1 }"
			for (const agent of order) {
				const changedRead = await new InspectAstTool().processCall(args, environments[agent])
				assert.match(changedRead, /return 1/)
				const anchoredRead = await new InspectAstTool().processCall({ ...args, include_anchors: true }, environments[agent])
				assert.match(anchoredRead, /Apple§function main\(\) \{ return 1 \}/)
			}
		})
	}

	it("does not create interactive cards during subagent execution", async () => {
		const { env, cards } = createEnvironment({ subagent: true })
		await new InspectAstTool().processCall({ operation: "outline", paths: "src/a.ts" }, env)
		assert.equal(cards.length, 0)
	})

	it("returns valid empty inspections without an execution-error wrapper", async () => {
		const { env } = createEnvironment({ implementationResult: { targets: [] } })
		const output = await new InspectAstTool().processCall({
			operation: "implementation",
			paths: ["src/a.ts"],
			symbols: ["missing"],
		}, env)

		assert.equal(output, "src/a.ts: The source-AST backend returned no result for this path and symbol.")
		assert.doesNotMatch(output, /tool execution failed|<error>/)
	})


	it("preserves implementation output when the optional cache cannot load", async () => {
		const run = definition("A.run")
		const { env } = createEnvironment({
			implementationResult: {
				targets: [{
					path: "src/a.ts",
					absolutePath: "/repo/src/a.ts",
					symbol: "A.run",
					status: "success",
					definition: run,
					contentHash: "hash-a",
					lines: [{ lineNumber: 1, text: "run() {}" }],
				}],
			},
		})
			; (env.context.task as any).getEntries = async () => { throw new Error("cache unavailable") }

		const output = await new InspectAstTool().processCall({
			operation: "implementation",
			paths: ["src/a.ts"],
			symbols: ["A.run"],
		}, env)

		assert.match(output, /run\(\) \{\}/)
		assert.match(output, /implementation cache load failed: cache unavailable/)
	})

	it("preserves implementation output when the optional cache cannot save", async () => {
		const run = definition("A.run")
		const { env } = createEnvironment({
			implementationResult: {
				targets: [{
					path: "src/a.ts",
					absolutePath: "/repo/src/a.ts",
					symbol: "A.run",
					status: "success",
					definition: run,
					contentHash: "hash-a",
					lines: [{ lineNumber: 1, text: "run() {}" }],
				}],
			},
		})
			; (env.sourceAst as any).getAnchorFingerprint = () => "fingerprint"
			; (env.context.task as any).updateEntries = async () => { throw new Error("cache readonly") }

		const output = await new InspectAstTool().processCall({
			operation: "implementation",
			paths: ["src/a.ts"],
			symbols: ["A.run"],
			include_anchors: true,
		}, env)

		assert.match(output, /run\(\) \{\}/)
		assert.match(output, /implementation cache save failed: cache readonly/)
	})
	it("increments mistakes only for malformed calls", async () => {
		const { env, getMistakeCount } = createEnvironment()
		const result = await new InspectAstTool().processCall({ operation: "implementation", paths: ["src/a.ts"] }, env)
		assert.match(result, /tool execution failed/)
		assert.equal(getMistakeCount(), 4)
	})
})
