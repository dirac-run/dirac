import type { HostCapabilities } from "./host-provider-types"

// Leaf accessor so dependency-light modules (src/utils, src/core/api) can read
// host capabilities without importing the full HostProvider module graph.
// Mirrors HostProvider.get(): throws before initialization instead of
// returning an empty object.
let capabilities: HostCapabilities | undefined

export function setHostCapabilities(next: HostCapabilities | undefined): void {
	capabilities = next
}

export function getHostCapabilities(): HostCapabilities {
	if (!capabilities) {
		throw new Error("HostProvider not setup. Call HostProvider.initialize() first.")
	}
	return capabilities
}
