import React from "react"

import { DiracMessage } from "@shared/ExtensionMessage"
import { ChatState, MessageHandlers, ScrollBehavior } from "./types/chatTypes"

export interface ModularInputContext {
	inputValue: string
	setInputValue: (value: string) => void
	cursorPosition: number
	setCursorPosition: (pos: number) => void
	isFocused: boolean
	setIsFocused: (focused: boolean) => void
	textAreaRef: React.RefObject<HTMLTextAreaElement>
	selectedFiles: string[]
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>
	selectedImages: string[]
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>
	// Additional shared state can be added here as needed by traits
}

export interface InputTrait {
	id: string
	/** Initialize the trait with the modular input context */
	attach?: (context: ModularInputContext) => void
	/** Handle keydown events. Return true if the event was handled and should not propagate. */
	onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>, context: ModularInputContext) => boolean | void
	/** Handle input changes. */
	onInputChange?: (value: string, cursorPosition: number, context: ModularInputContext) => void
	/** Handle paste events. */
	onPaste?: (e: React.ClipboardEvent, context: ModularInputContext) => void
	/** Handle drop events. */
	onDrop?: (e: React.DragEvent, context: ModularInputContext) => void
}

export interface InputDecorator {
	id: string
	/** Render elements inside the highlight layer */
	renderHighlight?: (value: string, context: ModularInputContext) => React.ReactNode
	/** Render overlays (like menus) */
	renderOverlay?: (context: ModularInputContext) => React.ReactNode
	/** Render action buttons in the toolbar */
	renderAction?: (context: ModularInputContext) => React.ReactNode
}

export interface ChatViewContext {
	task?: DiracMessage
	messages: DiracMessage[]
	modifiedMessages: DiracMessage[]
	renderedMessages: DiracMessage[]
	apiMetrics: any
	lastApiReqInfo: any
	chatState: ChatState
	messageHandlers: MessageHandlers
	scrollBehavior: ScrollBehavior
	// Props from ChatView
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
	version: string
	taskHistory: any[]
	shouldShowQuickWins: boolean
	telemetrySetting: string
	selectedModelInfo: any
	shouldDisableFilesAndImages: boolean
	selectFilesAndImages: () => Promise<void>
	placeholderText: string
}

export interface ChatSection {
	id: string
	render: (context: ChatViewContext) => React.ReactNode
	shouldRender: (context: ChatViewContext) => boolean
}

export interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
}

export interface ChatViewDecorator {
	id: string
	render?: (context: ChatViewContext) => React.ReactNode
}
