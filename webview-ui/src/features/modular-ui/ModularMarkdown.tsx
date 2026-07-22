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
							"relative min-w-0 flex-1 rounded-lg border px-3 py-2 text-base leading-relaxed",
							role === "user"
								? "border-(--vscode-focusBorder)/25 bg-(--vscode-focusBorder)/10"
								: "border-foreground/10 bg-foreground/[0.025]",
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
