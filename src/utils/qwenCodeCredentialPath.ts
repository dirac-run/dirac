import * as os from "node:os"
import * as path from "node:path"

/** The existing Qwen Code OAuth file, shared by execution and saved-provider publication. */
export function getQwenCachedCredentialPath(customPath?: string): string {
	if (customPath) {
		if (customPath.startsWith("~/")) return path.join(os.homedir(), customPath.slice(2))
		return path.resolve(customPath)
	}
	return path.join(os.homedir(), ".qwen", "oauth_creds.json")
}
