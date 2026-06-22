import { isDev } from "@shared/config/environment"
/**
 * Simple Logger utility for the extension's backend code.
 */
export class Logger {
    private static isVerbose = isDev()

    private static subscribers: Set<(msg: string) => void> = new Set()

    private static output(msg: string): void {
        if (Logger.subscribers.size === 0) {
            process.stderr.write(msg + "\n")
            return
        }
        for (const subscriber of Logger.subscribers) {
            try {
                subscriber(msg)
            } catch {
                // ignore errors from subscribers
            }
        }
    }

    /**
     * Register a callback to receive log output messages.
     */
    static subscribe(outputFn: (msg: string) => void) {
        Logger.subscribers.add(outputFn)
    }

    static error(message: string, ...args: any[]) {
        Logger.#output("ERROR", message, undefined, args)
    }

    static warn(message: string, ...args: any[]) {
        Logger.#output("WARN", message, undefined, args)
    }

    static log(message: string, ...args: any[]) {
        Logger.#output("LOG", message, undefined, args)
    }

    static debug(message: string, ...args: any[]) {
        Logger.#output("DEBUG", message, undefined, args)
    }

    static info(message: string, ...args: any[]) {
        Logger.#output("INFO", message, undefined, args)
    }

    static trace(message: string, ...args: any[]) {
        Logger.#output("TRACE", message, undefined, args)
    }

    static #output(level: string, message: string, error: Error | undefined, args: any[]) {
        try {
            let fullMessage = message
            if (args.length > 0) {
                fullMessage += ` ${args
                    .map((arg) => {
                        if (arg instanceof Error) {
                            return `${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`
                        }
                        try {
                            return typeof arg === "object" ? JSON.stringify(arg) : String(arg)
                        } catch {
                            return String(arg)
                        }
                    })
                    .join(" ")}`
            }
            const errorSuffix = error?.message ? ` ${error.message}${error.stack ? `\n${error.stack}` : ""}` : ""
            Logger.output(`${level} ${fullMessage}${errorSuffix}`.trimEnd())
        } catch { }
    }
}
