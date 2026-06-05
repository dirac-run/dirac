import { useCallback } from "react"
import { StateServiceClient } from "@/shared/api/grpc-client"
import { PlanActMode, TogglePlanActModeRequest } from "@shared/proto/dirac/state"
import { InputTrait, ModularInputContext } from "../types"

export const useModeTrait = (mode: "plan" | "act"): InputTrait & {
	onModeToggle: (context: ModularInputContext) => void
} => {
	const onModeToggle = useCallback(
		async (context: ModularInputContext) => {
			const {
				inputValue,
				setInputValue,
				selectedImages,
				setSelectedImages,
				selectedFiles,
				setSelectedFiles,
				textAreaRef,
			} = context

			const convertedProtoMode = mode === "plan" ? PlanActMode.ACT : PlanActMode.PLAN
			const messageToToggle = inputValue.trim()

			try {
				const response = await StateServiceClient.togglePlanActModeProto(
					TogglePlanActModeRequest.create({
						mode: convertedProtoMode,
						chatContent: {
							message: messageToToggle || undefined,
							images: selectedImages,
							files: selectedFiles,
						},
					})
				)

				if (response.value) {
					setInputValue("")
					setSelectedImages([])
					setSelectedFiles([])
				}
			} catch (error) {
				console.error("[useModeTrait] Failed to toggle mode:", error)
			} finally {
				setTimeout(() => {
					textAreaRef.current?.focus()
				}, 100)
			}
		},
		[mode]
	)

	// Note: useShortcut needs to be called in a component, so we might need to handle it differently
	// or pass the context to it. For now, we'll just return the toggle function.

	return {
		id: "mode",
		onModeToggle: (context: ModularInputContext) => onModeToggle(context),
		attach: (context: ModularInputContext) => {
			// We can't easily use useShortcut here because it's a hook and attach is called in useEffect
		},
	}
}
