import { Card } from "@shared/ExtensionMessage"
import { CardDecorator } from "./types"
import React from "react"
import { FolderIcon } from "lucide-react"

export const SearchDecorator: CardDecorator = {
	id: "search",
	shouldApply: (card: Card) =>
		card.icon === "search" ||
		card.header.toLowerCase().includes("search") ||
		card.header.toLowerCase().includes("grep"),
	renderBodyWrapper: (card: Card, children: React.ReactNode) => {
		if (!card.body) return children

		const multiWorkspaceMatch = card.body.match(/^Found \d+ results? across \d+ workspaces?\./m)
		if (!multiWorkspaceMatch) return children

		// Parse multi-workspace results
		const lines = card.body.split("\n")
		const sections: Array<{ workspace: string; content: string }> = []
		let currentWorkspace: string | null = null
		let currentContent: string[] = []

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			if (line.startsWith("## Workspace: ")) {
				if (currentWorkspace && currentContent.length > 0) {
					sections.push({
						workspace: currentWorkspace,
						content: currentContent.join("\n"),
					})
				}
				currentWorkspace = line.replace("## Workspace: ", "").trim()
				currentContent = []
			} else if (currentWorkspace) {
				currentContent.push(line)
			}
		}

		if (currentWorkspace && currentContent.length > 0) {
			sections.push({
				workspace: currentWorkspace,
				content: currentContent.join("\n"),
			})
		}

		if (sections.length === 0) return children

		return (
			<div className="flex flex-col gap-4 py-2">
				<div className="text-xs font-bold opacity-70 px-1">{lines[0]}</div>
				{sections.map((section, index) => (
					<div key={index} className="flex flex-col gap-2">
						<div className="flex items-center gap-2 px-2 py-1 bg-foreground/5 rounded-sm border border-foreground/10">
							<FolderIcon className="size-3 text-link" />
							<span className="text-xs font-medium">Workspace: {section.workspace}</span>
						</div>
						<div className="bg-foreground/[0.02] p-2 rounded-sm border border-foreground/5 overflow-x-auto">
							<pre className="text-[11px] font-mono whitespace-pre leading-tight">
								{section.content.trim()}
							</pre>
						</div>
					</div>
				))}
			</div>
		)
	},
}
