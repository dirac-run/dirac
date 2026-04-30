import { DiracDefaultTool } from "@/shared/tools"
import type { DiracToolSpec } from "../spec"

const id = DiracDefaultTool.ATTEMPT

export const attempt_completion: DiracToolSpec = {
	id,
	name: "attempt_completion",
	description: "Presents a brief and informative summary of the final result. Keep it concise while covering important changes. Avoid redundant text.",
	parameters: [
		{
			name: "result",
			required: true,
			instruction: "The final result of the task.",
			usage: "I have completed the task...",
		},
		{
			name: "command",
			required: false,
			instruction: "Optional CLI command to demo the result (e.g., 'open index.html'). Do not use 'echo' or 'cat'.",
			usage: "open index.html",
		},
	],
}

export const attempt_completion_variants = [attempt_completion]
