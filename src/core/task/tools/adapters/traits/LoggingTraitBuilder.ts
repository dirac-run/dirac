import type { ILoggingTrait } from "../../interfaces/IToolEnvironment"
import { Logger } from "@/shared/services/Logger"

// Builds the logging trait — delegates all log levels to the static Logger.
export function buildLoggingTrait(): ILoggingTrait {
	return {
		error: (message: string, ...args: any[]) => Logger.error(message, ...args),
		warn: (message: string, ...args: any[]) => Logger.warn(message, ...args),
		info: (message: string, ...args: any[]) => Logger.info(message, ...args),
		debug: (message: string, ...args: any[]) => Logger.debug(message, ...args),
		log: (message: string, ...args: any[]) => Logger.log(message, ...args),
		trace: (message: string, ...args: any[]) => Logger.trace(message, ...args),
	}
}
