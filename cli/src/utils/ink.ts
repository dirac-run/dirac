/**
 * Run an Ink app with proper cleanup handling
 */
export async function runInkApp(element: any, cleanup: () => Promise<void>): Promise<void> {
	const { render } = await import("ink")
	const { restoreConsole } = await import("./console")

	// Clear terminal for clean UI - robot will render at row 1
	process.stdout.write("\x1b[2J\x1b[H")
	const shouldPrimeRawMode =
		process.platform === "win32" && process.stdin.isTTY && typeof process.stdin.setRawMode === "function"
	const wasRaw = process.stdin.isRaw === true
	const wasPaused = process.stdin.isPaused()

	if (shouldPrimeRawMode) {
		try {
			process.stdin.setRawMode(true)
			process.stdin.resume()
		} catch {
			// Ink will still attempt to initialize raw mode.
		}
	}

	// Note: incrementalRendering is enabled to reduce terminal bandwidth and improve responsiveness.
	// We previously disabled this due to resize glitches, but our useTerminalSize hook now
	// handles this by clearing the screen and forcing a full React remount on resize,
	// which resets Ink's internal line tracking.
	const { waitUntilExit, unmount } = render(element, {
		exitOnCtrlC: true,
		patchConsole: false,
		// @ts-expect-error: synchronizedUpdateMode is supported by @jrichman/ink but not in the type definitions
		synchronizedUpdateMode: true,
		incrementalRendering: true,
	})

	try {
		await waitUntilExit()
	} finally {
		try {
			unmount()
		} catch {
			// Already unmounted
		}
		if (shouldPrimeRawMode) {
			try {
				process.stdin.setRawMode(wasRaw)
				if (wasPaused) {
					process.stdin.pause()
				}
			} catch {
				// Ignore cleanup failures on nonstandard terminals.
			}
		}
		restoreConsole()
		await cleanup()
	}
}
