import { MarkdownRow } from "./components/MarkdownRow"
import { ThinkingRow } from "./components/ThinkingRow"
import { WithCopyButton } from "@/shared/ui/CopyButton"
import { cn } from "@/lib/utils"
import Thumbnails from "@/shared/ui/Thumbnails"
import QuoteButton from "./components/QuoteButton"
import { useQuoteLogic } from "./hooks/useQuoteLogic"
import { memo } from "react"

const NOOP = () => {}

interface ModularMarkdownProps {
	content: string
	isReasoning?: boolean
	images?: string[]
	files?: string[]
	partial?: boolean
	isExpanded?: boolean
	onToggleExpand?: () => void
	onAskForUpdate?: () => void
	onSetQuote?: (text: string) => void
	role?: "user" | "assistant"
}

export const ModularMarkdown = memo(
	({
		content,
		isReasoning,
		images,
		files,
		partial,
		isExpanded,
		onToggleExpand,
		onAskForUpdate,
		onSetQuote,
		role,
	}: ModularMarkdownProps) => {
		const { quoteButtonState, handleQuoteClick, handleMouseUp, contentRef } = useQuoteLogic(onSetQuote || NOOP)

		if (isReasoning) {
			return (
				<ThinkingRow
					isExpanded={isExpanded || false}
					isStreaming={partial}
					isVisible={true}
					onToggle={onToggleExpand || NOOP}
					reasoningContent={content}
					showChevron={true}
					showTitle={true}
					onAskForUpdate={onAskForUpdate}
					title={partial ? "Thinking..." : "Thinking"}
				/>
			)
		}

		return (
			<WithCopyButton
				className={cn(partial === true && "opacity-70")}
				position="bottom-right"
				textToCopy={partial === true ? undefined : content}>
				<div
					className={cn("flex items-center", role === "user" && "justify-end")}
					onMouseUp={handleMouseUp}
					ref={contentRef}>
					<div
						className={cn(
							"flex-1 min-w-0 px-2.5 py-1.5 rounded-lg relative",
							role === "user"
								? "bg-(--vscode-focusBorder)/10 border border-(--vscode-focusBorder)/20"
								: "bg-amber-900/10 border border-amber-800/20",
						)}>
						<MarkdownRow markdown={content} showCursor={false} />
						{quoteButtonState.visible && (
							<QuoteButton left={quoteButtonState.left} onClick={handleQuoteClick} top={quoteButtonState.top} />
						)}
					</div>
				</div>
				{((images && images.length > 0) || (files && files.length > 0)) && (
					<Thumbnails files={files ?? []} images={images ?? []} className="mt-2" />
				)}
			</WithCopyButton>
		)
	},
)
