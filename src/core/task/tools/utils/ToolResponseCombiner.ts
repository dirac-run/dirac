import { ToolResponse } from "@core/task"
import { DiracTextContentBlock, DiracImageContentBlock } from "@shared/messages/content"

export class ToolResponseCombiner {
	/**
	 * Combines multiple ToolResponse objects into a single ToolResponse.
	 * If all responses are strings, it returns a joined string.
	 * If any response is an array of blocks, it returns a flattened array of blocks.
	 */
	static combine(responses: ToolResponse[], delimiter = "\n\n---\n\n"): ToolResponse {
		if (responses.length === 0) return ""
		if (responses.length === 1) return responses[0]

		const allAreStrings = responses.every((r) => typeof r === "string")
		if (allAreStrings) {
			return (responses as string[]).join(delimiter)
		}

		const combined: (DiracTextContentBlock | DiracImageContentBlock)[] = []
		for (let i = 0; i < responses.length; i++) {
			const r = responses[i]
			if (typeof r === "string") {
				combined.push({ type: "text", text: r })
			} else {
				combined.push(...r)
			}

			if (i < responses.length - 1 && delimiter) {
				combined.push({ type: "text", text: delimiter })
			}
		}
		return combined
	}
}
