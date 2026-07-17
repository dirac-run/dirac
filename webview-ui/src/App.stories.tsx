import { HeroUIProvider } from "@heroui/react"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { type ApiConfiguration, bedrockModels } from "@shared/api"
import { DiracMessageType, CardStatus } from "@shared/ExtensionMessage"
import type { DiracMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useMemo, useState } from "react"
import { useAppStore } from "@/app/store/appStore"
import ChatView from "@/features/chat/components/ChatView/ChatView"
import { useSettingsStore } from "@/features/settings/store/settingsStore"

// Mock component that mimics App behavior but works in Storybook
const MockApp = () => {
	const { showAnnouncement } = useAppStore()

	return (
		<HeroUIProvider>
			<ChatView
				hideAnnouncement={() => {}}
				isHidden={false}
				showAnnouncement={showAnnouncement}
				showHistoryView={() => {}}
			/>
		</HeroUIProvider>
	)
}

// Constants
const SIDEBAR_CLASS = "flex flex-col justify-center h-[60%] w-[80%] overflow-hidden"
const ExtensionStateProviderMock = ({ children, value }: { children: React.ReactNode; value: any }) => {
	useEffect(() => {
		useSettingsStore.getState().setSettings(value)
	}, [value])
	return <>{children}</>
}

const meta: Meta<typeof MockApp> = {
	title: "Views/Chat",
	component: MockApp,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: {
				component: `
The ChatView component is the main interface for interacting with Dirac. It provides a comprehensive chat experience with AI assistance, task management, and various tools.

**Key Features:**
- **Task Management**: Create, resume, and manage AI-assisted tasks
- **Message History**: View conversation history with rich formatting
- **File & Image Support**: Attach files and images to messages
- **Tool Integration**: Execute commands, browse files, and use various tools
- **Auto-approval**: Configure automatic approval for certain actions
- **Streaming Responses**: Real-time AI response streaming
- **Context Management**: Intelligent conversation context handling
- **Plan/Act Modes**: Separate planning and execution phases
- **Browser Automation**: Automated browser interactions
- **Checkpoint System**: Save and restore conversation states

**Use Cases:**
- Software development assistance
- Code review and refactoring
- File system operations
- Web browsing and research
- Task automation
- Overall- Learning and exploration

**Note**: In Storybook, some features like file operations, command execution, and API calls are mocked for demonstration purposes.
		`,
			},
		},
	},
	decorators: [
		(Story) => (
			<div className="w-full h-full flex justify-center items-center overflow-hidden">
				<div className={SIDEBAR_CLASS}>
					<Story />
				</div>
			</div>
		),
	],
}

export default meta
type Story = StoryObj<typeof MockApp>

// Mock data factories
const createApiConfig = (overrides: Partial<ApiConfiguration> = {}): ApiConfiguration => ({
	actModeApiProvider: "anthropic",
	actModeApiModelId: "claude-3-5-sonnet-20241022",
	actModeOpenRouterModelInfo: {
		maxTokens: 8000,
		contextWindow: 200000,
		supportsPromptCache: true,
	},
	apiKey: "mock-key",
	...overrides,
})

const mockApiConfiguration = createApiConfig()
const mockApiConfigurationPlan = createApiConfig({
	planModeApiProvider: "anthropic",
	planModeApiModelId: "claude-3-5-sonnet-20241022",
})

const createHistoryItem = (id: string, hoursAgo: number, task: string, metrics: Partial<HistoryItem> = {}): HistoryItem => ({
	id,
	ulid: "01HZZZ1A1B2C3D4E5F6G7H8J9K",
	ts: Date.now() - hoursAgo * 3600000,
	task,
	tokensIn: 2500,
	tokensOut: 1200,
	cacheWrites: 350,
	cacheReads: 180,
	totalCost: 0.085,
	size: 123456,
	...metrics,
})

const mockTaskHistory: HistoryItem[] = [
	createHistoryItem("task-1", 1, "Create a React component for displaying user profiles"),
	createHistoryItem("task-2", 2, "Debug the authentication flow in the login system", {
		tokensIn: 3200,
		tokensOut: 1800,
		cacheWrites: 450,
		cacheReads: 220,
		totalCost: 0.125,
		size: 1234567,
	}),
	createHistoryItem("task-3", 24, "Optimize database queries for better performance", {
		tokensIn: 4500,
		tokensOut: 2400,
		cacheWrites: 680,
		cacheReads: 340,
		totalCost: 0.185,
		size: 12345678,
	}),
]

const createMessage = (
	minutesAgo: number,
	type: DiracMessageType,
	content: string,
	overrides: Partial<DiracMessage> = {},
): DiracMessage => ({
	id: Math.random().toString(36).substring(7),
	ts: Date.now() - minutesAgo * 60000,
	content: {
		type,
		content,
	} as any,
	...overrides,
})

const createCardMessage = (
	minutesAgo: number,
	header: string,
	body: string,
	status: CardStatus = CardStatus.SUCCESS,
	overrides: Partial<DiracMessage> = {},
): DiracMessage => ({
	id: Math.random().toString(36).substring(7),
	ts: Date.now() - minutesAgo * 60000,
	content: {
		type: DiracMessageType.CARD,
		card: {
			id: Math.random().toString(36).substring(7),
			header,
			body,
			status,
			renderType: "markdown",
		},
	},
	...overrides,
})

const createApiReqMessage = (minutesAgo: number, request: string, metrics: any = {}): DiracMessage => ({
	id: Math.random().toString(36).substring(7),
	ts: Date.now() - minutesAgo * 60000,
	content: {
		type: DiracMessageType.API_STATUS,
		status: {
			request,
			tokensIn: 19500,
			tokensOut: 4220,
			cacheWrites: 120,
			cacheReads: 60,
			cost: 0.025,
			...metrics,
		},
	},
})

const createAskMessage = (header: string, body: string, status: CardStatus = CardStatus.PENDING): DiracMessage => ({
	id: Math.random().toString(36).substring(7),
	ts: Date.now() - 60000,
	content: {
		type: DiracMessageType.CARD,
		card: {
			id: Math.random().toString(36).substring(7),
			header,
			body,
			status,
			renderType: "markdown",
		},
	},
})

const mockActiveMessages: DiracMessage[] = [
	createMessage(5, DiracMessageType.MARKDOWN, "Help me create a responsive navigation component for a React application"),
	createApiReqMessage(4.9, "Initial analysis request"),
	createMessage(
		4.7,
		DiracMessageType.MARKDOWN,
		"I'll help you create a responsive navigation component for your React application. Let me start by examining your current project structure and then create a modern, accessible navigation component.",
	),
	createCardMessage(4.3, "listFilesTopLevel", "src/components"),
	createCardMessage(
		4.2,
		"listFilesTopLevel",
		"Contents of src/components:\n2 out of 2 elements listed below:\nNavigation/\nUserProfile/\n\n====================\n\nContents of src/utils:\n1 out of 1 elements listed below:\nmath.ts",
	),
	createApiReqMessage(4.2, "Component creation request", { tokensIn: 12020, tokensOut: 6180, cost: 0.042 }),
	createMessage(
		4,
		DiracMessageType.MARKDOWN,
		"Based on your project structure, I'll create a responsive navigation component with the following features:\n\n- Mobile-first responsive design\n- Accessible keyboard navigation\n- Smooth animations\n- Support for nested menu items\n- Dark/light theme support",
	),
	createCardMessage(3.7, "newFileCreated", "src/components/Navigation/Navigation.tsx: // Navigation component code..."),
	createApiReqMessage(3.5, "Final response request", { tokensIn: 41550, tokensOut: 3320, cost: 0.018 }),
	createMessage(
		3.3,
		DiracMessageType.MARKDOWN,
		"I've created a responsive navigation component with TypeScript support. The component includes:\n\n✅ Mobile-first responsive design\n✅ Accessible ARIA attributes\n✅ Toggle functionality for mobile\n✅ TypeScript interfaces for type safety\n✅ Theme support\n\nWould you like me to also create the CSS styles for this component?",
	),
]

const streamingMsgId = "streaming-msg-id"
const mockStreamingMessages: DiracMessage[] = [
	...mockActiveMessages,
	createMessage(
		0.17,
		DiracMessageType.MARKDOWN,
		"Now I'll create the CSS styles for the navigation component. This will include responsive breakpoints, smooth animations, and accessibility features...",
		{ id: streamingMsgId },
	),
]

// Reusable state and decorator factories
const createMockState = (overrides: any = {}) => ({
	...useSettingsStore(),
	useAutoCondense: true,
	version: "0.0.1-stories",
	welcomeViewCompleted: true,
	showWelcome: false,
	diracMessages: mockActiveMessages,
	taskHistory: mockTaskHistory,
	apiConfiguration: mockApiConfiguration,
	onboardingModels: undefined,
	openRouterModels: bedrockModels,
	showAnnouncement: false,
	backgroundEditEnabled: false,
	activeVoiceStreamId: undefined,
	isApiRequestActive: false,
	...overrides,
})

const createStoryDecorator =
	(stateOverrides: any = {}) =>
	(Story: any) => {
		const mockState = useMemo(() => createMockState(stateOverrides), [])
		return (
			<ExtensionStateProviderMock value={mockState}>
				<div className="w-full h-full flex justify-center items-center overflow-hidden">
					<div className={SIDEBAR_CLASS}>
						<Story />
					</div>
				</div>
			</ExtensionStateProviderMock>
		)
	}

export const EmptyState: Story = {
	decorators: [createStoryDecorator({ diracMessages: [], taskHistory: [], isNewUser: true, showAnnouncement: true })],
	parameters: {
		docs: {
			description: {
				story: "Shows the empty state for first-time users with no conversation history or active tasks.",
			},
		},
	},
}

export const ReturnUser: Story = {
	decorators: [
		createStoryDecorator({ diracMessages: [], taskHistory: mockTaskHistory, isNewUser: true, showAnnouncement: false }),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows the home screen populated with conversation history for returning users.",
			},
		},
	},
}

export const ActiveConversation: Story = {
	decorators: [createStoryDecorator({ task: mockTaskHistory[0], currentTaskItem: mockTaskHistory[0] })],
	parameters: {
		docs: {
			description: {
				story: "An active conversation showing a typical interaction with Dirac, including task creation, tool usage, and AI responses.",
			},
		},
	},
}

export const StreamingResponse: Story = {
	decorators: [createStoryDecorator({ diracMessages: mockStreamingMessages, activeVoiceStreamId: streamingMsgId })],
	parameters: {
		docs: {
			description: {
				story: "Shows a streaming response in progress, demonstrating real-time AI response rendering.",
			},
		},
	},
}

const createLongMessages = (): DiracMessage[] => [
	createMessage(
		30,
		DiracMessageType.MARKDOWN,
		"Help me build a complete e-commerce application with React, Node.js, and MongoDB",
	),
	createMessage(
		29.7,
		DiracMessageType.MARKDOWN,
		"I'll help you build a complete e-commerce application. Let's start by setting up the project structure and implementing the core features step by step.",
	),
	createCardMessage(29.3, "newFileCreated", "package.json: // Package.json content..."),
	createMessage(
		29,
		DiracMessageType.MARKDOWN,
		"Great! I've set up the initial package.json. Now let's create the backend server with Express and MongoDB integration.",
	),
	createCardMessage(28.7, "newFileCreated", "server.js: // Express server code..."),
	createMessage(
		28.3,
		DiracMessageType.MARKDOWN,
		"Perfect! The backend server is set up. Now let's create the product model and routes for handling product operations.",
	),
	createCardMessage(28, "newFileCreated", "models/Product.js: // Product model code..."),
	createMessage(
		27.7,
		DiracMessageType.MARKDOWN,
		"Excellent! The Product model is ready with all necessary fields. Now let's create the React frontend with a modern component structure.",
	),
	createCardMessage(27.3, "command", "cd client && npx create-react-app . --template typescript"),
	createCardMessage(
		27,
		"command",
		"Creating a new React app... Success! Created client at /path/to/project/client",
		CardStatus.SUCCESS,
	),
	createMessage(
		26.7,
		DiracMessageType.MARKDOWN,
		"Great! The React frontend is set up with TypeScript. Now let's create the main components for our e-commerce application.",
	),
]

export const LongConversation: Story = {
	decorators: [createStoryDecorator({ diracMessages: createLongMessages() })],
	parameters: {
		docs: {
			description: {
				story: "A longer conversation showing multiple tool uses, file creation, and command execution in a complex development task.",
			},
		},
	},
}

// Optimized message patterns for common scenarios
const createErrorMessages = () => [
	createMessage(5, DiracMessageType.MARKDOWN, "Help me fix the build errors in my React application"),
	createMessage(
		4.7,
		DiracMessageType.MARKDOWN,
		"I'll help you fix the build errors. Let me first examine the current state of your application.",
	),
	createCardMessage(4.3, "command", "npm run build"),
	createCardMessage(4, "error", "Build failed with TypeScript errors in UserProfile.tsx and api.ts", CardStatus.ERROR),
	createMessage(
		3.7,
		DiracMessageType.MARKDOWN,
		"I can see there are TypeScript errors in your code. Let me examine the files and fix these issues.",
	),
	createCardMessage(3.3, "readFile", "src/components/UserProfile_1.tsx"),
	createCardMessage(3.3, "readFile", "src/components/UserProfile_2.tsx"),
	createMessage(
		3,
		DiracMessageType.MARKDOWN,
		"I found the issue. The User type doesn't have a 'username' property. Let me fix this by updating the component to use the correct property name.",
	),
]

export const ErrorState: Story = {
	decorators: [createStoryDecorator({ diracMessages: createErrorMessages() })],
	parameters: {
		docs: {
			description: {
				story: "Shows how Dirac handles and displays error messages, helping users understand and resolve issues.",
			},
		},
	},
}

export const AutoApprovalEnabled: Story = {
	decorators: [
		createStoryDecorator({
			autoApprovalSettings: {
				...DEFAULT_AUTO_APPROVAL_SETTINGS,
				enabled: true,
			},
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows the interface with auto-approval enabled, allowing Dirac to execute certain actions automatically without user confirmation.",
			},
		},
	},
}

const createPlanModeMessages = () => [
	createMessage(
		5,
		DiracMessageType.MARKDOWN,
		"Help me refactor my React application to use TypeScript and improve performance",
	),
	createApiReqMessage(4.9, "Planning analysis request", { tokensIn: 20000, tokensOut: 19500, cost: 0.065 }),
	createMessage(
		4.7,
		DiracMessageType.MARKDOWN,
		"I'll help you refactor your React application to use TypeScript and improve performance. Let me create a detailed plan for this migration.",
	),
	createApiReqMessage(4.5, "Detailed planning request", { tokensIn: 20002, tokensOut: 12500, cost: 0.095 }),
	createAskMessage(
		"plan_mode_respond",
		"Here's my comprehensive plan for refactoring your React application with TypeScript migration and performance optimization phases.\n\n\n\n\nPhase 1: TypeScript Migration\n1. Set up TypeScript in the project\n2. Rename .js files to .tsx/.ts\n3. Add type definitions for components and props\n4. Fix type errors and ensure type safety\n\nPhase 2: Performance Optimization\n1. Analyze current performance bottlenecks\n2. Implement code-splitting and lazy loading\n3. Optimize rendering with React.memo and useCallback\n4. Minimize bundle size with tree-shaking and minification\n5. Test performance improvements using profiling tools",
	),
]

export const PlanMode: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: createPlanModeMessages(),
			apiConfiguration: mockApiConfigurationPlan,
			mode: "plan" as const,
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows Dirac in Plan mode, where it focuses on creating detailed plans and discussing approaches before implementation.",
			},
		},
	},
}

const createBrowserMessages = () => [
	createMessage(5, DiracMessageType.MARKDOWN, "Help me test the login functionality on my web application"),
	createMessage(
		4.7,
		DiracMessageType.MARKDOWN,
		"I'll help you test the login functionality. Let me launch a browser and navigate to your application.",
	),
	createCardMessage(4.3, "browser_action_launch", "launch: http://localhost:3000/login"),
	createCardMessage(4, "browser_action_result", "currentUrl: http://localhost:3000/login, logs: Page loaded successfully"),
	createMessage(
		3.7,
		DiracMessageType.MARKDOWN,
		"Great! The browser has launched and navigated to your login page. Now let me test the login functionality.",
	),
	createCardMessage(3.3, "browser_action", "click: 400,200"),
	createCardMessage(3, "browser_action", "type: test@example.com"),
]

export const BrowserAutomation: Story = {
	decorators: [createStoryDecorator({ diracMessages: createBrowserMessages() })],
	parameters: {
		docs: {
			description: {
				story: "Shows Dirac performing browser automation tasks, including launching browsers, clicking elements, and testing web applications.",
			},
		},
	},
}

// Optimized stories using ask message pattern
const createToolApprovalMessages = () => [
	createMessage(5, DiracMessageType.MARKDOWN, "Help me read the configuration file"),
	createMessage(4.7, DiracMessageType.MARKDOWN, "I need to read a file to understand your configuration."),
	createAskMessage("tool", "readFile: config.json"),
]

export const ToolApproval: Story = {
	decorators: [createStoryDecorator({ diracMessages: createToolApprovalMessages() })],
	parameters: {
		docs: {
			description: {
				story: "Shows tool approval request with Approve/Reject buttons for file operations.",
			},
		},
	},
}

export const ToolSave: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createMessage(5, DiracMessageType.MARKDOWN, "Update the README file with new instructions"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "I'll update your README file with the new instructions."),
				createAskMessage("tool", "editedExistingFile: README.md"),
			],
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows file save request with Save/Reject buttons for file editing operations.",
			},
		},
	},
}

// Quick story generators for common patterns
const quickStory = (name: string, header: string, body: string, description: string): Story => ({
	decorators: [
		createStoryDecorator({
			diracMessages: [
				...createLongMessages(),
				createMessage(6, DiracMessageType.MARKDOWN, `Help with ${name.toLowerCase()}`),
				createMessage(5, DiracMessageType.MARKDOWN, `Thinking about helping user with ${name.toLowerCase()}`, {
					content: {
						type: DiracMessageType.MARKDOWN,
						content: `Thinking about helping user with ${name.toLowerCase()}`,
						isReasoning: true,
					} as any,
				}),
				createMessage(4.7, DiracMessageType.MARKDOWN, `I'll help you with ${name.toLowerCase()}.`),
				createAskMessage(header, body),
			],
		}),
	],
	parameters: { docs: { description: { story: description } } },
})

export const CommandExecution: Story = quickStory(
	"Command Execution",
	"command",
	"npm install",
	"Shows command execution request with Run Command/Reject buttons.",
)

export const CommandOutput: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createAskMessage("command", "npm install"),
				createAskMessage("command_output", "Installing packages... This may take a few minutes.", CardStatus.RUNNING),
			],
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows command output with Proceed While Running button during command execution.",
			},
		},
	},
}

// Batch create remaining optimized stories
export const ApiRequestFailed = quickStory(
	"API Request Failed",
	"api_req_failed",
	"API request failed due to network timeout. Would you like to retry?",
	"Shows error recovery options with Retry/Start New Task buttons when API requests fail.",
)

export const MistakeLimitReached = quickStory(
	"Mistake Limit",
	"mistake_limit_reached",
	"I've made several attempts to fix this issue but haven't been successful.",
	"Shows mistake limit reached state with Proceed Anyways/Start New Task options.",
)

export const CompletionResult = quickStory(
	"Task Completion",
	"completion_result",
	"Task completed successfully! I've implemented all the requested features.\n\nWould you like to start a new task?\n\n- View Changes\n- Start New Task\n- Resume Previous Task HAS_CHANGES",
	"Shows task completion state with Start New Task button.",
)

export const BrowserActionLaunch = quickStory(
	"Browser Launch",
	"browser_action_launch",
	"Launch browser to test the website at http://localhost:3000",
	"Shows browser action approval with Approve/Reject buttons for browser launch.",
)

export const Followup = quickStory(
	"Follow-up",
	"followup",
	"What would you like me to work on next?",
	"Shows followup question state where Dirac asks for next steps.",
)

export const ResumeTask = quickStory(
	"Resume Task",
	"resume_task",
	"Would you like to resume the previous task?",
	"Shows resume task option for continuing interrupted work.",
)

export const NewTaskWithContext = quickStory(
	"New Task",
	"new_task",
	"Start a new task with the current conversation context",
	"Shows new task creation with context preservation option.",
)

export const ApiRequestActive: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createMessage(5, DiracMessageType.MARKDOWN, "Processing your request...", { id: "api-req-msg-id" }),
				createApiReqMessage(4.7, "Making API request to generate response"),
			],
			isApiRequestActive: true,
		}),
	],
	parameters: { docs: { description: { story: "Shows active API request state with Cancel button available." } } },
}

export const PlanModeResponse = quickStory(
	"Plan Mode Response",
	"plan_mode_respond",
	"Here's my comprehensive plan for refactoring your React application with TypeScript migration and performance optimization phases.\n\n\n\n\nPhase 1: TypeScript Migration\n1. Set up TypeScript in the project\n2. Rename .js files to .tsx/.ts\n3. Add type definitions for components and props\n4. Fix type errors and ensure type safety\n\nPhase 2: Performance Optimization\n1. Analyze current performance bottlenecks\n2. Implement code-splitting and lazy loading\n3. Optimize rendering with React.memo and useCallback\n4. Minimize bundle size with tree-shaking and minification\n5. Test performance improvements using profiling tools",
	"Shows plan mode response where Dirac presents a detailed plan for user approval.",
)

export const CondenseConversation = quickStory(
	"Condense Conversation",
	"condense",
	"Would you like me to condense the conversation to improve performance?",
	"Shows utility action to condense conversation for better performance.",
)


export const ResumeCompletedTask = quickStory(
	"Resume Completed Task type",
	"resume_completed_task",
	"The previous task has been completed. Would you like to start a new task?",
	"Shows Start New Task option for resume completed task.",
)

export const ShellIntegrationWarningWithSuggestion: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createMessage(5, DiracMessageType.MARKDOWN, "Run a command"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "I'll run the command for you."),
				createCardMessage(4.5, "shell_integration_warning_with_suggestion", ""),
			],
			vscodeTerminalExecutionMode: "integrated",
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows shell integration warning with suggestion to enable Background Terminal mode.",
			},
		},
	},
}

export const ShellIntegrationWarningBackgroundEnabled: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createMessage(5, DiracMessageType.MARKDOWN, "Run a command"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "I'll run the command for you."),
				createCardMessage(4.5, "shell_integration_warning_with_suggestion", ""),
			],
			vscodeTerminalExecutionMode: "backgroundExec",
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows shell integration warning when Background Terminal mode is already enabled.",
			},
		},
	},
}

export const ShellIntegrationWarning: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createMessage(5, DiracMessageType.MARKDOWN, "Run a command"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "I'll run the command for you."),
				createCardMessage(4.5, "shell_integration_warning", ""),
			],
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows shell integration unavailable warning with instructions to update VSCode and select a supported shell.",
			},
		},
	},
}

export const ErrorRetryInProgress: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createMessage(5, DiracMessageType.MARKDOWN, "Process a request"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "Attempting to process your request."),
				createCardMessage(4.5, "error_retry", "Attempt 2 of 5, delay 10s", CardStatus.RUNNING),
			],
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows auto-retry in progress with attempt count and delay.",
			},
		},
	},
}

export const ErrorRetryFailed: Story = {
	decorators: [
		createStoryDecorator({
			diracMessages: [
				createMessage(5, DiracMessageType.MARKDOWN, "Process a request"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "Attempting to process your request."),
				createCardMessage(4.5, "error_retry", "Attempt 5 of 5 failed", CardStatus.ERROR),
			],
		}),
	],
	parameters: {
		docs: {
			description: {
				story: "Shows auto-retry failed after max attempts with manual intervention required.",
			},
		},
	},
}

// Diff Edit Stories - New Format
const createNewFormatMultiFileMessages = () => [
	createMessage(5, DiracMessageType.MARKDOWN, "Help me refactor the authentication module"),
	createMessage(
		4.7,
		DiracMessageType.MARKDOWN,
		"I'll help you refactor the authentication module. Let me make the necessary changes.",
	),
	createCardMessage(
		4.3,
		"editedExistingFile",
		`*** Begin Patch
*** Add File: src/auth/types.ts
+export interface User {
+  id: string
+  email: string
+  role: 'admin' | 'user'
+}
+
+export interface AuthState {
+  user: User | null
+  isAuthenticated: boolean
+}

*** Update File: src/auth/login.ts
@@
-function login(email, password) {
-  return fetch('/api/login', {
+function login(email: string, password: string): Promise<AuthState> {
+  return fetch('/api/login', {
 	 method: 'POST',
-    body: { email, password }
+    body: JSON.stringify({ email, password }),
+    headers: { 'Content-Type': 'application/json' }
   })
 }
@@
-export default login
+export { login }

*** Delete File: src/auth/old-utils.js
-function deprecatedHelper() {
-  console.log('This is deprecated')
-}
-
-module.exports = { deprecatedHelper }
*** End Patch`,
	),
]

export const DiffEditNewFormat: Story = {
	decorators: [createStoryDecorator({ backgroundEditEnabled: true, diracMessages: createNewFormatMultiFileMessages() })],
	parameters: {
		docs: {
			description: {
				story: "Shows the new diff edit format with multiple file operations (Add, Update, Delete) displayed in an organized, expandable view.",
			},
		},
	},
}

export const DiffEditNewFormatStreaming: Story = {
	decorators: [
		(Story) => {
			const [messages, setMessages] = useState<DiracMessage[]>([
				createMessage(5, DiracMessageType.MARKDOWN, "Add TypeScript types to the user module"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "I'll add TypeScript types to improve type safety."),
			])
			const mockState = useMemo(
				() =>
					createMockState({
						backgroundEditEnabled: true,
						diracMessages: messages,
						activeVoiceStreamId: "streaming-patch-id",
					}),
				[messages],
			)

			useEffect(() => {
				// Simulate streaming: progressively add more content
				const partialPatch = `*** Begin Patch
*** Update File: src/user/profile.ts
@@
-interface UserProfile {
-  name: string
+interface UserProfile {
+  id: string
+  name: string`

				const morePatch =
					partialPatch +
					`
+  email: string
+  createdAt: Date`

				const completePatch =
					morePatch +
					`
+}
*** End Patch`

				// Add initial partial message
				const timer1 = setTimeout(() => {
					setMessages((prev: DiracMessage[]) => [
						...prev,
						createCardMessage(4.3, "editedExistingFile", partialPatch, CardStatus.RUNNING, {
							id: "streaming-patch-id",
						}),
					])
				}, 500)

				// Add more content
				const timer2 = setTimeout(() => {
					setMessages((prev: DiracMessage[]) => {
						const updated = [...prev]
						updated[updated.length - 1] = createCardMessage(
							4.3,
							"editedExistingFile",
							morePatch,
							CardStatus.RUNNING,
							{ id: "streaming-patch-id" },
						)
						return updated
					})
				}, 1500)

				// Complete the patch
				const timer3 = setTimeout(() => {
					setMessages((prev: DiracMessage[]) => {
						const updated = [...prev]
						updated[updated.length - 1] = createCardMessage(
							4.3,
							"editedExistingFile",
							completePatch,
							CardStatus.SUCCESS,
							{ id: "streaming-patch-id" },
						)
						return updated
					})
				}, 2500)

				return () => {
					clearTimeout(timer1)
					clearTimeout(timer2)
					clearTimeout(timer3)
				}
			}, [])

			return (
				<ExtensionStateProviderMock value={mockState}>
					<div className="w-full h-full flex justify-center items-center overflow-hidden">
						<div className={SIDEBAR_CLASS}>
							<Story />
						</div>
					</div>
				</ExtensionStateProviderMock>
			)
		},
	],
	parameters: {
		docs: {
			description: {
				story: "Shows the new diff edit format while streaming (incomplete patch without End Patch marker).",
			},
		},
	},
}

// Diff Edit Stories - Replace Diff Edit Format
const createReplaceDiffFormatPatchMessages = () => [
	createMessage(5, DiracMessageType.MARKDOWN, "Fix the validation logic in the form"),
	createMessage(4.7, DiracMessageType.MARKDOWN, "I'll fix the validation logic using the updated pattern."),
	createCardMessage(
		4.3,
		"editedExistingFile",
		`------- SEARCH
function validateEmail(email) {
  return email.includes('@')
}
=======
function validateEmail(email: string): boolean {
  const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/
  return emailRegex.test(email)
}
+++++++ REPLACE`,
	),
]

export const DiffEditReplaceDiffFormat: Story = {
	decorators: [createStoryDecorator({ backgroundEditEnabled: true, diracMessages: createReplaceDiffFormatPatchMessages() })],
	parameters: {
		docs: {
			description: {
				story: "Shows the old SEARCH/REPLACE diff format (backward compatibility) with complete markers, automatically converted to the new format display.",
			},
		},
	},
}

export const DiffEditReplaceDiffFormatStreaming: Story = {
	decorators: [
		(Story) => {
			const [messages, setMessages] = useState<DiracMessage[]>([
				createMessage(5, DiracMessageType.MARKDOWN, "Update error handling"),
				createMessage(4.7, DiracMessageType.MARKDOWN, "I'll improve the error handling in the API client."),
			])
			const mockState = useMemo(
				() =>
					createMockState({
						backgroundEditEnabled: true,
						diracMessages: messages,
						activeVoiceStreamId: "streaming-replace-id",
					}),
				[messages],
			)

			useEffect(() => {
				const completePatch = `------- SEARCH
try {
  const response = await fetch(url)
  return response.json()
} catch (error) {
  console.error(error)
}
=======
try {
  const response = await fetch(url)
  if (!response.ok) {
	throw new Error(\`HTTP error! status: \${response.status}\`)
  }
  return response.json()
} catch (error) {
  console.error('API request failed:', error)
  throw error
}
+++++++ REPLACE`

				const patchChunks = completePatch.split("\n")
				let currentIndex = 0

				const intervalId = setInterval(() => {
					if (currentIndex >= patchChunks.length) {
						clearInterval(intervalId)
						return
					}

					setMessages((prev: DiracMessage[]) => {
						const updated = [...prev]
						updated[updated.length - 1] = createCardMessage(
							4.3,
							"editedExistingFile",
							patchChunks.slice(0, currentIndex + 1).join("\n"),
							currentIndex !== patchChunks.length - 1 ? CardStatus.RUNNING : CardStatus.SUCCESS,
							{ id: "streaming-replace-id" },
						)
						return updated
					})

					currentIndex++
				}, 500)

				return () => clearInterval(intervalId)
			}, [])

			return (
				<ExtensionStateProviderMock value={mockState}>
					<div className="w-full h-full flex justify-center items-center overflow-hidden">
						<div className={SIDEBAR_CLASS}>
							<Story />
						</div>
					</div>
				</ExtensionStateProviderMock>
			)
		},
	],
	parameters: {
		docs: {
			description: {
				story: "Shows the old SEARCH/REPLACE diff format while streaming (incomplete, missing REPLACE marker), demonstrating graceful handling of partial content.",
			},
		},
	},
}

// Combined example showing both formats in one conversation
const createMixedFormatMessages = () => [
	createMessage(5, DiracMessageType.MARKDOWN, "Refactor the entire authentication system"),
	createMessage(4.7, DiracMessageType.MARKDOWN, "I'll refactor the authentication system. Starting with the login function."),
	createCardMessage(
		4.5,
		"editedExistingFile",
		`------- SEARCH
function login(username, password) {
  return authenticateUser(username, password)
}
=======
async function login(username: string, password: string): Promise<AuthResult> {
  return await authenticateUser(username, password)
}
+++++++ REPLACE`,
	),
	createMessage(
		4.3,
		DiracMessageType.MARKDOWN,
		"Great! Now let me add the type definitions and update the authentication module.",
	),
	createCardMessage(
		4.0,
		"editedExistingFile",
		`*** Begin Patch
*** Add File: src/auth/types.ts
+export interface AuthResult {
+  success: boolean
+  token?: string
+  error?: string
+}
+
+export interface LoginCredentials {
+  username: string
+  password: string
+}

*** Update File: src/auth/authenticate.ts
@@
-function authenticateUser(username, password) {
+async function authenticateUser(username: string, password: string): Promise<AuthResult> {
   // Authentication logic
+  return { success: true, token: 'mock-token' }
 }
*** End Patch`,
	),
]

export const DiffEditMixedFormats: Story = {
	decorators: [createStoryDecorator({ diracMessages: createMixedFormatMessages() })],
	parameters: {
		docs: {
			description: {
				story: "Shows a conversation using both search / replace and apply patch diff formats, demonstrating seamless backward compatibility and format detection.",
			},
		},
	},
}
