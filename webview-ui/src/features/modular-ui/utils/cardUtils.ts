import { CardStatus } from "@shared/ExtensionMessage"

export const truncateHeader = (header: string) => {
	return header
}

export const getStatusTextColorClass = (status: CardStatus) => {
	switch (status) {
		case CardStatus.SUCCESS:
			return "text-success"
		case CardStatus.ERROR:
			return "text-error"
		case CardStatus.RUNNING:
			return "text-link"
		case CardStatus.WAITING_FOR_INPUT:
			return "text-warning"
		default:
			return "text-muted-foreground"
	}
}
