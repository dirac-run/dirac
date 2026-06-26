import { DiffDecorator } from "./DiffDecorator"
import { TerminalDecorator } from "./TerminalDecorator"
import { HookDecorator } from "./HookDecorator"
import { SearchDecorator } from "./SearchDecorator"
import { BugReportDecorator } from "./BugReportDecorator"
import { CompletionDecorator } from "./CompletionDecorator"
import { CardDecorator } from "./types"

export const CARD_DECORATORS: CardDecorator[] = [
	DiffDecorator,
	TerminalDecorator,
	HookDecorator,
	SearchDecorator,
	BugReportDecorator,
	CompletionDecorator,
]

export * from "./types"
