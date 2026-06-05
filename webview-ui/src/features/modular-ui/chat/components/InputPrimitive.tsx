import React, { forwardRef } from "react"
import DynamicTextArea from "react-textarea-autosize"
import { cn } from "@/lib/utils"

interface InputPrimitiveProps {
	value: string
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
	onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
	onFocus?: () => void
	onBlur?: () => void
	onPaste?: (e: React.ClipboardEvent) => void
	onHeightChange?: (height: number) => void
	onScroll?: () => void
	onSelect?: () => void
	placeholder?: string
	className?: string
	style?: React.CSSProperties
	autoFocus?: boolean
	maxRows?: number
	minRows?: number
	"data-testid"?: string
}

export const InputPrimitive = forwardRef<HTMLTextAreaElement, InputPrimitiveProps>(
	(
		{
			value,
			onChange,
			onKeyDown,
			onFocus,
			onBlur,
			onPaste,
			onHeightChange,
			onScroll,
			onSelect,
			placeholder,
			className,
			style,
			autoFocus = true,
			maxRows = 10,
			minRows = 3,
			"data-testid": dataTestId,
		},
		ref,
	) => {
		return (
			<DynamicTextArea
				ref={ref}
				value={value}
				onChange={onChange}
				onKeyDown={onKeyDown}
				onFocus={onFocus}
				onBlur={onBlur}
				onPaste={onPaste}
				onHeightChange={onHeightChange}
				onScroll={onScroll}
				onSelect={onSelect}
				placeholder={placeholder}
				autoFocus={autoFocus}
				maxRows={maxRows}
				minRows={minRows}
				data-testid={dataTestId}
				className={cn(
					"w-full box-border bg-transparent text-(--vscode-input-foreground) rounded-(--radius-input) resize-none overflow-x-hidden overflow-y-scroll scrollbar-none vscode-editor-font focus:outline-none",
					className,
				)}
				style={style as any}
			/>
		)
	},
)
