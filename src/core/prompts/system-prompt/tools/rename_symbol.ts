import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"

const id = DiracDefaultTool.RENAME_SYMBOL

export const rename_symbol: DiracToolSpec = {
	id,
	name: "rename_symbol",
	description:
		"Renames ALL occurrences of a symbol (function, class, method, or variable) inside the specified files or directories. This tool can identify precise symbols using a language's AST and is more accurate than a simple search-and-replace because it understands the language structure. For renaming tasks, strongly prefer this as the first pass.",
	parameters: [
		{
			name: "paths",
			required: true,
			type: "array",
			items: { type: "string" },
			instruction: "An array of relative paths to the directories or files to perform the rename in.",
			usage: '["src/", "tests/"]',
		},
		{
			name: "existing_symbol",
			required: true,
			type: "string",
			instruction: "The exact name of the symbol to be renamed.",
			usage: '"calculateTotal"',
		},
		{
			name: "new_symbol",
			required: true,
			type: "string",
			instruction: "The new name for the symbol.",
			usage: '"calculateGrandTotal"',
		},
	],
}
