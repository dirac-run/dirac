// Mock implementation of VSCode API for unit tests
export const env = {
	machineId: "test-machine-id",
	isTelemetryEnabled: true,
	onDidChangeTelemetryEnabled: (_callback: (enabled: boolean) => void) => {
		// Return a disposable mock
		return {
			dispose: () => {},
		}
	},
}

export const workspace = {
	getConfiguration: (section?: string) => {
		return {
			get: (key: string, defaultValue?: any) => {
				// Return default values for common configuration keys
				if (section === "dirac" && key === "telemetrySetting") {
					return "enabled"
				}
				if (section === "telemetry" && key === "telemetryLevel") {
					return "all"
				}
				return defaultValue
			},
		}
	},
	textDocuments: [] as any[],
	openTextDocument: async (uriOrOptions?: any) => {
		const uri = typeof uriOrOptions === "string" ? Uri.file(uriOrOptions) : uriOrOptions
		return {
			uri: uri || Uri.file("untitled:untitled"),
			fileName: uri?.fsPath || "",
			isDirty: false,
			save: async () => true,
		}
	},
	workspaceFolders: undefined as any,
	applyEdit: async (_edit: any) => true,
}

// Export other commonly used VSCode API mocks as needed
export const window = {
	showErrorMessage: (_message: string) => Promise.resolve(),
	showWarningMessage: (_message: string) => Promise.resolve(),
	showInformationMessage: (_message: string) => Promise.resolve(),
	createTextEditorDecorationType: (_options: any) => ({
		key: "mock-decoration-type",
		dispose: () => {},
	}),
	createOutputChannel: (_name: string) => ({
		appendLine: (message: string) => console.debug(message),
		append: (message: string) => console.debug(message),
		clear: () => {},
		show: () => {},
		hide: () => {},
		dispose: () => {},
	}),
	showTextDocument: async (documentOrUri: any, _options?: any) => {
		return {
			document: documentOrUri,
			selection: undefined,
			visible: true,
			dispose: () => {},
		}
	},
	tabGroups: {
		all: [] as any[],
	},
	visibleTextEditors: [] as any[],
	createWebviewPanel: (_viewType: string, _title: string, _column?: any, _options?: any) => {
		const messageListeners: ((message: any) => void)[] = []
		return {
			webview: {
				html: "",
				onDidReceiveMessage: (listener: (message: any) => void, _thisArgs?: any) => {
					messageListeners.push(listener)
					return { dispose: () => {} }
				},
			},
			visible: true,
			dispose: () => {},
		}
	},
	createTerminal: (options?: any) => ({
		name: options?.name || "Dirac",
		sendText: (_text: string, _addNewLine?: boolean) => {},
		show: (_preserveFocus?: boolean) => {},
		hide: () => {},
		dispose: () => {},
		processId: Promise.resolve(1234),
		creationOptions: options || {},
		exitStatus: undefined,
		shellIntegration: undefined,
		state: 1,
	}),
	onDidChangeTerminalState: (_callback: any) => ({ dispose: () => {} }),
}

export const commands = {
	executeCommand: (_command: string, ..._args: any[]) => Promise.resolve(),
}

export const Uri = {
	file: (filePath: string) => ({ fsPath: filePath, toString: () => filePath }),
	parse: (uri: string) => ({ fsPath: uri, toString: () => uri }),
	joinPath: (...parts: any[]) => {
		const base = parts[0]?.fsPath || ""
		const segments = parts.slice(1).map((p: any) => (typeof p === "string" ? p : p?.fsPath || ""))
		const joined = [base, ...segments].filter(Boolean).join("/")
		return { fsPath: joined, toString: () => joined }
	},
}

export const ExtensionContextMock = {}
export const StatusBarAlignmentMock = { Left: 1, Right: 2 }
export const ViewColumnMock = { One: 1, Two: 2, Three: 3 }

// ViewColumn enum (also exported as ViewColumnMock for backward compat)
export enum ViewColumn {
	One = 1,
	Two = 2,
	Three = 3,
}

// Position and Range
export class Position {
	constructor(
		public line: number,
		public character: number,
	) {}
}

export class Range {
	public start: Position
	public end: Position
	constructor(startLineOrStart: number | Position, startCharOrEnd: number | Position, endLine?: number, endChar?: number) {
		if (typeof startLineOrStart === "number") {
			this.start = new Position(startLineOrStart, startCharOrEnd as number)
			this.end = new Position(endLine!, endChar!)
		} else {
			this.start = startLineOrStart as Position
			this.end = startCharOrEnd as Position
		}
	}
}

// Diagnostic types
export enum DiagnosticSeverity {
	Error = 0,
	Warning = 1,
	Information = 2,
	Hint = 3,
}

export class Diagnostic {
	constructor(
		public range: Range,
		public message: string,
		public severity: DiagnosticSeverity = DiagnosticSeverity.Error,
	) {}
	public source: string | undefined
}

// Language Model API types
export enum LanguageModelChatMessageRole {
	User = 1,
	Assistant = 2,
}

export class LanguageModelTextPart {
	constructor(public value: string) {}
}

export class LanguageModelToolCallPart {
	constructor(
		public callId: string,
		public name: string,
		public input: object,
	) {}
}

export class LanguageModelToolResultPart {
	constructor(
		public callId: string,
		public content: Array<LanguageModelTextPart>,
	) {}
}

export class LanguageModelChatMessage {
	role: LanguageModelChatMessageRole
	content: Array<LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart>
	name: string | undefined

	constructor(
		role: LanguageModelChatMessageRole,
		content: string | Array<LanguageModelTextPart | LanguageModelToolResultPart | LanguageModelToolCallPart>,
		name?: string,
	) {
		this.role = role
		this.name = name
		if (typeof content === "string") {
			this.content = [new LanguageModelTextPart(content)]
		} else {
			this.content = content
		}
	}

	static User(
		content: string | Array<LanguageModelTextPart | LanguageModelToolResultPart>,
		name?: string,
	): LanguageModelChatMessage {
		return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content as any, name)
	}

	static Assistant(
		content: string | Array<LanguageModelTextPart | LanguageModelToolCallPart>,
		name?: string,
	): LanguageModelChatMessage {
		return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content as any, name)
	}
}

// WorkspaceEdit
export class WorkspaceEdit {
	private edits: Map<string, any[]> = new Map()

	insert(_uri: any, _position: Position, _content: string) {
		// no-op mock
	}
}

// TabInputText
export class TabInputText {
	constructor(public uri: any) {}
}

// CancellationTokenSource
export class CancellationTokenSource {
	token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }
	cancel() {}
	dispose() {}
}

// Extensions namespace
export const extensions = {
	getExtension: (_id: string) => undefined,
}
