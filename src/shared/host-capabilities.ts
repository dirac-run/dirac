/** Host integrations required by optional skills and tools, independent of terminal execution mode. */
export interface HostCapabilityRequirement {
	requiredHostCapability?: "architectureViewer" | "editorDiagnostics"
}
