import { disposeCliContext, drainOutput } from "./cleanup"
import { shutdownEvent } from "./shutdown"
import { activeContext, isShuttingDown, setIsShuttingDown, setShutdownExitCode } from "./state"

export async function captureUnhandledException(reason: Error, context: string) {
	try {
		const { ErrorService } = await import("@/services/error/ErrorService")
		// ErrorService may not be initialized yet (e.g., error occurred before initializeCli())
		// so we guard with a try/get pattern rather than letting ErrorService.get() throw
		let errorService: any = null
		try {
			errorService = ErrorService.get()
		} catch {
			// ErrorService not yet initialized; skip capture
		}
		if (errorService) {
			await errorService.captureException(reason, { context })
			// dispose flushes any pending error captures to ensure they're sent before the process exits
			return errorService.dispose()
		}
	} catch {
		// Ignore errors during shutdown to avoid an infinite loop
		try {
			const { Logger } = await import("@/shared/services/Logger")
			Logger.info("Error capturing unhandled exception. Proceeding with shutdown.")
		} catch {
			// Even Logger failed
		}
	}
}

const EXIT_TIMEOUT_MS = 3000
export async function onUnhandledException(reason: unknown, context: string) {
	const { Logger } = await import("@/shared/services/Logger")
	const { restoreConsole } = await import("./console")
	Logger.error("Unhandled exception:", reason)
	const finalError = reason instanceof Error ? reason : new Error(String(reason))

	restoreConsole()
	console.error(finalError)

	const forcedExit = setTimeout(() => process.exit(1), EXIT_TIMEOUT_MS)
	try {
		await captureUnhandledException(finalError, context)
		const { disposeCliLogging } = await import("../init")
		await disposeCliLogging()
		const { disposeAcpFileLogger } = await import("./acp-file-logger")
		await disposeAcpFileLogger()
	} catch (error) {
		console.error("Failed to flush CLI diagnostics during shutdown:", error)
	} finally {
		clearTimeout(forcedExit)
		process.exit(1)
	}
}

export function setupSignalHandlers(): () => void {
	const shutdown = async (signal: NodeJS.Signals, exitCode: number) => {
		const { printWarning } = await import("./display")
		if (isShuttingDown) {
			process.exit(exitCode)
		}
		setIsShuttingDown(true)
		setShutdownExitCode(exitCode)

		shutdownEvent.fire()
		printWarning(`${signal} received, shutting down...`)

		try {
			if (activeContext) {
				const task = activeContext.controller.task
				if (task) await task.abortTask()
				await disposeCliContext(activeContext)
			} else {
				// Best-effort flush of restored yolo state when no active context
				try {
					const { StateManager } = await import("@/core/storage/StateManager")
					await StateManager.get().flushPendingState()
				} catch {
					// StateManager may not be initialized yet
				}
				try {
					const { ErrorService } = await import("@/services/error/ErrorService")
					await ErrorService.get().dispose()
				} catch {
					// ErrorService may not be initialized yet
				}
				await disposeCliContext(null) // This will call disposeTelemetryServices
			}
		} catch (error) {
			printWarning(`Shutdown cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
			setShutdownExitCode(1)
			exitCode = 1
		}

		await drainOutput()
		process.exit(exitCode)
	}

	const onSigint = () => void shutdown("SIGINT", 130)
	const onSigterm = () => void shutdown("SIGTERM", 143)
	process.on("SIGINT", onSigint)
	process.on("SIGTERM", onSigterm)

	process.on("unhandledRejection", async (reason: unknown) => {
		await onUnhandledException(reason, "unhandledRejection")
	})

	process.on("uncaughtException", (reason: unknown) => {
		onUnhandledException(reason, "uncaughtException")
	})

	return () => {
		process.off("SIGINT", onSigint)
		process.off("SIGTERM", onSigterm)
	}
}
