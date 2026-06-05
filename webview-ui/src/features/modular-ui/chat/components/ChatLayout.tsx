import type React from "react"
import { cn } from "@/lib/utils"

interface ChatLayoutProps {
	isHidden: boolean
	children: React.ReactNode
}

/**
 * Main layout container for the chat view
 * Provides the fixed positioning and flex layout structure
 */
export const ChatLayout: React.FC<ChatLayoutProps> = ({ isHidden, children }) => {
	return (
		<div
			className={cn("grid grid-rows-[1fr_auto] overflow-hidden p-0 m-0 w-full h-full relative", {
				hidden: isHidden,
			})}>
			{children}
		</div>
	)
}
