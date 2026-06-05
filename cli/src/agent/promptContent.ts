import type * as acp from "@agentclientprotocol/sdk"

export type PromptContent = {
    textContent: string
    imageContent: string[]
    fileResources: string[]
}

export function parsePromptContent(prompt: acp.PromptRequest["prompt"]): PromptContent {
    const textContent = prompt
        .filter((block): block is acp.TextContent & { type: "text" } => block.type === "text")
        .map((block) => block.text)
        .join("\n")

    const imageContent = prompt
        .filter((block): block is acp.ImageContent & { type: "image" } => block.type === "image")
        .map((block) => `data:${block.mimeType || "image/png"};base64,${block.data}`)

    const fileResources = prompt
        .filter((block): block is acp.EmbeddedResource & { type: "resource" } => block.type === "resource")
        .map((block) => block.resource.uri)

    return { textContent, imageContent, fileResources }
}
