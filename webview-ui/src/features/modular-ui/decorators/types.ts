import { Card } from "@shared/ExtensionMessage"
import React from "react"

export interface CardDecorator {
	id: string
	/** Determines if this decorator should be applied to the given card */
	shouldApply: (card: Card) => boolean
	/** Optional extra elements to render in the card header (e.g., action buttons) */
	renderHeaderActions?: (card: Card, onAction?: (value: string) => void) => React.ReactNode
	/** Optional wrapper for the card body (e.g., for auto-scroll or specialized layout) */
	renderBodyWrapper?: (card: Card, children: React.ReactNode) => React.ReactNode
	/** Prevents the generic in-card action footer from rendering. */
	suppressDefaultActions?: boolean
	/** Optional extra elements to render below the card body */
	renderFooterExtra?: (card: Card) => React.ReactNode
}
