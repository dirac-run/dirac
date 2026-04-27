import {
    DiracAskQuestion,
    DiracMessage,
    DiracPlanModeResponse,
    DiracSayGenerateExplanation,
    DiracSayTool,
    COMPLETION_RESULT_CHANGES_FLAG,
    Mode,
} from "@shared/ExtensionMessage"
import { BooleanRequest, StringRequest } from "@shared/proto/dirac/common"
import {
    ArrowRightIcon,
    CheckIcon,
    CircleSlashIcon,
    CircleXIcon,
    FilePlus2Icon,
    LightbulbIcon,
    RefreshCwIcon,
    SettingsIcon,
    TriangleAlertIcon,
} from "lucide-react"
import { MouseEvent, ReactNode, useRef } from "react"
import { CompletionOutputRow } from "@/features/chat/components/CompletionOutputRow"
import ErrorRow from "@/features/chat/components/ErrorRow"
import HookMessage from "@/features/chat/components/HookMessage"
import { MarkdownRow } from "@/features/chat/components/MarkdownRow"
import NewTaskPreview from "@/features/chat/components/NewTaskPreview"
import { OptionsButtons } from "@/features/chat/components/OptionsButtons"
import PlanCompletionOutputRow from "@/features/chat/components/PlanCompletionOutputRow"
import QuoteButton from "@/features/chat/components/QuoteButton"
import ReportBugPreview from "@/features/chat/components/ReportBugPreview"
import { RequestStartRow } from "@/features/chat/components/RequestStartRow"
import SubagentStatusRow from "@/features/chat/components/SubagentStatusRow"
import { ThinkingRow } from "@/features/chat/components/ThinkingRow"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/shared/api/grpc-client"
import { CheckmarkControl } from "@/shared/ui/CheckmarkControl"
import CodeAccordian from "@/shared/ui/CodeAccordian"
import { WithCopyButton } from "@/shared/ui/CopyButton"
import { CommandOutputContent } from "../CommandOutputRow"
import UserMessage from "../UserMessage"
import { InvisibleSpacer, ProgressIndicator } from "./ChatRowComponents"
import { QuoteButtonState } from "./types"
import { HEADER_CLASSNAMES } from "./ToolOutput/shared"

interface MessageRendererProps {
	message: DiracMessage
	isExpanded: boolean
	onToggleExpand: (ts: number) => void
	lastModifiedMessage?: DiracMessage
	isLast: boolean
	onHeightChange?: (isTaller: boolean) => void
	inputValue?: string
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	onSetQuote: (text: string) => void
	mode?: Mode
	isRequestInProgress?: boolean
	dashboardReasoningContent?: string
	responseStarted?: boolean
	diracMessagesCount: number
	vscodeTerminalExecutionMode: string
	seeNewChangesDisabled: boolean
	setSeeNewChangesDisabled: (disabled: boolean) => void
	explainChangesDisabled: boolean
	setExplainChangesDisabled: (disabled: boolean) => void
	quoteButtonState: QuoteButtonState
	handleQuoteClick: () => void
	handleMouseUp: (event: MouseEvent<HTMLDivElement>) => void
	icon: ReactNode
	title: ReactNode
	apiReqStreamingFailedMessage?: string
	apiRequestFailedMessage?: string
	cost?: number
	onAskForUpdate?: () => void
}

export const MessageRenderer = ({
	message,
	isExpanded,
	onToggleExpand,
	lastModifiedMessage,
	isLast,
	onHeightChange,
	inputValue,
	sendMessageFromChatRow,
	mode,
	isRequestInProgress,
	dashboardReasoningContent,
	responseStarted,
	diracMessagesCount,
	vscodeTerminalExecutionMode,
	seeNewChangesDisabled,
	setSeeNewChangesDisabled,
	explainChangesDisabled,
	setExplainChangesDisabled,
	quoteButtonState,
	handleQuoteClick,
	handleMouseUp,
	icon,
	title,
	apiReqStreamingFailedMessage,
	apiRequestFailedMessage,
	cost,
	onAskForUpdate,
}: MessageRendererProps) => {
	const isPlanMode = useSettingsStore((state) => state.mode === "plan")
	const contentRef = useRef<HTMLDivElement>(null)
	const handleToggle = () => onToggleExpand(message.ts)

	switch (message.type) {
		case "say":
			switch (message.say) {
				case "api_req_started":
					const isApiReqLast = isLast && lastModifiedMessage?.ts === message.ts
					return (
						<RequestStartRow
							apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
							apiRequestFailedMessage={apiRequestFailedMessage}
							diracMessagesCount={diracMessagesCount}
							cost={cost}
							handleToggle={handleToggle}
							isExpanded={isExpanded}
							message={message}
							mode={mode}
							reasoningContent={dashboardReasoningContent}
							responseStarted={responseStarted}
							onAskForUpdate={onAskForUpdate}
						/>
					)
				case "api_req_finished":
					return <InvisibleSpacer />
				case "text": {
					return (
						<WithCopyButton
							className={cn(message.partial === true && "opacity-70")}
							onMouseUp={handleMouseUp}
							position="bottom-right"
							ref={contentRef}
							textToCopy={message.partial === true ? undefined : message.text}>
							<div className="flex items-center">
								<div
									className={cn(
										"flex-1 min-w-0 px-3 py-2 rounded-lg",
										isPlanMode
											? "bg-(--vscode-activityWarningBadge-background)/10 border border-(--vscode-activityWarningBadge-background)/20"
											: "bg-(--vscode-focusBorder)/10 border border-(--vscode-focusBorder)/20",
									)}>
									<MarkdownRow markdown={message.text} showCursor={false} />
								</div>
							</div>
							{message.partial !== true && quoteButtonState.visible && (
								<QuoteButton left={quoteButtonState.left} onClick={handleQuoteClick} top={quoteButtonState.top} />
							)}
						</WithCopyButton>
					)
				}
				case "reasoning": {
					const isReasoningStreaming = message.partial === true
					const hasReasoningText = !!message.text?.trim()
					return (
						<ThinkingRow
							isExpanded={isExpanded}
							isStreaming={isReasoningStreaming}
							isVisible={true}
							onToggle={handleToggle}
							reasoningContent={message.text}
							showChevron={true}
							showTitle={true}
							onAskForUpdate={onAskForUpdate}
							title={isReasoningStreaming ? "Thinking..." : "Thinking"}
						/>
					)
				}
				case "user_feedback":
					return (
						<UserMessage
							files={message.files}
							images={message.images}
							messageTs={message.ts}
							sendMessageFromChatRow={sendMessageFromChatRow}
							text={message.text}
						/>
					)
				case "user_feedback_diff": {
					const tool = JSON.parse(message.text || "{}") as DiracSayTool
					return (
						<div className="w-full -mt-2.5">
							<CodeAccordian
								diff={tool.diff!}
								isExpanded={isExpanded}
								isFeedback={true}
								onPathClick={
									tool.path
										? () =>
												FileServiceClient.openFileRelativePath(
													StringRequest.create({ value: tool.path }),
												).catch((err: any) => console.error("Failed to open file:", err))
										: undefined
								}
								onToggleExpand={handleToggle}
								path={tool.path}
							/>
						</div>
					)
				}
				case "error":
					return <ErrorRow errorType="error" message={message} />
				case "diff_error":
					return <ErrorRow errorType="diff_error" message={message} />
				case "diracignore_error":
					return <ErrorRow errorType="diracignore_error" message={message} />
				case "checkpoint_created":
					return <CheckmarkControl isCheckpointCheckedOut={message.isCheckpointCheckedOut} messageTs={message.ts} />
				case "generate_explanation": {
					let explanationInfo: DiracSayGenerateExplanation = {
						title: "code changes",
						fromRef: "",
						toRef: "",
						status: "generating",
					}
					try {
						if (message.text) {
							explanationInfo = JSON.parse(message.text)
						}
					} catch {}
					const wasCancelled =
						explanationInfo.status === "generating" &&
						(!isLast ||
							lastModifiedMessage?.ask === "resume_task" ||
							lastModifiedMessage?.ask === "resume_completed_task")
					const isGenerating = explanationInfo.status === "generating" && !wasCancelled
					const isError = explanationInfo.status === "error"
					return (
						<div className="bg-code flex flex-col border border-editor-group-border rounded-sm py-2.5 px-3">
							<div className="flex items-center">
								{isGenerating ? (
									<ProgressIndicator />
								) : isError ? (
									<CircleXIcon className="size-2 mr-2 text-error" />
								) : wasCancelled ? (
									<CircleSlashIcon className="size-2 mr-2" />
								) : (
									<CheckIcon className="size-2 mr-2 text-success" />
								)}
								<span className="font-semibold">
									{isGenerating
										? "Generating explanation"
										: isError
											? "Failed to generate explanation"
											: wasCancelled
												? "Explanation cancelled"
												: "Generated explanation"}
								</span>
							</div>
							{isError && explanationInfo.error && (
								<div className="opacity-80 ml-6 mt-1.5 text-error break-words">{explanationInfo.error}</div>
							)}
							{!isError && (explanationInfo.title || explanationInfo.fromRef) && (
								<div className="opacity-80 ml-6 mt-1.5">
									<div>{explanationInfo.title}</div>
									{explanationInfo.fromRef && (
										<div className="opacity-70 mt-1.5 break-all text-xs">
											<code className="bg-quote rounded-sm py-0.5 pr-1.5">{explanationInfo.fromRef}</code>
											<ArrowRightIcon className="inline size-2 mx-1" />
											<code className="bg-quote rounded-sm py-0.5 px-1.5">
												{explanationInfo.toRef || "working directory"}
											</code>
										</div>
									)}
								</div>
							)}
						</div>
					)
				}
				case "completion_result": {
					const hasChanges = message.text?.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
					const text = hasChanges ? message.text?.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text
					return (
						<CompletionOutputRow
							explainChangesDisabled={explainChangesDisabled}
							handleQuoteClick={handleQuoteClick}
							headClassNames={HEADER_CLASSNAMES}
							messageTs={message.ts}
							quoteButtonState={quoteButtonState}
							seeNewChangesDisabled={seeNewChangesDisabled}
							setExplainChangesDisabled={setExplainChangesDisabled}
							setSeeNewChangesDisabled={setSeeNewChangesDisabled}
							showActionRow={message.partial !== true && hasChanges}
							text={text || ""}
						/>
					)
				}
				case "shell_integration_warning":
					return (
						<div className="flex flex-col bg-warning/20 p-2 rounded-xs border border-error">
							<div className="flex items-center mb-1">
								<TriangleAlertIcon className="mr-2 size-2 stroke-3 text-error" />
								<span className="font-medium text-foreground">Shell Integration Unavailable</span>
							</div>
							<div className="text-foreground opacity-80">
								Dirac may have trouble viewing the command's output. Please update VSCode (
								<code>CMD/CTRL + Shift + P</code> → "Update") and make sure you're using a supported shell: zsh,
								bash, fish, or PowerShell (<code>CMD/CTRL + Shift + P</code> → "Terminal: Select Default
								Profile").
								<a
									className="px-1"
									href="https://github.com/dirac-run/dirac/wiki/Troubleshooting-%E2%80%90-Shell-Integration-Unavailable">
									Still having trouble?
								</a>
							</div>
						</div>
					)
				case "error_retry":
					try {
						const retryInfo = JSON.parse(message.text || "{}")
						const { attempt, maxAttempts, delaySeconds, failed, errorMessage } = retryInfo
						const isFailed = failed === true
						return (
							<div className="flex flex-col gap-2">
								{errorMessage && (
									<p className="m-0 whitespace-pre-wrap text-error wrap-anywhere text-xs">{errorMessage}</p>
								)}
								<div className="flex flex-col bg-quote p-0 rounded-[3px] text-[12px] p-3">
									<div className="flex items-center mb-1">
										{isFailed && !isRequestInProgress ? (
											<TriangleAlertIcon className="mr-2 size-2" />
										) : (
											<RefreshCwIcon className="mr-2 size-2 animate-spin" />
										)}
										<span className="font-medium text-foreground">
											{isFailed ? "Auto-Retry Failed" : "Auto-Retry in Progress"}
										</span>
									</div>
									<div className="text-foreground opacity-80">
										{isFailed ? (
											<span>
												Auto-retry failed after <strong>{maxAttempts}</strong> attempts. Manual
												intervention required.
											</span>
										) : (
											<span>
												Attempt <strong>{attempt}</strong> of <strong>{maxAttempts}</strong> - Retrying in{" "}
												{delaySeconds} seconds...
											</span>
										)}
									</div>
								</div>
							</div>
						)
					} catch (_e) {
						return (
							<div className="text-foreground">
								<MarkdownRow markdown={message.text} />
							</div>
						)
					}
				case "hook_status":
					return <HookMessage CommandOutput={CommandOutputContent} message={message} />
				case "hook_output_stream":
					return <InvisibleSpacer />
				case "subagent":
					return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
				case "shell_integration_warning_with_suggestion": {
					const isBackgroundModeEnabled = vscodeTerminalExecutionMode === "backgroundExec"
					return (
						<div className="p-2 bg-link/10 border border-link/30 rounded-xs">
							<div className="flex items-center mb-1">
								<LightbulbIcon className="mr-1.5 size-2 text-link" />
								<span className="font-medium text-foreground">Shell integration issues</span>
							</div>
							<div className="text-foreground opacity-90 mb-2">
								Since you're experiencing repeated shell integration issues, we recommend switching to Background
								Terminal mode for better reliability.
							</div>
							<button
								className={cn(
									"bg-button-background text-button-foreground border-0 rounded-xs py-1.5 px-3 text-[12px] flex items-center gap-1.5 cursor-pointer hover:bg-button-hover",
									{
										"cursor-default opacity-80 bg-success": isBackgroundModeEnabled,
									},
								)}
								disabled={isBackgroundModeEnabled}
								onClick={async () => {
									try {
										await UiServiceClient.setTerminalExecutionMode(BooleanRequest.create({ value: true }))
									} catch (error) {
										console.error("Failed to enable background terminal:", error)
									}
								}}>
								<SettingsIcon className="size-2" />
								{isBackgroundModeEnabled
									? "Background Terminal Enabled"
									: "Enable Background Terminal (Recommended)"}
							</button>
						</div>
					)
				}
				default:
					return (
						<div>
							{title && (
								<div className={HEADER_CLASSNAMES}>
									{icon}
									{title}
								</div>
							)}
							<div className="pt-1">
								<MarkdownRow markdown={message.text} />
							</div>
						</div>
					)
			}
		case "ask":
			switch (message.ask) {
				case "mistake_limit_reached":
					return <ErrorRow errorType="mistake_limit_reached" message={message} />
				case "completion_result": {
					if (message.text) {
						const hasChanges = message.text.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
						const text = hasChanges ? message.text.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text
						return (
							<CompletionOutputRow
								explainChangesDisabled={explainChangesDisabled}
								handleQuoteClick={handleQuoteClick}
								headClassNames={HEADER_CLASSNAMES}
								messageTs={message.ts}
								quoteButtonState={quoteButtonState}
								seeNewChangesDisabled={seeNewChangesDisabled}
								setExplainChangesDisabled={setExplainChangesDisabled}
								setSeeNewChangesDisabled={setSeeNewChangesDisabled}
								showActionRow={message.partial !== true && hasChanges}
								text={text || ""}
							/>
						)
					}
					return <InvisibleSpacer />
				}
				case "followup": {
					let question: string | undefined
					let options: string[] | undefined
					let selected: string | undefined
					try {
						const parsedMessage = JSON.parse(message.text || "{}") as DiracAskQuestion
						question = parsedMessage.question
						options = parsedMessage.options
						selected = parsedMessage.selected
					} catch (_e) {
						question = message.text
					}
					return (
						<div>
							{title && (
								<div className={HEADER_CLASSNAMES}>
									{icon}
									{title}
								</div>
							)}
							<WithCopyButton
								className="pt-1"
								onMouseUp={handleMouseUp}
								position="bottom-right"
								ref={contentRef}
								textToCopy={question}>
								<MarkdownRow markdown={question} />
								{quoteButtonState.visible && (
									<QuoteButton
										left={quoteButtonState.left}
										onClick={handleQuoteClick}
										top={quoteButtonState.top}
									/>
								)}
							</WithCopyButton>
							<div className="pt-3">
								<OptionsButtons
									inputValue={inputValue}
									isActive={
										(isLast && lastModifiedMessage?.ask === "followup") ||
										(!selected && options && options.length > 0)
									}
									options={options}
									selected={selected}
								/>
							</div>
						</div>
					)
				}
				case "new_task":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<FilePlus2Icon className="size-2" />
								<span className="text-foreground font-bold">Dirac wants to start a new task:</span>
							</div>
							<NewTaskPreview context={message.text || ""} />
						</div>
					)
				case "condense":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<FilePlus2Icon className="size-2" />
								<span className="text-foreground font-bold">Dirac wants to condense your conversation:</span>
							</div>
							<NewTaskPreview context={message.text || ""} />
						</div>
					)
				case "report_bug":
					return (
						<div>
							<div className={HEADER_CLASSNAMES}>
								<FilePlus2Icon className="size-2" />
								<span className="text-foreground font-bold">Dirac wants to create a Github issue:</span>
							</div>
							<ReportBugPreview data={message.text || ""} />
						</div>
					)
				case "plan_mode_respond": {
					let response: string | undefined
					let options: string[] | undefined
					let selected: string | undefined
					try {
						const parsedMessage = JSON.parse(message.text || "{}") as DiracPlanModeResponse
						response = parsedMessage.response
						options = parsedMessage.options
						selected = parsedMessage.selected
					} catch (_e) {
						response = message.text
					}
					return (
						<div>
							<PlanCompletionOutputRow headClassNames={HEADER_CLASSNAMES} text={response || message.text || ""} />
							<OptionsButtons
								inputValue={inputValue}
								isActive={
									(isLast && lastModifiedMessage?.ask === "plan_mode_respond") ||
									(!selected && options && options.length > 0)
								}
								options={options}
								selected={selected}
							/>
						</div>
					)
				}
				default:
					return <InvisibleSpacer />
			}
	}
}
