/**
 * Mocha root hook that guards against unexpected Logger.error() calls.
 *
 * HOW IT WORKS:
 *   - Intercepts process.stderr.write() in each beforeEach to capture ERROR-prefixed messages
 *   - Re-intercepts every beforeEach because Logger.test.ts does sandbox.stub(process.stderr, "write")
 *     and sandbox.restore() which would undo a one-time interception
 *   - After each test, if ERROR messages were captured and the test hasn't
 *     opted in via expectLoggerErrors(), the test fails
 *
 * WHY:
 *   Production code often does `try { ... } catch { Logger.error(...) }`.
 *   If a test accidentally triggers one of these catch blocks, the error is
 *   silently swallowed. This guard surfaces those cases.
 */

let errorCollector: string[] = []
let expectErrorsFlag = false
let originalStderrWrite: typeof process.stderr.write

function installInterceptor() {
	originalStderrWrite = process.stderr.write.bind(process.stderr)
	process.stderr.write = (chunk: any, ...args: any[]): boolean => {
		const str = typeof chunk === "string" ? chunk : chunk.toString()
		if (str.startsWith("ERROR")) {
			errorCollector.push(str.trimEnd())
			return true // swallow ERROR lines — prevents noise in test output
		}
		// Swallow all stderr output to keep test output clean.
		// WARN, LOG, DEBUG, etc. from Logger all go through here.
		return true
	}
}

/**
 * Call this at the top of a test that intentionally exercises error paths
 * (i.e., code paths that call Logger.error()).
 *
 * Without this call, any Logger.error() during the test will cause it to fail.
 */
export function expectLoggerErrors() {
	expectErrorsFlag = true
}

/**
 * Mocha root hooks — automatically picked up when this file is exported
 * from a `require`d module. See: https://mochajs.org/#root-hooks
 */
export const mochaHooks: Mocha.RootHookObject = {
	beforeEach() {
		errorCollector = []
		expectErrorsFlag = false
		installInterceptor()
	},
	afterEach() {
		// Restore stderr before checking, so the failure message is visible
		if (originalStderrWrite) {
			process.stderr.write = originalStderrWrite
		}
		if (errorCollector.length > 0 && !expectErrorsFlag) {
			const messages = errorCollector.map((m) => `  - ${m}`).join("\n")
			throw new Error(
				`Unexpected Logger.error() calls captured during this test.\n` +
					`If these errors are expected, call expectLoggerErrors() in your test.\n` +
					`Captured errors:\n${messages}`,
			)
		}
	},
}
