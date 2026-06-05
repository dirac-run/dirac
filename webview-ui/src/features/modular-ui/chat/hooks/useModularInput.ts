import React, { useCallback, useMemo, useRef, useState, useEffect } from "react"
import { InputTrait, ModularInputContext } from "../types"

export interface UseModularInputProps {
	traits: InputTrait[]
	inputValue?: string
	setInputValue?: (value: string) => void
	selectedFiles?: string[]
	setSelectedFiles?: React.Dispatch<React.SetStateAction<string[]>>
	selectedImages?: string[]
	setSelectedImages?: React.Dispatch<React.SetStateAction<string[]>>
}

export const useModularInput = ({
	traits,
	inputValue: externalInputValue,
	setInputValue: externalSetInputValue,
	selectedFiles: externalSelectedFiles,
	setSelectedFiles: externalSetSelectedFiles,
	selectedImages: externalSelectedImages,
	setSelectedImages: externalSetSelectedImages,
}: UseModularInputProps) => {
	const [internalInputValue, internalSetInputValue] = useState("")
	const [internalSelectedFiles, internalSetSelectedFiles] = useState<string[]>([])
	const [internalSelectedImages, internalSetSelectedImages] = useState<string[]>([])

	const inputValue = externalInputValue !== undefined ? externalInputValue : internalInputValue
	const setInputValue = externalSetInputValue !== undefined ? externalSetInputValue : internalSetInputValue
	const selectedFiles = externalSelectedFiles !== undefined ? externalSelectedFiles : internalSelectedFiles
	const setSelectedFiles = externalSetSelectedFiles !== undefined ? externalSetSelectedFiles : internalSetSelectedFiles
	const selectedImages = externalSelectedImages !== undefined ? externalSelectedImages : internalSelectedImages
	const setSelectedImages =
		externalSetSelectedImages !== undefined ? externalSetSelectedImages : internalSetSelectedImages

	const [cursorPosition, setCursorPosition] = useState(0)
	const [isFocused, setIsFocused] = useState(false)
	const textAreaRef = useRef<HTMLTextAreaElement>(null)

	const context = useMemo<ModularInputContext>(
		() => ({
			inputValue,
			setInputValue,
			cursorPosition,
			setCursorPosition,
			isFocused,
			setIsFocused,
			textAreaRef,
			selectedFiles,
			setSelectedFiles,
			selectedImages,
			setSelectedImages,
		}),
		[inputValue, cursorPosition, isFocused, selectedFiles, selectedImages]
	)

	// Initialize traits
	useEffect(() => {
		traits.forEach((trait) => trait.attach?.(context))
	}, [traits, context])

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			for (const trait of traits) {
				if (trait.onKeyDown?.(e, context)) {
					return true
				}
			}
			return false
		},
		[traits, context]
	)

	const handleInputChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = e.target.value
			const newPos = e.target.selectionStart || 0
			setInputValue(newValue)
			setCursorPosition(newPos)

			traits.forEach((trait) => trait.onInputChange?.(newValue, newPos, context))
		},
		[traits, context]
	)

	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			traits.forEach((trait) => trait.onPaste?.(e, context))
		},
		[traits, context]
	)

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			traits.forEach((trait) => trait.onDrop?.(e, context))
		},
		[traits, context]
	)

	const updateCursorPosition = useCallback(() => {
		if (textAreaRef.current) {
			setCursorPosition(textAreaRef.current.selectionStart || 0)
		}
	}, [])

	return {
		context,
		handleKeyDown,
		handleInputChange,
		handlePaste,
		handleDrop,
		updateCursorPosition,
	}
}
