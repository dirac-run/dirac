import * as os from "node:os"
import * as path from "node:path"

function resolveUserPath(value: string): string {
	if (value === "~") return os.homedir()
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.resolve(os.homedir(), value.slice(2))
	return path.resolve(value)
}

/** Resolve the subscription cache shared by the official Qwen Code client and Dirac. */
export function getQwenCachedCredentialPath(customPath?: string): string {
	if (customPath) return resolveUserPath(customPath)
	const home = process.env.QWEN_HOME ? resolveUserPath(process.env.QWEN_HOME) : path.join(os.homedir(), ".qwen")
	return path.join(home, "subscription_credentials.json")
}
