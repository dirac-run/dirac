/**
 * File-backed output channel for CLI mode — mirrors the small slice of
 * VS Code's OutputChannel the codebase uses (appendLine/append).
 */

import pino, { type Logger } from "pino"
import { createRotatingFileLogger, type RotatingFileLogger } from "@/shared/services/file-logger"
import { DIRAC_CLI_DIR } from "./path"

export function getCliLogFilePath(): string {
	return DIRAC_CLI_DIR.cliLog
}

interface OutputChannelLogger {
	logger: Logger
	fileLogger: RotatingFileLogger
}

let outputChannelLogger: OutputChannelLogger | undefined

function getOutputChannelLogger(_channelName: string): Logger {
	if (!outputChannelLogger) {
		const fileLogger = createRotatingFileLogger({ logDir: DIRAC_CLI_DIR.log, fileName: "dirac-cli.log" })
		outputChannelLogger = {
			logger: pino({ timestamp: pino.stdTimeFunctions.isoTime }, fileLogger),
			fileLogger,
		}
	}
	return outputChannelLogger.logger
}

const noop = () => {}

export function createCliOutputChannel(name: string) {
	const logger = getOutputChannelLogger(name)
	const log = (text: string) => logger.info({ channel: name }, text)
	return { appendLine: log, append: log, clear: noop, show: noop, hide: noop, dispose: noop }
}

export async function disposeCliOutputLoggers(): Promise<void> {
	const fileLogger = outputChannelLogger?.fileLogger
	outputChannelLogger = undefined
	if (fileLogger) await fileLogger.dispose()
}
