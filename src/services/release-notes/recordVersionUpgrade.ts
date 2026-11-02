import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import type { StateAccess } from "@/shared/storage/state-access"

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

function compareVersions(left: string, right: string): number | undefined {
	const leftMatch = VERSION_PATTERN.exec(left)
	const rightMatch = VERSION_PATTERN.exec(right)
	if (!leftMatch || !rightMatch) return undefined
	for (let index = 1; index <= 3; index++) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index])
		if (difference !== 0) return difference
	}
	return 0
}

export async function recordVersionUpgrade(stateManager: StateAccess): Promise<void> {
	const currentVersion = ExtensionRegistryInfo.version
	const previousVersion = stateManager.getGlobalStateKey("diracVersion")
	if (previousVersion === currentVersion) return

	if (!previousVersion) {
		stateManager.setGlobalState("diracVersion", currentVersion)
		await stateManager.flushPendingState()
		return
	}

	const comparison = compareVersions(previousVersion, currentVersion)
	const pendingFromVersion = stateManager.getGlobalStateKey("pendingReleaseNotesFromVersion")
	const updates =
		comparison !== undefined && comparison < 0
			? { diracVersion: currentVersion, pendingReleaseNotesFromVersion: pendingFromVersion ?? previousVersion }
			: { diracVersion: currentVersion, pendingReleaseNotesFromVersion: undefined }
	stateManager.setGlobalStateBatch(updates)
	await stateManager.flushPendingState()
	Logger.log(`[ReleaseNotes] Recorded version transition ${previousVersion} -> ${currentVersion}`)
}
