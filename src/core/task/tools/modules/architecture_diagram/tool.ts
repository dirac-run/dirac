import { CardStatus } from "@shared/ExtensionMessage"
import type { DiracToolSpec } from "@shared/tools"
import type { ArchitectureDiagramEnvironment } from "./ArchitectureDiagramEnvironment"

export const spec: DiracToolSpec = {
	id: "architecture_diagram",
	requiredHostCapability: "architectureViewer",
	name: "architecture_diagram",
	description:
		"Save and show named, versioned task-local architecture diagrams. Each successful upsert automatically opens the exact saved version for the user and creates persistent Open navigation; no separate display call is needed. Validation/save errors return to you for correction without opening a board. A display failure after saving retains the saved name/version: retry display, not upsert. Distinct diagram names open separate panels. Use display operations to reopen saved diagrams or show exact-version before/after comparisons. Interactive mode waits for feedback through chat or explicitly submitted board comments, equally valid channels; autonomous mode opens and continues without waiting. Chat does not submit pending comments; showing a diagram is not approval.",
	parameters: [
		{
			name: "operation",
			type: "string",
			required: true,
			enum: ["upsert_diagram", "display_diagram", "display_comparison", "list_diagrams", "fetch_diagram"],
			instruction:
				"Required operation. Supply only the parameters for that operation; omit unused fields or set them to null.",
		},
		{
			name: "name",
			type: "string",
			required: false,
			instruction:
				"Required except for list_diagrams. Stable task-local safe name segment, not a path, e.g. tool-execution.",
		},
		{
			name: "diagram",
			type: "string",
			required: false,
			instruction:
				"Required only for upsert_diagram. Complete semantic graph JSON as a string, not a patch or executable graphics. Infer the view from user intent: understand, design/refine, interaction/state transitions, or before/after review; do not require a view picker. Resolve kinds at the chosen abstraction level: concrete classes as class, functions/methods as function, intentional composites as component; a composite is not an unresolved entity. Use specific responsibility-based labels for composites and exact symbols/code references for implementation nodes; state genuine uncertainty explicitly. For interaction protocols use state for conditions, actor for participants, transition between states with event [guard] labels, and message for communication without implying synchronous invocation or consumption. Actors are not state-machine containers; use groups for independent lifecycles. Show verified ownership, per-instance scopes, shared resources and the main flow; use aggregation from owner to owned object, not topic groups as a substitute. Prefer a small overview and focused detail boards. Before publication review semantics, not just schema validity. For comparisons label baseline and proposed/implemented state in titles/summaries and preserve unchanged IDs; diagram versions are not code revisions.",
		},
		{
			name: "version",
			type: "integer",
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
			required: false,
			instruction: "Only for fetch_diagram or display_diagram. Positive integer; omit or use null for latest.",
		},
		{
			name: "start_version",
			type: "integer",
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
			required: false,
			instruction:
				"Required only for display_comparison. Exact positive integer diagram version for the left side. For before/after review, use the inspected baseline snapshot, not an assumed earlier code revision.",
		},
		{
			name: "end_version",
			type: "integer",
			minimum: 1,
			maximum: Number.MAX_SAFE_INTEGER,
			required: false,
			instruction:
				"Required only for display_comparison. Exact positive integer diagram version for the right side. For before/after review, use the proposed or implemented after snapshot with matching scope and unchanged entity IDs.",
		},
	],
}

export const exposure = {
	kind: "skill_only",
	authorizedSkillIds: ["architecture-board"],
} as const

/** Discovery and construction load neither board operations nor storage/viewer dependencies. */
export function create() {
	return {
		spec: () => spec,
		supportedSurfaces: (): ["all"] => ["all"],
		async processCall(input: unknown, env: ArchitectureDiagramEnvironment): Promise<string> {
			const card = await env.ui.createCard({ icon: "map", header: "Architecture diagram", collapsed: true })
			let implementation: typeof import("./ArchitectureDiagramTool")
			try {
				implementation = await import("./ArchitectureDiagramTool")
			} catch {
				const operation =
					input && typeof input === "object" && "operation" in input && typeof input.operation === "string"
						? input.operation
						: "unknown"
				env.orchestration.reportFailure()
				const message = `${operation}: architecture diagram implementation unavailable. Continue with ordinary tools and chat; no diagram operation was performed.`
				try {
					await card.update({ status: CardStatus.ERROR, body: message })
				} finally {
					await card.finalize(CardStatus.ERROR)
				}
				return JSON.stringify({ operation, outcome: "unavailable", error: message })
			}
			return implementation.executeArchitectureDiagram(input, env, card)
		},
	}
}
