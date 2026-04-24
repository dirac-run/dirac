import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"

const id = DiracDefaultTool.LIST_FILES

export const list_files: DiracToolSpec = {
	id,
	name: "list_files",
	description:
		"List files and directories within the specified paths (one or more), or provide information about a specific file if a file path is provided. If recursive is true, it will list all files and directories recursively. Skips non-useful content (.git, node_modules, build artifacts, etc.). Files are sorted by most recently modified first within each directory. The output includes the line count for each file. Do not use this tool to confirm the existence of files you've just created.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction:
				"The paths of the directory to list contents for (relative to the current working directory {{CWD}}){{MULTI_ROOT_HINT}}",
			usage: '["src/components", "src/utils"]',
		},
		{
			name: "recursive",
			required: false,
			instruction: "Whether to list files recursively. Use true for recursive listing, false or omit for top-level only.",
			usage: "true or false (optional)",
			type: "boolean",
		},
	],
}
