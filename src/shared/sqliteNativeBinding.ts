import * as fs from "fs"
import * as path from "path"
import { Logger } from "./services/Logger"

/**
 * Resolve the platform-specific native binding for better-sqlite3.
 * In packaged builds, prebuilt binaries are stored under prebuilds/{platform}/.
 * Returns undefined to let better-sqlite3 use its default resolution.
 */
export function resolveSqliteNativeBinding(): string | undefined {
	try {
		const sqliteDir = path.dirname(require.resolve("better-sqlite3/package.json"))
		const platformKey = `${process.platform}-${process.arch}`
		const prebuilt = path.join(sqliteDir, "prebuilds", platformKey, "build", "Release", "better_sqlite3.node")
		if (fs.existsSync(prebuilt)) {
			Logger.info(`[SqliteNativeBinding] Using prebuilt binary: ${prebuilt}`)
			return prebuilt
		}
		// Fallback: check for local build (dev environment)
		const localBuild = path.join(sqliteDir, "build", "Release", "better_sqlite3.node")
		if (fs.existsSync(localBuild)) {
			return undefined // let better-sqlite3 use default resolution
		}
		Logger.warn("[SqliteNativeBinding] No native binding found for platform " + platformKey)
		return undefined
	} catch {
		return undefined
	}
}
