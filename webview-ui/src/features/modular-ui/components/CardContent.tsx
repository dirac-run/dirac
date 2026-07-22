import React from "react"
import { RenderType } from "@shared/ExtensionMessage"
import MarkdownBlock from "@/shared/ui/MarkdownBlock"
import { ModularDiffView } from "../ModularDiffView"

interface CardContentProps {
	body: string
	renderType: RenderType
}

export const CardContent: React.FC<CardContentProps> = ({ body, renderType }) => {
	switch (renderType) {
		case "text":
			return <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed">{body}</pre>
		case "markdown":
			return <MarkdownBlock markdown={body} />
		case "diff":
			return <ModularDiffView diff={body} />
		default:
			return <MarkdownBlock markdown={body} />
	}
}
