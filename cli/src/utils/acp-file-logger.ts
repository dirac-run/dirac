import pino, { type Logger as PinoLogger } from "pino"
import { Logger } from "@/shared/services/Logger"
import { DIRAC_CLI_DIR } from "./path"

let acpFileLogger: PinoLogger | undefined

/**
 * Subscribe the shared logger to ACP's dedicated rolling log file.
 *
 * ACP reserves stdout for JSON-RPC, so this sink must never write to either
 * protocol stream. Pino creates the dedicated file when ACP first starts.
 */
export function initAcpFileLogger(): void {
	if (acpFileLogger) {
		return
	}

	const transport = pino.destination({ dest: DIRAC_CLI_DIR.acpLog, mkdir: true })
	acpFileLogger = pino({ timestamp: pino.stdTimeFunctions.isoTime }, transport)
	Logger.subscribe((message) => acpFileLogger?.info(message))
}
