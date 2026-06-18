import { expect } from "chai"
import path from "path"
import proxyquire from "proxyquire"
import sinon from "sinon"

const createMockProcess = () => {
	const mockProcess = {
		stdin: {
			write: sinon.fake(),
			end: sinon.fake(),
		},
		stdout: {
			on: sinon.fake(),
			resume: sinon.fake(),
		},
		stderr: {
			on: sinon.fake(() => {}),
		},
		on: sinon.fake((event, callback) => {
			if (event === "close") {
				setImmediate(() => callback(0))
			}
			if (event === "error") {
			}
		}),
		killed: false,
		kill: sinon.fake(),
		exitCode: 0,
		then: (onResolve: (value: any) => void) => {
			setImmediate(() => onResolve({ exitCode: 0 }))
			return Promise.resolve({ exitCode: 0 })
		},
		catch: () => Promise.resolve({ exitCode: 0 }),
		finally: (callback: () => void) => {
			setImmediate(callback)
			return Promise.resolve({ exitCode: 0 })
		},
	}
	return mockProcess
}

const createMockReadlineInterface = () => {
	const mockInterface = {
		async *[Symbol.asyncIterator]() {
			// Simulate Claude CLI JSON output - yield a few chunks then end
			yield '{"type":"text","text":"Hello"}'
			yield '{"type":"text","text":" world"}'
			// Iterator ends naturally when function returns
			return
		},
		close: sinon.fake(),
	}
	return mockInterface
}

const mockExeca = sinon.fake((..._args) => {
	return createMockProcess()
})

let os = "darwin"

const { MAX_SYSTEM_PROMPT_LENGTH, runClaudeCode } = proxyquire("./run", {
	"@/utils/path": {
		getCwd: () => Promise.resolve(path.resolve("./")),
	},
	"node:os": {
		platform: () => os,
	},
	execa: {
		execa: mockExeca,
	},
	readline: {
		createInterface: createMockReadlineInterface,
	},
})

describe("Claude Code Integration", () => {
	const scriptPath = "echo"

	afterEach(() => {
		sinon.restore()
	})

	it("isolates the run from the user's ambient Claude Code environment", async () => {
		const cProcess = runClaudeCode({
			systemPrompt: "a",
			messages: [],
			modelId: "test",
			path: scriptPath,
		})

		for await (const _chunk of cProcess) {
			// drain the generator so runProcess (and execa) is invoked
		}

		const params = mockExeca.lastCall.args[1]
		expect(params).to.include("--strict-mcp-config")
		expect(params).to.include("--disable-slash-commands")
		expect(params).to.include("--no-session-persistence")
	})

	const itCallsTheScriptWithAFile = (systemPrompt: string) => {
		it("calls the script using with a file", async () => {
			const cProcess = runClaudeCode({
				systemPrompt,
				messages: [],
				modelId: "test",
				path: scriptPath,
			})

			const chunks: string[] = []
			for await (const chunk of cProcess) {
				chunks.push(chunk)
			}

			expect(chunks).to.have.length(2)

			const lastExecaCall = mockExeca.lastCall
			const params = lastExecaCall.args[1]
			expect(params).to.not.be.null
			expect(params.includes("--system-prompt-file")).to.be.true
			expect(params.includes("--system-prompt")).to.be.false
		})
	}

	describe("when it's running on Windows", () => {
		beforeEach(() => {
			os = "win32"
		})

		describe("when the system prompt is longer than the MAX_SYSTEM_PROMPT_LENGTH", () => {
			const SYSTEM_PROMPT = "a".repeat(MAX_SYSTEM_PROMPT_LENGTH * 1.2)

			itCallsTheScriptWithAFile(SYSTEM_PROMPT)
		})

		describe("when the system prompt is shorter than the MAX_SYSTEM_PROMPT_LENGTH", () => {
			const SYSTEM_PROMPT = "a".repeat(MAX_SYSTEM_PROMPT_LENGTH / 2)

			itCallsTheScriptWithAFile(SYSTEM_PROMPT)
		})
	})

	describe("when it's not running on Windows", () => {
		beforeEach(() => {
			os = "darwin"
		})

		describe("when the system prompt is longer than the MAX_SYSTEM_PROMPT_LENGTH", () => {
			const SYSTEM_PROMPT = "a".repeat(MAX_SYSTEM_PROMPT_LENGTH * 1.2)

			itCallsTheScriptWithAFile(SYSTEM_PROMPT)
		})

		describe("when the system prompt is shorter than the MAX_SYSTEM_PROMPT_LENGTH", () => {
			const SYSTEM_PROMPT = "a".repeat(MAX_SYSTEM_PROMPT_LENGTH / 2)

			it("calls the script without a file", async () => {
				const cProcess = runClaudeCode({
					systemPrompt: SYSTEM_PROMPT,
					messages: [],
					modelId: "test",
					path: scriptPath,
				})

				const chunks: string[] = []
				for await (const chunk of cProcess) {
					chunks.push(chunk)
				}

				expect(chunks).to.have.length(2)

				const lastExecaCall = mockExeca.lastCall
				const params = lastExecaCall.args[1]
				expect(params).to.not.be.null
				expect(params.includes("--system-prompt-file")).to.be.false
				expect(params.includes("--system-prompt")).to.be.true
			})
		})
	})
})

describe("Claude Code Integration - one-turn cap", () => {
	// The run is capped at one turn, so the CLI streams the StructuredOutput tool call, emits an
	// error_max_turns result, and exits non-zero. runClaudeCode must treat that as completion.
	const RESULT_LINE = '{"type":"result","subtype":"error_max_turns","is_error":true,"total_cost_usd":0.01}'
	const ASSISTANT_LINE =
		'{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"StructuredOutput","input":{"tool_calls":[{"tool":"read_file","params":{"path":"p"}}]}}],"usage":{"input_tokens":1,"output_tokens":1},"stop_reason":"tool_use"}}'

	const maxTurnsProcess = () => ({
		stdin: { write: sinon.fake(), end: sinon.fake() },
		stdout: { on: sinon.fake(), resume: sinon.fake() },
		stderr: { on: sinon.fake(() => {}) },
		on: sinon.fake((event: string, callback: (code: number) => void) => {
			if (event === "close") {
				setImmediate(() => callback(1))
			}
		}),
		killed: false,
		kill: sinon.fake(),
		exitCode: 1,
		// execa rejects on a non-zero exit; the `await cProcess` in runClaudeCode must therefore throw.
		then: (_onResolve: (value: any) => void, onReject: (reason: any) => void) => {
			setImmediate(() => onReject(new Error("Command failed with exit code 1")))
			return Promise.resolve()
		},
		catch: () => Promise.resolve(),
		finally: (callback: () => void) => {
			setImmediate(callback)
			return Promise.resolve()
		},
	})

	const maxTurnsReadline = () => ({
		async *[Symbol.asyncIterator]() {
			yield ASSISTANT_LINE
			yield RESULT_LINE
			return
		},
		close: sinon.fake(),
	})

	const { runClaudeCode: runWithMaxTurns } = proxyquire("./run", {
		"@/utils/path": { getCwd: () => Promise.resolve(path.resolve("./")) },
		"node:os": { platform: () => "darwin" },
		execa: { execa: sinon.fake(() => maxTurnsProcess()) },
		readline: { createInterface: maxTurnsReadline },
	})

	afterEach(() => {
		sinon.restore()
	})

	it("completes without throwing and still yields the result chunk", async () => {
		const cProcess = runWithMaxTurns({
			systemPrompt: "sys",
			messages: [],
			modelId: "test",
			path: "echo",
			jsonSchema: "{}",
		})

		const chunks: any[] = []
		for await (const chunk of cProcess) {
			chunks.push(chunk)
		}

		expect(chunks).to.have.length(2)
		expect(chunks[1].type).to.equal("result")
		expect(chunks[1].subtype).to.equal("error_max_turns")
		expect(chunks[1].total_cost_usd).to.equal(0.01)
	})
})
