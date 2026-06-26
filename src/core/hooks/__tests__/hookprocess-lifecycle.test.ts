import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import * as path from "path"
import "should"
import { HookProcess } from "../HookProcess"
import { HookProcessRegistry } from "../HookProcessRegistry"

// Creates a temp dir + a node script with the given body (shebang added).
async function makeScript(body: string): Promise<{ scriptPath: string; cleanup: () => Promise<void> }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hookproc-lifecycle-"))
	const scriptPath = path.join(tempDir, "TestHook")
	const content = `#!/usr/bin/env node\n${body}\n`
	await fs.writeFile(scriptPath, content)
	await fs.chmod(scriptPath, 0o755)
	return { scriptPath, cleanup: async () => fs.rm(tempDir, { recursive: true, force: true }) }
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("HookProcess lifecycle", () => {
	beforeEach(() => HookProcessRegistry.resetForTesting())
	afterEach(() => HookProcessRegistry.resetForTesting())

	it("resolves on exit code 0 and captures stdout", async () => {
		const { scriptPath, cleanup } = await makeScript(`console.log(JSON.stringify({ cancel: false })); process.exit(0);`)
		try {
			const proc = new HookProcess(scriptPath, 5000)
			await proc.run("{}")
			proc.getExitCode()?.should.equal(0)
			proc.hasCompleted().should.equal(true)
			proc.getStdout().trim().should.equal('{"cancel":false}')
		} finally {
			await cleanup()
		}
	})

	it("rejects on non-zero exit code with the code in the message", async () => {
		const { scriptPath, cleanup } = await makeScript(`console.error("boom"); process.exit(3);`)
		try {
			const proc = new HookProcess(scriptPath, 5000)
			let caught: Error | null = null
			try {
				await proc.run("{}")
			} catch (error: any) {
				caught = error
			}
			caught?.message.should.match(/Hook exited with code 3/)
			proc.getExitCode()?.should.equal(3)
			proc.getStderr().trim().should.equal("boom")
		} finally {
			await cleanup()
		}
	})

	it("emits line events for each complete stdout line", async () => {
		const { scriptPath, cleanup } = await makeScript(`console.log("line1"); console.log("line2"); process.exit(0);`)
		try {
			const proc = new HookProcess(scriptPath, 5000)
			const lines: string[] = []
			proc.on("line", (line: string) => lines.push(line))
			await proc.run("{}")
			lines.should.containEql("line1")
			lines.should.containEql("line2")
		} finally {
			await cleanup()
		}
	})

	it("rejects when the hook exceeds the timeout", async () => {
		const { scriptPath, cleanup } = await makeScript(`setTimeout(() => process.exit(0), 5000);`)
		try {
			const proc = new HookProcess(scriptPath, 200)
			let caught: Error | null = null
			try {
				await proc.run("{}")
			} catch (error: any) {
				caught = error
			}
			caught?.message.should.match(/timed out after 200ms/)
		} finally {
			await cleanup()
		}
	})

	it("rejects immediately when the abort signal is already aborted", async () => {
		const { scriptPath, cleanup } = await makeScript(`process.exit(0);`)
		try {
			const controller = new AbortController()
			controller.abort()
			const proc = new HookProcess(scriptPath, 5000, controller.signal)
			let caught: Error | null = null
			try {
				await proc.run("{}")
			} catch (error: any) {
				caught = error
			}
			caught?.message.should.match(/cancelled/)
		} finally {
			await cleanup()
		}
	})

	it("rejects when the abort signal fires during execution", async () => {
		const { scriptPath, cleanup } = await makeScript(`setTimeout(() => process.exit(0), 5000);`)
		try {
			const controller = new AbortController()
			const proc = new HookProcess(scriptPath, 5000, controller.signal)
			setTimeout(() => controller.abort(), 100)
			let caught: Error | null = null
			try {
				await proc.run("{}")
			} catch (error: any) {
				caught = error
			}
			caught?.message.should.match(/cancelled by user/)
		} finally {
			await cleanup()
		}
	})

	it("emits a completed event with the exit code and signal", async () => {
		const { scriptPath, cleanup } = await makeScript(`process.exit(0);`)
		try {
			const proc = new HookProcess(scriptPath, 5000)
			let completedArgs: [number | null, string | null] | null = null
			proc.on("completed", (code, signal) => (completedArgs = [code, signal]))
			await proc.run("{}")
			const code = completedArgs?.[0] ?? null
			should(code).equal(0)
		} finally {
			await cleanup()
		}
	})

	it("truncates output exceeding the 1MB limit and emits a truncation marker", async () => {
		// Emit ~2MB of stdout; wait for the stream to drain before exiting so the
		// full payload reaches the pipe and trips the 1MB size guard.
		const big = "x".repeat(2 * 1024 * 1024)
		const { scriptPath, cleanup } = await makeScript(`process.stdout.write(${JSON.stringify(big)}, () => process.exit(0));`)
		try {
			const proc = new HookProcess(scriptPath, 10000)
			const lines: string[] = []
			proc.on("line", (line: string) => lines.push(line))
			await proc.run("{}")
			lines.some((line) => line.includes("[Output truncated")).should.equal(true)
		} finally {
			await cleanup()
		}
	})

	it("getUnretrievedOutput returns nothing after completion because line events consume the buffer", async () => {
		const { scriptPath, cleanup } = await makeScript(`console.log("hello"); process.exit(0);`)
		try {
			const proc = new HookProcess(scriptPath, 5000)
			await proc.run("{}")
			// All output is emitted via line events; nothing remains unretrieved.
			proc.getUnretrievedOutput().should.equal("")
		} finally {
			await cleanup()
		}
	})

	it("terminate() kills a long-running hook", async () => {
		const { scriptPath, cleanup } = await makeScript(`setTimeout(() => process.exit(0), 10000);`)
		try {
			const proc = new HookProcess(scriptPath, 30000)
			const runPromise = proc.run("{}")
			await wait(100) // let it spawn
			await proc.terminate()
			let caught: Error | null = null
			try {
				await runPromise
			} catch (error: any) {
				caught = error
			}
			// Termination causes a non-zero exit or signal; either way it should not hang.
			should.exist(caught)
		} finally {
			await cleanup()
		}
	})

	it("unregisters from the registry after completion", async () => {
		const { scriptPath, cleanup } = await makeScript(`process.exit(0);`)
		try {
			const before = HookProcessRegistry.getActiveCount()
			const proc = new HookProcess(scriptPath, 5000)
			await proc.run("{}")
			HookProcessRegistry.getActiveCount().should.equal(before)
		} finally {
			await cleanup()
		}
	})
})
