import React, { useCallback } from "react"
import { FileServiceClient } from "@/shared/api/grpc-client"
import { RelativePathsRequest } from "@shared/proto/dirac/file"
import { CHAT_CONSTANTS } from "../constants"
import { InputTrait, ModularInputContext } from "../types"

const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS

const getImageDimensions = (dataUrl: string): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => {
			if (img.naturalWidth > 7500 || img.naturalHeight > 7500) {
				reject(new Error("Image dimensions exceed maximum allowed size of 7500px."))
			} else {
				resolve({ width: img.naturalWidth, height: img.naturalHeight })
			}
		}
		img.onerror = (err) => {
			console.error("Failed to load image for dimension check:", err)
			reject(new Error("Failed to load image to check dimensions."))
		}
		img.src = dataUrl
	})
}

export const useFileHandlingTrait = (): InputTrait => {
	const readImageFiles = useCallback(async (imageFiles: File[], context: ModularInputContext): Promise<(string | null)[]> => {
		return Promise.all(
			imageFiles.map(
				(file) =>
					new Promise<string | null>((resolve) => {
						const reader = new FileReader()
						reader.onloadend = async () => {
							if (reader.error) {
								console.error("Error reading file:", reader.error)
								resolve(null)
							} else {
								const result = reader.result
								if (typeof result === "string") {
									try {
										await getImageDimensions(result)
										resolve(result)
									} catch (error) {
										console.warn((error as Error).message)
										// In a real implementation, we would show an error message to the user
										resolve(null)
									}
								} else {
									resolve(null)
								}
							}
						}
						reader.readAsDataURL(file)
					}),
			),
		)
	}, [])

	const onPaste = async (e: React.ClipboardEvent, context: ModularInputContext) => {
		const { inputValue, setInputValue, cursorPosition, setCursorPosition, selectedImages, setSelectedImages, selectedFiles } =
			context
		const items = e.clipboardData.items
		const acceptedTypes = ["png", "jpeg", "webp", "gif"]
		const imageItems = Array.from(items).filter((item) => {
			const [type, subtype] = item.type.split("/")
			return type === "image" && acceptedTypes.includes(subtype)
		})

		if (imageItems.length > 0) {
			e.preventDefault()
			const imagePromises = imageItems.map((item) => {
				const blob = item.getAsFile()
				if (!blob) return Promise.resolve(null)
				return new Promise<string | null>((resolve) => {
					const reader = new FileReader()
					reader.onloadend = async () => {
						if (reader.error) {
							resolve(null)
						} else {
							const result = reader.result
							if (typeof result === "string") {
								try {
									await getImageDimensions(result)
									resolve(result)
								} catch (error) {
									resolve(null)
								}
							} else {
								resolve(null)
							}
						}
					}
					reader.readAsDataURL(blob)
				})
			})

			const imageDataArray = await Promise.all(imagePromises)
			const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

			if (dataUrls.length > 0) {
				const filesAndImagesLength = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

				if (availableSlots > 0) {
					const imagesToAdd = Math.min(dataUrls.length, availableSlots)
					setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
				}
			}
			return
		}

		const pastedText = e.clipboardData.getData("text")
		const urlRegex = /^\S+:\/\/\S+$/
		if (urlRegex.test(pastedText.trim())) {
			e.preventDefault()
			const trimmedUrl = pastedText.trim()
			const newValue = inputValue.slice(0, cursorPosition) + trimmedUrl + " " + inputValue.slice(cursorPosition)
			setInputValue(newValue)
			const newCursorPosition = cursorPosition + trimmedUrl.length + 1
			setCursorPosition(newCursorPosition)

			setTimeout(() => {
				context.textAreaRef.current?.focus()
				context.textAreaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
			}, 0)
		}
	}

	const onDrop = async (e: React.DragEvent, context: ModularInputContext) => {
		e.preventDefault()
		const { inputValue, setInputValue, cursorPosition, setCursorPosition, selectedImages, setSelectedImages, selectedFiles } =
			context

		// VSCode Explorer Drop Handling
		let uris: string[] = []
		const resourceUrlsData = e.dataTransfer.getData("resourceurls")
		const vscodeUriListData = e.dataTransfer.getData("application/vnd.code.uri-list")

		if (resourceUrlsData) {
			try {
				uris = JSON.parse(resourceUrlsData)
				uris = uris.map((uri) => decodeURIComponent(uri))
			} catch (error) {
				console.error("Failed to parse resourceurls JSON:", error)
			}
		}

		if (uris.length === 0 && vscodeUriListData) {
			uris = vscodeUriListData.split("\n").map((uri) => uri.trim())
		}

		const validUris = uris.filter(
			(uri) => uri && (uri.startsWith("vscode-file:") || uri.startsWith("file:") || uri.startsWith("vscode-remote:")),
		)

		if (validUris.length > 0) {
			try {
				const response = await FileServiceClient.getRelativePaths(RelativePathsRequest.create({ uris: validUris }))
				if (response.paths.length > 0) {
					// In the modular version, we might want to handle pending insertions differently
					// For now, let's just insert them at the cursor
					let currentText = inputValue
					let currentPos = cursorPosition
					for (const path of response.paths) {
						const mentionText = `@${path} `
						currentText = currentText.slice(0, currentPos) + mentionText + currentText.slice(currentPos)
						currentPos += mentionText.length
					}
					setInputValue(currentText)
					setCursorPosition(currentPos)
				}
			} catch (error) {
				console.error("Error getting relative paths:", error)
			}
			return
		}

		const text = e.dataTransfer.getData("text")
		if (text) {
			const newValue = inputValue.slice(0, cursorPosition) + text + inputValue.slice(cursorPosition)
			setInputValue(newValue)
			const newCursorPosition = cursorPosition + text.length
			setCursorPosition(newCursorPosition)
			return
		}

		const files = Array.from(e.dataTransfer.files)
		const acceptedTypes = ["png", "jpeg", "webp"]
		const imageFiles = files.filter((file) => {
			const [type, subtype] = file.type.split("/")
			return type === "image" && acceptedTypes.includes(subtype)
		})

		if (imageFiles.length > 0) {
			const imageDataArray = await readImageFiles(imageFiles, context)
			const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

			if (dataUrls.length > 0) {
				const filesAndImagesLength = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

				if (availableSlots > 0) {
					const imagesToAdd = Math.min(dataUrls.length, availableSlots)
					setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
				}
			}
		}
	}

	return {
		id: "file-handling",
		onPaste,
		onDrop,
	}
}
