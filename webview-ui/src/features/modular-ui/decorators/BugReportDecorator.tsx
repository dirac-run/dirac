import { Card } from "@shared/ExtensionMessage"
import { CardDecorator } from "./types"
import React from "react"
import MarkdownBlock from "@/shared/ui/MarkdownBlock"

export const BugReportDecorator: CardDecorator = {
	id: "bug-report",
	shouldApply: (card: Card) =>
		card.header.toLowerCase().includes("bug report") || card.body?.includes('"what_happened":') || false,
	renderBodyWrapper: (card: Card, children: React.ReactNode) => {
		if (!card.body) return children

		try {
			const bugData = JSON.parse(card.body)
			if (!bugData.what_happened && !bugData.steps_to_reproduce) return children

			return (
				<div className="flex flex-col gap-4 py-2">
					{bugData.title && <h2 className="font-bold text-base">{bugData.title}</h2>}
					<div className="space-y-4 text-sm">
						{bugData.what_happened && (
							<div>
								<div className="font-semibold mb-1 opacity-70">What Happened?</div>
								<MarkdownBlock markdown={bugData.what_happened} />
							</div>
						)}
						{bugData.steps_to_reproduce && (
							<div>
								<div className="font-semibold mb-1 opacity-70">Steps to Reproduce</div>
								<MarkdownBlock markdown={bugData.steps_to_reproduce} />
							</div>
						)}
						{bugData.api_request_output && (
							<div>
								<div className="font-semibold mb-1 opacity-70">Relevant API Request Output</div>
								<MarkdownBlock markdown={bugData.api_request_output} />
							</div>
						)}
						{bugData.system_info && (
							<div>
								<div className="font-semibold mb-1 opacity-70">System Info</div>
								<MarkdownBlock markdown={bugData.system_info} />
							</div>
						)}
					</div>
				</div>
			)
		} catch {
			return children
		}
	},
}
