import React, { useCallback, useMemo } from "react"
import { motion } from "framer-motion"
import { InputPrimitive } from "./components/InputPrimitive"
import { useModularInput } from "./hooks/useModularInput"
import { InputDecorator, InputTrait } from "./types"
import { cn } from "@/lib/utils"
import { usePlatform } from "@/context/PlatformContext"
import { useShortcut } from "@/shared/lib/hooks"
import { useMentionTrait } from "./traits/useMentionTrait"
import { useSlashCommandTrait } from "./traits/useSlashCommandTrait"
import { useFileHandlingTrait } from "./traits/useFileHandlingTrait"
import { useModeTrait } from "./traits/useModeTrait"
import { HighlightDecorator } from "./decorators/HighlightDecorator"
import { createOverlayDecorator } from "./decorators/OverlayDecorator"
import { createActionDecorator } from "./decorators/ActionDecorator"
import Thumbnails from "@/shared/ui/Thumbnails"

import type { TaskStatus } from "@shared/ExtensionMessage"
interface ModularChatTextAreaProps {
	mode: "plan" | "act"
	modelDisplayName: string
	onModelButtonClick: () => void
	onSelectFilesAndImages: () => void
	shouldDisableFilesAndImages: boolean
	placeholder?: string
	onSend?: () => void
	inputValue?: string
	setInputValue?: (value: string) => void
	selectedFiles?: string[]
	setSelectedFiles?: React.Dispatch<React.SetStateAction<string[]>>
	selectedImages?: string[]
	setSelectedImages?: React.Dispatch<React.SetStateAction<string[]>>
	sendingDisabled?: boolean
	taskStatus?: TaskStatus
	onHeightChange?: (height: number) => void
	className?: string
}

export const ModularChatTextArea: React.FC<ModularChatTextAreaProps> = ({
	mode,
	modelDisplayName,
	onModelButtonClick,
	onSelectFilesAndImages,
	shouldDisableFilesAndImages,
	placeholder,
	inputValue,
	setInputValue,
	selectedFiles,
	setSelectedFiles,
	selectedImages,
	setSelectedImages,
	sendingDisabled,
	taskStatus,
	onHeightChange,
	onSend,
	className,
}) => {
	// Initialize Traits
	const mentionTrait = useMentionTrait()
	const slashCommandTrait = useSlashCommandTrait()
	const fileHandlingTrait = useFileHandlingTrait()
	const modeTrait = useModeTrait(mode)

	const traits = useMemo<InputTrait[]>(
		() => [mentionTrait, slashCommandTrait, fileHandlingTrait, modeTrait],
		[mentionTrait, slashCommandTrait, fileHandlingTrait, modeTrait],
	)

	// Initialize Decorators
	const platform = usePlatform()
	const overlayDecorator = useMemo(
		() => createOverlayDecorator(mentionTrait, slashCommandTrait),
		[mentionTrait, slashCommandTrait],
	)
	const actionDecorator = useMemo(
		() =>
			createActionDecorator({
				mode,
				modelDisplayName,
				onModelButtonClick,
				onSelectFilesAndImages,
				shouldDisableFilesAndImages,
				sendingDisabled,
				taskStatus,
				onModeToggle: modeTrait.onModeToggle,
				togglePlanActKeys: platform.togglePlanActKeys,
			}),
		[
			mode,
			modelDisplayName,
			onModelButtonClick,
			onSelectFilesAndImages,
			shouldDisableFilesAndImages,
			sendingDisabled,
			taskStatus,
			modeTrait.onModeToggle,
			platform.togglePlanActKeys,
		],
	)

	const decorators = useMemo<InputDecorator[]>(
		() => [HighlightDecorator, overlayDecorator, actionDecorator],
		[overlayDecorator, actionDecorator],
	)

	const { context, handleKeyDown, handleInputChange, handlePaste, handleDrop, updateCursorPosition } = useModularInput({
		traits,
		inputValue,
		setInputValue,
		selectedFiles,
		setSelectedFiles,
		selectedImages,
		setSelectedImages,
	})

	// Register keyboard shortcut for Plan/Act toggle
	const handleModeToggleWithInput = useCallback(() => {
		if (context) {
			modeTrait.onModeToggle(context)
		}
	}, [context, modeTrait])
	useShortcut(platform.togglePlanActKeys, handleModeToggleWithInput, { disableTextInputs: false })

	const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === "Enter" && !e.shiftKey) {
			// Check if any trait handled it first (e.g. menu selection)
			if (handleKeyDown(e)) return

			e.preventDefault()
			onSend?.()
			return
		}
		handleKeyDown(e)
	}

	return (
		<div className={cn("relative flex flex-col w-full", className)} onDrop={handleDrop}>
			<div
				className={cn(
					"relative rounded-(--radius-input) transition-all duration-200",
					context.isFocused
						? "border border-(--vscode-focusBorder) bg-(--vscode-input-background) shadow-[0_0_6px_1px_var(--color-glow-act)]"
						: "border border-(--vscode-input-border) bg-(--vscode-input-background) hover:border-[color-mix(in_srgb,var(--vscode-input-border)_80%,transparent)]",
				)}>
				{/* Highlight Layer */}
				<div className="absolute inset-0 pointer-events-none whitespace-pre-wrap break-words p-[10px_32px_10px_12px] vscode-editor-font text-transparent">
					{decorators.map((d) => (
						<React.Fragment key={`highlight-${d.id}`}>
							{d.renderHighlight?.(context.inputValue, context)}
						</React.Fragment>
					))}
				</div>

				{(context.selectedImages.length > 0 || context.selectedFiles.length > 0) && (
					<div className="px-3 pt-2 pb-1 animate-in fade-in slide-in-from-top-1 duration-200">
						<Thumbnails
							files={context.selectedFiles}
							images={context.selectedImages}
							setFiles={context.setSelectedFiles}
							setImages={context.setSelectedImages}
						/>
					</div>
				)}

				<InputPrimitive
					ref={context.textAreaRef}
					value={context.inputValue}
					onChange={handleInputChange}
					onKeyDown={onKeyDown}
					onFocus={() => context.setIsFocused(true)}
					onBlur={() => context.setIsFocused(false)}
					onPaste={handlePaste}
					onSelect={updateCursorPosition}
					onHeightChange={onHeightChange}
					data-testid="chat-input"
					placeholder={placeholder}
					style={{
						padding: "10px 32px 10px 12px",
					}}
				/>

				{/* Send Button */}
				<div className="absolute flex items-end bottom-4.5 right-5 z-10 h-8">
					<div className="flex flex-row items-center">
						<motion.div
							className={cn("input-icon-button", { disabled: sendingDisabled }, "codicon codicon-send text-sm")}
							data-testid="send-button"
							onClick={() => {
								if (!sendingDisabled) {
									context.setIsFocused(false)
									onSend?.()
								}
							}}
							whileHover={{ scale: 1.1 }}
							whileTap={{ scale: 0.9 }}
						/>
					</div>
				</div>
			</div>

			{/* Overlays (Menus, etc.) */}
			{decorators.map((d) => (
				<React.Fragment key={`overlay-${d.id}`}>{d.renderOverlay?.(context)}</React.Fragment>
			))}

			{/* Actions (Toolbar) */}
			<div className="flex items-center gap-1 px-2 py-1.5">
				{decorators.map((d) => (
					<React.Fragment key={`action-${d.id}`}>{d.renderAction?.(context)}</React.Fragment>
				))}
			</div>
		</div>
	)
}
