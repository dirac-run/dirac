import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"

export const execute_command: DiracToolSpec = {
	id: DiracDefaultTool.BASH,
	name: "execute_command",
	description:
		"Executes CLI commands or scripts. " +
		"Use 'commands' for simple sequences of shell operations. " +
		"Use 'script' for complex multi-line logic, data processing, or when a high-level language like Python or Node.js is more efficient than shell scripting. Default language is bash" +
		"Scripts have full access to the file system and current environment, be careful. " +
		"In multi-root workspaces, use the @workspace:command syntax for standard commands. " +
		"Leverage the full power of the environment's interpreters (bash, python, node, etc.) to accomplish tasks with minimal round-trips.",
	parameters: [
		{
			name: "commands",
			required: false,
			type: "array",
			items: { type: "string" },
			instruction:
				"An array of CLI commands to execute in sequence. Use proper shell operators within each command. Do not use ~ for home directory.",
		},
		{
			name: "script",
			required: false,
			type: "string",
			instruction:
				"A script to execute. Use this for complex multi-line logic or non-shell languages like Python or Node.js.",
		},
		{
			name: "language",
			required: false,
			type: "string",
			instruction: "The language of the script (e.g., 'bash', 'python', 'node'). Defaults to 'bash'.",
		},
	],
}
