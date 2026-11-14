import { PassThrough, Writable } from "node:stream"
import { render, Text, useInput } from "ink"
import React, { useEffect } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { App } from "./App"

const views = vi.hoisted(() => ({ ready: vi.fn(), resizeKey: 0 }))

vi.mock("./AuthView", () => ({
	AuthView: ({ onNavigateToWelcome }: { onNavigateToWelcome: () => void }) => {
		useInput((input) => {
			if (input === "w") onNavigateToWelcome()
		})
		useEffect(() => views.ready("auth"), [])
		return <Text>AuthView</Text>
	},
}))

vi.mock("./ChatView", () => ({
	ChatView: () => {
		useInput(() => {})
		useEffect(() => views.ready("welcome"), [])
		return <Text>ChatView</Text>
	},
}))

vi.mock("./HistoryView", () => ({ HistoryView: () => null }))
vi.mock("./ConfigView", () => ({ ConfigView: () => null }))
vi.mock("./ErrorBoundary", () => ({ ErrorBoundary: ({ children }: React.PropsWithChildren) => children }))
vi.mock("../context/TaskContext", () => ({ TaskContextProvider: ({ children }: React.PropsWithChildren) => children }))
vi.mock("../hooks/useTerminalSize", () => ({
	useTerminalSize: () => ({ columns: 80, rows: 24, resizeKey: views.resizeKey }),
}))

class TerminalInput extends PassThrough {
	isTTY = true
	isRaw = false
	readonly rawModeChanges: boolean[] = []

	setRawMode(enabled: boolean) {
		this.isRaw = enabled
		this.rawModeChanges.push(enabled)
		return this
	}

	ref() {
		return this
	}

	unref() {
		return this
	}
}

class TerminalOutput extends Writable {
	isTTY = true
	columns = 80
	rows = 24
	output = ""

	constructor(private readonly onWrite?: (text: string) => void) {
		super()
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
		this.output += chunk.toString()
		this.onWrite?.(chunk.toString())
		callback()
	}
}

const originalPlatform = process.platform

afterEach(() => {
	Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform })
	views.ready.mockClear()
	views.resizeKey = 0
	vi.unstubAllEnvs()
})

describe("App startup raw-mode ownership", () => {
	it.each([
		{ queries: "time out", respond: false },
		{ queries: "receive terminal responses", respond: true },
	])("never releases Windows stdin before UI readiness when probes $queries", async ({ respond }) => {
		// Only select the Windows keeper branch; Ink and ink-picture remain real.
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" })
		for (const name of ["TERM_PROGRAM", "TERM_PROGRAM_VERSION", "KONSOLE_VERSION"]) vi.stubEnv(name, undefined)

		const stdin = new TerminalInput()
		const responses = new Map([
			["\x1b[16t", "\x1b[6;16;8t"],
			["\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\ \x1b[c", "\x1b_Gi=31;OK\x1b\\"],
			["\x1b[c", "\x1b[?1;2c"],
		])
		const stdout = new TerminalOutput((query) => {
			const response = responses.get(query)
			if (respond && response) queueMicrotask(() => stdin.write(response))
		})
		const stderr = new TerminalOutput()
		const app = render(<App controller={{}} view="auth" />, {
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: stderr as unknown as NodeJS.WriteStream,
			patchConsole: false,
			exitOnCtrlC: false,
		})

		try {
			await vi.waitFor(() => expect(views.ready).toHaveBeenCalledWith("auth"), { timeout: 2000, interval: 10 })
			expect(stdout.output).toContain("\x1b[16t")
			if (respond) expect(stdout.output).not.toContain("\x1b[14t")
			else expect(stdout.output).toContain("\x1b[14t")
			expect(stdout.output).toContain("\x1b_Gi=31")
			expect(stdout.output).toContain("\x1b[c")
			expect(stdin.isRaw).toBe(true)
			const startupRawModeChanges = [...stdin.rawModeChanges]

			stdin.write("w")
			await vi.waitFor(() => expect(views.ready).toHaveBeenCalledWith("welcome"))
			expect(stdin.rawModeChanges).toEqual(startupRawModeChanges)

			// Exercise App's keyed resize remount, not the resize debounce hook.
			views.resizeKey++
			app.rerender(<App controller={{}} view="auth" />)
			await vi.waitFor(() => expect(views.ready.mock.calls.filter(([view]) => view === "welcome")).toHaveLength(2))
			expect(stdin.rawModeChanges).toEqual(startupRawModeChanges)

			app.unmount()
			expect(stdin.isRaw).toBe(false)
			expect(stdin.rawModeChanges).toEqual([...startupRawModeChanges, false])

			// Query-local releases must not reach the stream before the session keeper mounts.
			expect(startupRawModeChanges, `startup setRawMode calls: ${JSON.stringify(startupRawModeChanges)}`).not.toContain(false)
		} finally {
			app.unmount()
			app.cleanup()
			stdin.destroy()
			stdout.destroy()
			stderr.destroy()
		}
	})
})
