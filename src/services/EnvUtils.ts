import { isMultiRootWorkspace } from "./workspace-detection"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { EmptyRequest } from "@/shared/proto/dirac/common"
import { Logger } from "@/shared/services/Logger"

// Canonical header names for extra client/host context
export const DiracHeaders = {
	PLATFORM: "X-PLATFORM",
	PLATFORM_VERSION: "X-PLATFORM-VERSION",
	CLIENT_VERSION: "X-CLIENT-VERSION",
	CLIENT_TYPE: "X-CLIENT-TYPE",
	CORE_VERSION: "X-CORE-VERSION",
	IS_MULTIROOT: "X-IS-MULTIROOT",
} as const
export type DiracHeaderName = (typeof DiracHeaders)[keyof typeof DiracHeaders]

export function buildExternalBasicHeaders(): Record<string, string> {
	return {
		"User-Agent": `Dirac/${ExtensionRegistryInfo.version}`,
	}
}

export async function buildBasicDiracHeaders(): Promise<Record<string, string>> {
	const headers: Record<string, string> = buildExternalBasicHeaders()
	try {
		const host = await HostProvider.env.getHostVersion(EmptyRequest.create({}))
		headers[DiracHeaders.PLATFORM] = host.platform || "unknown"
		headers[DiracHeaders.PLATFORM_VERSION] = host.version || "unknown"
		headers[DiracHeaders.CLIENT_TYPE] = host.diracType || "unknown"
		headers[DiracHeaders.CLIENT_VERSION] = host.diracVersion || "unknown"
	} catch (error) {
		Logger.log("Failed to get IDE/platform info via HostBridge EnvService.getHostVersion", error)
		headers[DiracHeaders.PLATFORM] = "unknown"
		headers[DiracHeaders.PLATFORM_VERSION] = "unknown"
		headers[DiracHeaders.CLIENT_TYPE] = "unknown"
		headers[DiracHeaders.CLIENT_VERSION] = "unknown"
	}
	headers[DiracHeaders.CORE_VERSION] = ExtensionRegistryInfo.version

	return headers
}

export async function buildDiracExtraHeaders(): Promise<Record<string, string>> {
	const headers = await buildBasicDiracHeaders()

	try {
		const isMultiRoot = await isMultiRootWorkspace()
		headers[DiracHeaders.IS_MULTIROOT] = isMultiRoot ? "true" : "false"
	} catch (error) {
		Logger.log("Failed to detect multi-root workspace", error)
		headers[DiracHeaders.IS_MULTIROOT] = "false"
	}

	return headers
}
