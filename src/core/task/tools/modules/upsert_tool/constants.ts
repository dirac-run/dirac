import type { TaskStorageAddress } from "@core/storage/taskDirectory"
import * as path from "path"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"

export const SMOKE_ARGS_FILE = "smoke-args.json"
export const SMOKE_COMPLETION_MARKER = "DIRAC_UPSERT_SMOKE_COMPLETED"

export type ToolScope = "global" | "workspace" | "task"

export const upsert_tool_spec: DiracToolSpec = {
	id: DiracDefaultTool.UPSERT_TOOL,
	name: "upsert_tool",
	description:
		"Validate and install parent-supplied user tools in global, workspace, or task scope. Wraps each implementation body with the supplied metadata, smoke-tests it once, then registers it. Returns pass/fail per tool; repair failures yourself and call again. Does not generate code or delegate work.",
	parameters: [
		{
			name: "tools",
			type: "array",
			required: true,
			instruction: "Array of tool definitions to create or update.",
			items: {
				type: "object",
				properties: {
					name: {
						type: "string",
						description: "Snake_case tool identifier (e.g. 'run_tests', 'analyze_deps').",
					},
					scope: {
						type: "string",
						enum: ["global", "workspace", "task"],
						description:
							"Where the tool lives: 'global' (all workspaces), 'workspace' (this project only), or 'task' (current task only, survives resume).",
					},
					description: {
						type: "string",
						description: "What the tool does. Shown to the LLM.",
					},
					parameters: {
						type: "array",
						description:
							"Array of parameter objects: { name: string, type: string, required: boolean, instruction: string }.",
						items: {
							type: "object",
							properties: {
								name: {
									type: "string",
									description: "Snake_case parameter name.",
								},
								type: {
									type: "string",
									enum: ["string", "boolean", "integer", "array", "object"],
									description: "JSON Schema type for the parameter.",
								},
								required: {
									type: "boolean",
									description: "Whether the parameter is required.",
								},
								instruction: {
									type: "string",
									description: "LLM-facing instruction for the parameter.",
								},
							},
							required: ["name", "type", "required", "instruction"],
							additionalProperties: false,
						},
					},
					implementation: {
						type: "string",
						description:
							"Complete body of async processCall(args, env), not a module or function declaration. May reference args and env; no imports/exports or spec/create definitions. Return a string on success and throw on failure; handle empty args gracefully. Await asynchronous env methods.",
					},
					smoke_args: {
						type: "string",
						description:
							"JSON-encoded object containing realistic arguments for a successful smoke test, e.g. '{\"path\":\"src\"}'. Encoded as a string to support strict provider schemas. The implementation is also invoked with empty args. Smoke testing executes your code and may have side effects.",
					},
				},
				required: ["name", "scope", "description", "parameters", "implementation", "smoke_args"],
				additionalProperties: false,
			},
		},
	],
}

export interface ManifestData {
	schemaVersion: number
	id: string
	name: string
	scope: ToolScope
	entry: "tool.ts"
	createdBy: "dirac"
	createdAt: string
	description?: string
	parameters?: DiracToolSpec["parameters"]
}

export async function resolveTaskToolDir(name: string, address: string | TaskStorageAddress): Promise<string> {
	const { ensureTaskDirectoryExists } = await import("@core/storage/disk")
	const taskDir = await ensureTaskDirectoryExists(address)
	return path.join(taskDir, "tools", name)
}

export function buildManifest(name: string, scope: ToolScope, description?: string, parameters?: DiracToolSpec["parameters"]): ManifestData {
	return {
		schemaVersion: 1,
		id: name,
		name,
		scope,
		entry: "tool.ts",
		createdBy: "dirac",
		createdAt: new Date().toISOString(),
		description,
		parameters,
	}
}
