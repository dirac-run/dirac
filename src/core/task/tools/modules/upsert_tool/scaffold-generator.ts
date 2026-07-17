import * as fs from "fs/promises"
import * as path from "path"
import { TOOL_IMPLEMENTATION_SENTINEL } from "./constants"

export function buildScaffoldedToolSource(
	name: string,
	description: string,
	parameters: any[],
): string {
	const paramsArray = Array.isArray(parameters)
		? parameters
			.map((p: any) => {
				const pName = p.name || "param"
				const pType = p.type || "string"
				const pRequired = p.required !== false
				const pInstruction = p.instruction || ""
				return `        { name: ${JSON.stringify(pName)}, type: ${JSON.stringify(pType)}, required: ${pRequired}, instruction: ${JSON.stringify(pInstruction)} },`
			})
			.join("\n")
		: ""

	return [
		`export const spec = {`,
		`    id: ${JSON.stringify(name)},`,
		`    name: ${JSON.stringify(name)},`,
		`    description: ${JSON.stringify(description)},`,
		`    parameters: [`,
		paramsArray,
		`    ],`,
		`}`,
		``,
		`export function create() {`,
		`    return {`,
		`        spec() { return spec },`,
		`        supportedSurfaces() { return ["all"] },`,
		`        async processCall(args: any, env: any): Promise<string> {`,
		`            throw new Error(${JSON.stringify(TOOL_IMPLEMENTATION_SENTINEL)})`,
		`        },`,
		`    }`,
		`}`,
	].join("\n")
}

/**
 * Writes a self-contained smoke-test harness to the staging directory.
 * The harness mirrors the public IToolEnvironment shapes without importing
 * Dirac internals, so user tools remain portable after promotion.
 */
export async function writeTestHarness(toolDir: string): Promise<void> {
	const harness = `
import { create } from "./tool.ts"
import * as fs from "fs/promises"
import * as nodePath from "path"
import { fileURLToPath } from "url"
import { execSync } from "child_process"

const noOp = async () => {}
const noOpObj = async () => ({})
const harnessDir = nodePath.dirname(fileURLToPath(import.meta.url))

const env = {
  workspace: {
    readFile: async (p: string) => fs.readFile(p, "utf8"),
    writeFile: async (p: string, c: string) => fs.writeFile(p, c, "utf8"),
    listFiles: async (p: string, _r: boolean, l: number) => {
      const entries = await fs.readdir(p, { withFileTypes: true })
      return [entries.slice(0, l).map(e => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), filepath: nodePath.join(p, e.name) })), entries.length > l]
    },
    resolvePath: async (p: string) => ({ absolutePath: nodePath.resolve(p), displayPath: p }),
    getFileInfo: async (p: string) => { try { const s = await fs.stat(p); return { size: s.size, isFile: s.isFile(), exists: true } } catch { return { size: 0, isFile: false, exists: false } } },
    readRichFile: async (p: string) => ({ text: await fs.readFile(p, "utf8") }),
    saveOpenDocumentIfDirty: noOp,
  },
  system: {
    executeCommand: async (cmd: string) => {
      try {
        const output = execSync(cmd, { encoding: "utf8", timeout: 30000 })
        return { userRejected: false, output, completed: true, exitCode: 0, signal: null }
      } catch (e: any) {
        return {
          userRejected: false,
          output: e.stderr || e.stdout || e.message,
          completed: true,
          exitCode: typeof e.status === "number" ? e.status : 1,
          signal: e.signal || null,
        }
      }
    },
    searchFiles: async () => "",
    getSystemInfo: async () => ({ operatingSystem: "test", diracVersion: "test", hostInfo: "test", systemInfo: "test", providerAndModel: "test/test" }),
    openUrl: noOp,
  },
  ui: {
    createCard: async () => ({ update: noOp, finalize: noOp, appendBody: noOp, waitForInteraction: noOpObj }),
    upsertText: noOp,
    streamText: async () => ({ write: noOp, end: noOp }),
  },
  config: { cwd: process.cwd(), isSubagentExecution: true },
  interaction: { askPermission: async () => ({ approved: true, action: "approve" }) },
  orchestration: {
    runSubagent: async () => ({ status: "completed", result: "", stats: {} }),
    runHook: async () => ({}), switchToActMode: async () => true,
    saveCheckpoint: noOp, getHistory: () => [], setTruncationRange: () => {},
    getNextTruncationRange: () => [0, 0] as [number, number],
    updateMessage: noOp, getTaskState: () => undefined, setTaskState: () => {},
    doesLatestTaskCompletionHaveNewChanges: async () => false, resetTransientState: noOp,
  },
  editor: {
    open: noOp, showReview: noOp, hideReview: noOp, update: noOp,
    saveChanges: async () => ({ allSuccess: true }),
    applyAndSaveSilently: async () => ({ allSuccess: true }),
    applyAndSaveBatchSilently: async () => new Map(),
    revertChanges: noOp, reset: noOp, scrollToFirstDiff: noOp, undoUserEdits: noOp,
    format: async () => "",
  },
  symbols: {
    getSymbolRange: async () => undefined,
    getDefinitions: async () => [], getReferences: async () => [], getSymbols: async () => [],
    updateIndex: noOp, initializeIndex: noOp,
  },
  ast: { getSkeleton: async () => "", getFunctions: async () => null },
  diagnostics: { prepare: noOp, getRaw: async () => [] },
  telemetry: { captureCustomMetadata: () => {} },
  logging: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {}, log: () => {}, trace: () => {} },
}

async function main() {
  const tool = create()
  const argsJson = process.argv[2] || await fs.readFile(nodePath.join(harnessDir, "smoke-args.json"), "utf8")
  const args = JSON.parse(argsJson)

  console.log("=== Test 1: Running with provided args")
  const r1 = await tool.processCall(args, env)
  console.log("=== PASS:", typeof r1 === "string" ? r1 : JSON.stringify(r1))

  console.log("\\n=== Test 2: Running with empty args (edge case)")
  const r2 = await tool.processCall({}, env)
  console.log("=== PASS (edge case):", typeof r2 === "string" ? r2 : JSON.stringify(r2))
}

main().catch(e => { console.error("=== FAIL:", e.message); process.exit(1) })
`
	await fs.writeFile(path.join(toolDir, "test-harness.ts"), harness.trim(), "utf8")
}
