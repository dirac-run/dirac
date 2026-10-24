import { Anthropic } from "@anthropic-ai/sdk"
import * as diff from "diff"

/** Host-agnostic tool-result formatter — core/formatResponse delegates here so leaf layers can use it. */
export function toolResult(
	text: string,
	images?: string[],
	fileString?: string,
): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
	const toolResultOutput = []

	if (!(images && images.length > 0) && !fileString) {
		return text
	}

	const textBlock: Anthropic.TextBlockParam = { type: "text", text }
	toolResultOutput.push(textBlock)

	if (images && images.length > 0) {
		const imageBlocks: Anthropic.ImageBlockParam[] = formatImagesIntoBlocks(images)
		toolResultOutput.push(...imageBlocks)
	}

	if (fileString) {
		const fileBlock: Anthropic.TextBlockParam = { type: "text", text: fileString }
		toolResultOutput.push(fileBlock)
	}

	return toolResultOutput
}

export function createPrettyPatch(filename = "file", oldStr?: string, newStr?: string) {
	// strings cannot be undefined or diff throws exception
	const patch = diff.createPatch(filename.toPosix(), oldStr || "", newStr || "")
	const lines = patch.split("\n")
	const prettyPatchLines = lines.slice(4)
	return prettyPatchLines.join("\n")
}

export function formatImagesIntoBlocks(images?: string[]): Anthropic.ImageBlockParam[] {
	return images
		? images.map((dataUrl) => {
			// data:image/png;base64,base64string
			const [rest, base64] = dataUrl.split(",")
			const mimeType = rest.split(":")[1].split(";")[0]
			return {
				type: "image",
				source: {
					type: "base64",
					media_type: mimeType,
					data: base64,
				},
			} as Anthropic.ImageBlockParam
		})
		: []
}
