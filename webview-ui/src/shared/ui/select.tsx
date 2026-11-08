"use client"

import * as SelectPrimitive from "@radix-ui/react-select"
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
	return <SelectPrimitive.Root data-slot="select" {...props} />
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
	return <SelectPrimitive.Group data-slot="select-group" {...props} />
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
	return <SelectPrimitive.Value data-slot="select-value" {...props} />
}

function SelectTrigger({
	className,
	size = "default",
	showIcon = true,
	children,
	...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
	size?: "sm" | "default"
	showIcon?: boolean
}) {
	return (
		<SelectPrimitive.Trigger
			className={cn(
				"border-(--vscode-dropdown-border) bg-(--vscode-dropdown-background) text-(--vscode-dropdown-foreground) data-[placeholder]:text-input-placeholder focus-visible:outline focus-visible:outline-1 focus-visible:outline-(--vscode-focusBorder) aria-invalid:border-error flex min-w-0 w-fit items-center justify-between gap-2 rounded-sm border px-2 py-1 text-sm whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50 data-[size=default]:h-9 data-[size=sm]:h-7 *:data-[slot=select-value]:truncate *:data-[slot=select-value]:min-w-0 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className,
			)}
			data-size={size}
			data-slot="select-trigger"
			{...props}>
			{children}
			{showIcon && (
				<SelectPrimitive.Icon asChild>
					<ChevronDownIcon className="size-4 opacity-50" />
				</SelectPrimitive.Icon>
			)}
		</SelectPrimitive.Trigger>
	)
}

function SelectContent({
	className,
	children,
	position = "popper",
	align = "center",
	...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
	return (
		<SelectPrimitive.Portal>
			<SelectPrimitive.Content
				align={align}
				className={cn(
					"bg-(--vscode-dropdown-background) text-(--vscode-dropdown-foreground) relative z-50 max-h-(--radix-select-content-available-height) max-w-[calc(100vw-16px)] min-w-[8rem] overflow-hidden rounded-sm border border-(--vscode-dropdown-border) shadow-md",
					position === "popper" &&
						"data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
					className,
				)}
				data-slot="select-content"
				position={position}
				{...props}>
				<SelectScrollUpButton />
				<SelectPrimitive.Viewport
					className={cn(
						"p-1",
						position === "popper" && "w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1",
					)}>
					{children}
				</SelectPrimitive.Viewport>
				<SelectScrollDownButton />
			</SelectPrimitive.Content>
		</SelectPrimitive.Portal>
	)
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
	return (
		<SelectPrimitive.Label
			className={cn("text-input-placeholder/80 px-2 py-1 text-sm", className)}
			data-slot="select-label"
			{...props}
		/>
	)
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
	return (
		<SelectPrimitive.Item
			className={cn(
				"focus:bg-(--vscode-list-activeSelectionBackground) focus:text-(--vscode-list-activeSelectionForeground) relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-sm py-1 pr-7 pl-2 text-xs outline-hidden select-none break-words data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
				className,
			)}
			data-slot="select-item"
			{...props}>
			<span className="absolute right-2 flex size-3.5 items-center justify-center" data-slot="select-item-indicator">
				<SelectPrimitive.ItemIndicator>
					<CheckIcon className="size-3.5" />
				</SelectPrimitive.ItemIndicator>
			</span>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	)
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
	return (
		<SelectPrimitive.Separator
			className={cn("bg-editor-group-border pointer-events-none -mx-1 my-1 h-px", className)}
			data-slot="select-separator"
			{...props}
		/>
	)
}

function SelectScrollUpButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
	return (
		<SelectPrimitive.ScrollUpButton
			className={cn("flex cursor-default items-center justify-center py-1", className)}
			data-slot="select-scroll-up-button"
			{...props}>
			<ChevronUpIcon className="size-4" />
		</SelectPrimitive.ScrollUpButton>
	)
}

function SelectScrollDownButton({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
	return (
		<SelectPrimitive.ScrollDownButton
			className={cn("flex cursor-default items-center justify-center py-1", className)}
			data-slot="select-scroll-down-button"
			{...props}>
			<ChevronDownIcon className="size-4" />
		</SelectPrimitive.ScrollDownButton>
	)
}

export {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectScrollDownButton,
	SelectScrollUpButton,
	SelectSeparator,
	SelectTrigger,
	SelectValue,
}
