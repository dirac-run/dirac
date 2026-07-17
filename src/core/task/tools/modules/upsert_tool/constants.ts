import * as path from "path"
import { DiracToolSpec, DiracDefaultTool } from "@/shared/tools"

export const SUBAGENT_MAX_TURNS = 15
export const SUBAGENT_TIMEOUT_SECONDS = 240
export const BUILDER_MAX_ATTEMPTS = 3
export const TOOL_IMPLEMENTATION_SENTINEL = "__DIRAC_TOOL_IMPLEMENTATION_REQUIRED__"
export const SMOKE_ARGS_FILE = "smoke-args.json"

export type ToolScope = "global" | "workspace" | "task"

export const TOOL_BUILDER_SYSTEM_SUFFIX = `
# Tool Builder Subagent Mode
You implement processCall in an existing user-tool scaffold, provide realistic smoke-test arguments, test the implementation, and submit.

## Strict boundaries
- Read the existing tool.ts before editing it.
- Edit only the processCall implementation. Do not rewrite the spec or create function.
- The only auxiliary file you may create or update is smoke-args.json in the staging directory.
- Do not modify files outside the staging directory.
- Do not install packages or call upsert_tool/use_subagents.
- Use read_file, edit_file, write_to_file, execute_command, and attempt_completion only.
- Do not paste source code in attempt_completion; it is already on disk.
`

/**
 * Contract sent to the subagent. Describes exactly how to write a valid Dirac tool module.
 * Lives here — never injected into the main agent's context.
 */
export const TOOL_AUTHORING_CONTRACT = `
## Tool Module Contract

The module MUST export exactly two things:

### 1. \`spec\` — a DiracToolSpec object

\`\`\`typescript
export const spec = {
    id: string,        // snake_case, must match the tool name
    name: string,      // same as id
    description: string, // what the tool does, shown to the LLM
    parameters: [
        { name: string, type: string, required: boolean, instruction: string },
    ],
}
\`\`\`

### 2. \`create\` — a factory function

\`\`\`typescript
export function create() {
    return {
        spec() { return spec },
        supportedSurfaces() { return ["all"] },
        async processCall(args: any, env: any): Promise<string> {
            // Your implementation here
        },
    }
}
\`\`\`

## Environment Traits (\`env\`)

**ALL methods are async and must be awaited.**

- **env.workspace** — File operations
  - \`await readFile(path): string\` — Read a file as UTF-8 string
  - \`await writeFile(path, content): void\` — Write a file
  - \`await listFiles(path, recursive, limit): [FileInfo[], boolean]\` — List files
  - \`await resolvePath(path): { absolutePath, displayPath }\` — Resolve a path

- **env.system** — System operations
  - \`await executeCommand(cmd, opts?): { userRejected: boolean, output: unknown, completed?: boolean, exitCode?: number | null, signal?: NodeJS.Signals | null, logFilePath?: string }\` — Run a shell command
  - \`await searchFiles(dir, regex, opts?): string\` — Search files with regex

- **env.ui** — UI
  - \`await createCard({ header, icon, collapsed, body?, status? }): Card\` — Create a UI card
  - Card methods: \`await card.update({ status, body, ... })\`, \`await card.finalize(status)\`

- **env.config** — Configuration (synchronous)
  - \`{ cwd: string, taskId?: string, isSubagentExecution: boolean }\`

## Rules

1. Do NOT import from Dirac internals. No \`@/\`, \`@core/\`, \`@shared/\` path aliases.
2. Use structural typing — do not import types, rely on the shapes described above.
3. \`processCall\` must handle empty or missing args gracefully — return a usage string, don't throw.
4. Return a string from \`processCall\` on success. Throw an Error on failure.
5. ALWAYS \`await\` every \`env\` method call. They all return Promises.
6. Use cards (\`env.ui.createCard\`) for meaningful user-visible progress.
`.trim()

export const upsert_tool_spec: DiracToolSpec = {
	id: DiracDefaultTool.UPSERT_TOOL,
	name: "upsert_tool",
	description:
		"Create or update one or more user-defined tools. Handles code generation, compilation, validation, smoke testing, and registration. Returns structured pass/fail for each tool. Supports global, workspace, and task scopes.",
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
						description: "Where the tool lives: 'global' (all workspaces), 'workspace' (this project only), or 'task' (current task only, survives resume).",
					},
					description: {
						type: "string",
						description: "What the tool does. Shown to the LLM.",
					},
					parameters: {
						type: "array",
						description: "Array of parameter objects: { name: string, type: string, required: boolean, instruction: string }.",
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
					requirements: {
						type: "string",
						description: "Natural language description of what the tool should do — its behavior, logic, and edge cases.",
					},
				},
				required: ["name", "scope", "description", "parameters", "requirements"],
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
}

export async function resolveTaskToolDir(name: string, taskId: string): Promise<string> {
	const { ensureTaskDirectoryExists } = await import("@core/storage/disk")
	const taskDir = await ensureTaskDirectoryExists(taskId)
	return path.join(taskDir, "tools", name)
}

export function buildManifest(
	name: string,
	scope: ToolScope,
): ManifestData {
	return {
		schemaVersion: 1,
		id: name,
		name,
		scope,
		entry: "tool.ts",
		createdBy: "dirac",
		createdAt: new Date().toISOString(),
	}
}
