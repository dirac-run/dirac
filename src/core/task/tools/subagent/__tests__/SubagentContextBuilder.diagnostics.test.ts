import { strict as assert } from "node:assert"
import { afterEach, describe, it } from "mocha"
import type { SystemPromptContext } from "@core/prompts/system-prompt/types"
import { setHostCapabilities } from "@/hosts/host-capabilities"
import type { TaskConfig } from "../../types/TaskConfig"
import type { DiscoveredTool } from "../../discovery/DiscoveredTool"
import { diagnostics_scan_spec, DiagnosticsScanTool } from "../../modules/diagnostics_scan"
import { ToolRegistry } from "../../registry/ToolRegistry"
import { ToolExecutorCoordinator } from "../../ToolExecutorCoordinator"
import type { SubagentBuilder } from "../SubagentBuilder"
import { SubagentContextBuilder } from "../SubagentContextBuilder"

const diagnosticsTool: DiscoveredTool = {
	id: "diagnostics_scan",
	name: "diagnostics_scan",
	source: "builtin",
	exposure: { kind: "configurable" },
	spec: diagnostics_scan_spec,
	factory: () => new DiagnosticsScanTool(),
	modulePath: "modules/diagnostics_scan/tool.ts",
}

const context = {
	providerInfo: { providerId: "anthropic", model: { id: "test-model", info: {} } },
} as SystemPromptContext

describe("SubagentContextBuilder diagnostics host capability", () => {
	afterEach(() => {
		ToolRegistry.resetInstance()
		setHostCapabilities(undefined)
	})

	for (const available of [false, true]) {
		it(`${available ? "exposes" : "omits"} explicitly allowed parent diagnostics when host support is ${available}`, async () => {
			setHostCapabilities(available ? { editorDiagnostics: true } : {})
			ToolRegistry.resetInstance()
			ToolRegistry.getInstance().registerBuiltin(diagnosticsTool)
			const config = {
				coordinator: new ToolExecutorCoordinator(),
				taskState: { activeSkillIds: [], availableSkills: [] },
				activeToolSnapshot: { activeSkillIds: [], inventoryEnabledTools: [diagnosticsTool] },
			} as unknown as TaskConfig
			const builder = new SubagentContextBuilder(
				config,
				{} as SubagentBuilder,
				["diagnostics_scan"],
				{} as never,
			)

			const snapshot = await builder.buildSubagentRequestSnapshot(context)

			assert.equal(snapshot.promptVisibleSpecs.some((spec) => spec.name === "diagnostics_scan"), available)
			assert.equal(snapshot.nativeTools.some((tool) => "name" in tool && tool.name === "diagnostics_scan"), available)
			assert.equal(snapshot.inventoryEnabledTools.some((tool) => tool.id === "diagnostics_scan"), available)
			assert.equal(snapshot.executableToolNames.has("diagnostics_scan"), available)
			assert.equal(snapshot.coordinator.has("diagnostics_scan"), available)
		})
	}
})
