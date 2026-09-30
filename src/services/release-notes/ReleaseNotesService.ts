import fs from "node:fs"
import path from "node:path"
import type { StateAccess } from "@shared/storage/state-access"
import type { ReleaseNotesDocument, ReleaseNotesView } from "@shared/release-notes"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

function compareVersions(left: string, right: string): number {
	const leftMatch = VERSION_PATTERN.exec(left)
	const rightMatch = VERSION_PATTERN.exec(right)
	if (!leftMatch || !rightMatch) return left.localeCompare(right)
	for (let index = 1; index <= 3; index++) {
		const difference = Number(leftMatch[index]) - Number(rightMatch[index])
		if (difference !== 0) return difference
	}
	return 0
}

function isReleaseNotesDocument(value: unknown): value is ReleaseNotesDocument {
	if (!value || typeof value !== "object") return false
	const document = value as Partial<ReleaseNotesDocument>
	return (
		document.schemaVersion === 1 &&
		typeof document.version === "string" &&
		(document.kind === "patch" || document.kind === "minor" || document.kind === "major") &&
		typeof document.headline === "string" &&
		Array.isArray(document.highlights)
	)
}

function readBundledDocuments(): ReleaseNotesDocument[] {
	const directory = path.join(HostProvider.get().extensionFsPath, "release-notes")
	if (!fs.existsSync(directory)) return []

	return fs
		.readdirSync(directory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => path.join(directory, entry.name))
		.map((filePath) => {
			try {
				const document = JSON.parse(fs.readFileSync(filePath, "utf8"))
				if (!isReleaseNotesDocument(document)) {
					Logger.warn(`[ReleaseNotesService] Ignoring invalid bundled notes: ${filePath}`)
					return undefined
				}
				return document
			} catch (error) {
				Logger.warn(`[ReleaseNotesService] Could not read bundled notes ${filePath}:`, error)
				return undefined
			}
		})
		.filter((document): document is ReleaseNotesDocument => document !== undefined)
}

export function getPendingReleaseNotes(stateManager: StateAccess): ReleaseNotesView | undefined {
	const fromVersion = stateManager.getGlobalStateKey("pendingReleaseNotesFromVersion")
	if (!fromVersion) return undefined

	const toVersion = ExtensionRegistryInfo.version
	const releases = readBundledDocuments()
		.filter((document) => document.announce !== false)
		.filter((document) => compareVersions(document.version, fromVersion) > 0)
		.filter((document) => compareVersions(document.version, toVersion) <= 0)
		.sort((left, right) => compareVersions(left.version, right.version))

	if (releases.length === 0) {
		return undefined
	}

	return { fromVersion, toVersion, releases }
}
