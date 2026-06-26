// Shared types for slash-command parsing and execution.

type FileBasedWorkflow = {
	fullPath: string
	fileName: string
	isRemote: false
}

type RemoteWorkflow = {
	fullPath: string
	fileName: string
	isRemote: true
	contents: string
}

export type Workflow = FileBasedWorkflow | RemoteWorkflow

export type ParseSlashCommandResult = {
	processedText: string
	needsDiracrulesFileCheck: boolean
	isDirectResponse?: boolean
	directResponseText?: string
}

export type SlashCommandMatch = {
	commandName: string
	tagContent: string
	contentStartIndex: number
	slashMatch: RegExpExecArray
	regexObj: RegExp
}
