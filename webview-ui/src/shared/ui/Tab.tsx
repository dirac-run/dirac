import React, { forwardRef, HTMLAttributes, useCallback } from "react"

type TabProps = HTMLAttributes<HTMLDivElement>

export const Tab = ({ className, children, ...props }: TabProps) => (
	<div className={`fixed inset-0 flex flex-col ${className}`} {...props}>
		{children}
	</div>
)

export const TabHeader = ({ className, children, ...props }: TabProps) => (
	<div className={`px-5 py-2.5 border-b border-(--vscode-panel-border) ${className || ""}`} {...props}>
		{children}
	</div>
)

export const TabContent = ({ className, children, ...props }: TabProps) => (
	<div className={`flex-1 overflow-auto ${className || ""}`} {...props}>
		{children}
	</div>
)

export const TabList = forwardRef<
	HTMLDivElement,
	HTMLAttributes<HTMLDivElement> & {
		value: string
		onValueChange: (value: string) => void
	}
>(({ children, className, value, onValueChange, onKeyDown, ...props }, ref) => {
	const handleTabSelect = useCallback((tabValue: string) => onValueChange(tabValue), [onValueChange])
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			onKeyDown?.(event)
			if (event.defaultPrevented) return
			const orientation = props["aria-orientation"] || "horizontal"
			const previousKey = orientation === "vertical" ? "ArrowUp" : "ArrowLeft"
			const nextKey = orientation === "vertical" ? "ArrowDown" : "ArrowRight"
			if (![previousKey, nextKey, "Home", "End"].includes(event.key)) return

			const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'))
			if (tabs.length === 0) return
			const currentIndex = tabs.findIndex((tab) => tab === document.activeElement)
			let nextIndex = currentIndex < 0 ? 0 : currentIndex
			if (event.key === previousKey) nextIndex = (nextIndex - 1 + tabs.length) % tabs.length
			if (event.key === nextKey) nextIndex = (nextIndex + 1) % tabs.length
			if (event.key === "Home") nextIndex = 0
			if (event.key === "End") nextIndex = tabs.length - 1
			event.preventDefault()
			tabs[nextIndex].focus()
			tabs[nextIndex].click()
		},
		[onKeyDown, props],
	)

	return (
		<div className={`flex ${className || ""}`} onKeyDown={handleKeyDown} ref={ref} role="tablist" {...props}>
			{React.Children.map(children, (child) =>
				React.isValidElement(child)
					? React.cloneElement(child as React.ReactElement<any>, {
							isSelected: child.props.value === value,
							onSelect: () => handleTabSelect(child.props.value),
						})
					: child,
			)}
		</div>
	)
})

export const TabTrigger = forwardRef<
	HTMLButtonElement,
	React.ButtonHTMLAttributes<HTMLButtonElement> & {
		value: string
		isSelected?: boolean
		onSelect?: () => void
	}
>(({ children, className, value, isSelected, onSelect, ...props }, ref) => {
	// Ensure we're using the value prop correctly
	return (
		<button
			aria-selected={isSelected}
			className={`focus:outline-none ${className}`}
			data-value={value}
			onClick={onSelect}
			ref={ref}
			role="tab"
			tabIndex={isSelected ? 0 : -1} // Add data-value attribute for debugging
			{...props}>
			{children}
		</button>
	)
})
