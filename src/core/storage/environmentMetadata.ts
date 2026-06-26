import { EnvironmentMetadataEntry } from "@core/context/context-tracking/ContextTrackerTypes"
import os from "os"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"

// Collects environment metadata for the current system and host (no timestamp; caller adds it).
export async function collectEnvironmentMetadata(): Promise<Omit<EnvironmentMetadataEntry, "ts">> {
	try {
		const hostVersion = await HostProvider.env.getHostVersion({})
		return {
			os_name: os.platform(),
			os_version: os.release(),
			os_arch: os.arch(),
			host_name: hostVersion.platform || "Unknown",
			host_version: hostVersion.version || "Unknown",
			dirac_version: ExtensionRegistryInfo.version,
		}
	} catch (error) {
		Logger.error("Failed to collect environment metadata:", error)
		return {
			os_name: os.platform(),
			os_version: os.release(),
			os_arch: os.arch(),
			host_name: "Unknown",
			host_version: "Unknown",
			dirac_version: "Unknown",
		}
	}
}
