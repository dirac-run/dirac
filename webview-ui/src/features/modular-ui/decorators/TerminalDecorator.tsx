import { Card } from "@shared/ExtensionMessage"
import { CopyButton } from "@/shared/ui/CopyButton"
import { CardDecorator } from "./types"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { StringRequest } from "@shared/proto/dirac/common"

export const TerminalDecorator: CardDecorator = {
	id: "terminal",
	shouldApply: (card: Card) => card.icon === "terminal" || card.header.toLowerCase().includes("command"),
	renderHeaderActions: (card: Card) => {
		// Heuristic: the command is often the first line of the body or in the header
		const command = card.body?.split("\n")[0] || card.header
		return <CopyButton className="opacity-60 hover:opacity-100" textToCopy={command} />
	},
	renderFooterExtra: (card: Card) => {
		if (!card.body) return null

		// Ported from CommandOutputRow: Detect log file path in output
		const logFilePathMatch = card.body.match(/📋 Output is being logged to: ([^\n]+)/)
		const logFilePath = logFilePathMatch ? logFilePathMatch[1].trim() : null

		if (!logFilePath) return null

		const fileName = logFilePath.split("/").pop() || logFilePath

		return (
			<div
				className="flex items-center gap-1.5 px-3 py-2 mx-3 mb-3 rounded-sm bg-foreground/5 cursor-pointer hover:bg-foreground/10 transition-colors border border-foreground/10"
				onClick={() => {
					FileServiceClient.openFile(StringRequest.create({ value: logFilePath })).catch((err) =>
						console.error("Failed to open log file from ModularCard:", err),
					)
				}}
				title={`Click to open: ${logFilePath}`}>
				<span className="text-xs shrink-0 opacity-70">📋 Output is being logged to:</span>
				<span className="text-xs text-link underline break-all font-mono">{fileName}</span>
			</div>
		)
	},
}
