import { MouseEvent, useCallback, useRef, useState } from "react"
import { QuoteButtonState } from "../types"

export const useQuoteLogic = (onSetQuote: (text: string) => void) => {
	const [quoteButtonState, setQuoteButtonState] = useState<QuoteButtonState>({
		visible: false,
		top: 0,
		left: 0,
		selectedText: "",
	})
	const contentRef = useRef<HTMLDivElement>(null)

	const handleQuoteClick = useCallback(() => {
		onSetQuote(quoteButtonState.selectedText)
		window.getSelection()?.removeAllRanges() // Clear the browser selection
		setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
	}, [onSetQuote, quoteButtonState.selectedText])

	const handleMouseUp = useCallback((event: MouseEvent<HTMLDivElement>) => {
		const targetElement = event.target as Element
		const isClickOnButton = !!targetElement.closest(".quote-button-class")

		setTimeout(() => {
			const selection = window.getSelection()
			const selectedText = selection?.toString().trim() ?? ""

			let shouldShowButton = false
			let buttonTop = 0
			let buttonLeft = 0
			let textToQuote = ""

			if (selectedText && contentRef.current && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
				const range = selection.getRangeAt(0)
				const rangeRect = range.getBoundingClientRect()
				const containerRect = contentRef.current?.getBoundingClientRect()

				if (containerRect) {
					const tolerance = 5
					const isSelectionWithin =
						rangeRect.top >= containerRect.top &&
						rangeRect.left >= containerRect.left &&
						rangeRect.bottom <= containerRect.bottom + tolerance &&
						rangeRect.right <= containerRect.right

					if (isSelectionWithin) {
						shouldShowButton = true
						const buttonHeight = 30
						buttonTop = rangeRect.top - containerRect.top - buttonHeight - 5
						buttonLeft = Math.max(0, rangeRect.left - containerRect.left)
						textToQuote = selectedText
					}
				}
			}

			if (shouldShowButton) {
				setQuoteButtonState({
					visible: true,
					top: buttonTop,
					left: buttonLeft,
					selectedText: textToQuote,
				})
			} else if (!isClickOnButton) {
				setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
			}
		}, 0)
	}, [])

	return {
		quoteButtonState,
		handleQuoteClick,
		handleMouseUp,
		contentRef,
	}
}
