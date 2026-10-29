import { meetsHostCapabilityRequirement } from "@hosts/host-capabilities"
import { HostProvider } from "@/hosts/host-provider"
import { diagnosticsToProblemsString } from "@/integrations/diagnostics"
import type { IDiagnosticsTrait } from "../../interfaces/IToolEnvironment"

export function buildDiagnosticsTrait(): IDiagnosticsTrait | undefined {
	if (!meetsHostCapabilityRequirement({ requiredHostCapability: "editorDiagnostics" })) return undefined
	return {
		prepare: async (paths) => {
			await HostProvider.workspace.prepareDiagnostics({ filePaths: paths })
		},
		getRaw: async (paths) => {
			const response = await HostProvider.workspace.getDiagnostics({ filePaths: paths })
			return response.fileDiagnostics || []
		},
		formatProblems: (diagnostics, fileContentMap, maxErrors) =>
			diagnosticsToProblemsString(diagnostics, undefined, fileContentMap, maxErrors),
	}
}
