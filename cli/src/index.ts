/**
 * Dirac CLI - TypeScript implementation with React Ink
 */

import { exit } from "node:process"
import { INFERENCE_SPEED_OPTIONS, OPENAI_REASONING_EFFORT_OPTIONS } from "@shared/storage/types"
import { Command, Option } from "commander"
import { version as CLI_VERSION } from "../package.json"
import {
    parseInferenceSpeed,
    parsePositiveInteger,
    parseReasoningEffort,
    parseThinkingBudget,
    parseToolIdentifiers,
} from "./utils/command-parsers"
import { suppressConsoleUnlessVerbose } from "./utils/console"
import { setupSignalHandlers } from "./utils/errors"
import { isGoalRequest, UNSUPPORTED_GOAL_CLI_MESSAGE } from "./utils/goals"
import { getCliLogFilePath } from "./utils/output-channel"
import { parseTimeoutSeconds } from "./utils/task-timeout"

// CLI-only behavior: suppress console output unless verbose mode is enabled.
// Kept explicit here so importing the library bundle does not mutate global console methods.
suppressConsoleUnlessVerbose()

// Setup signal handlers for graceful shutdown
const releaseCliSignalOwnership = setupSignalHandlers()

export { hasExplicitAuthQuickSetupFlags, shouldDoQuickAuth } from "./commands/auth"
// Re-export for backward compatibility and testing
export { captureUnhandledException } from "./utils/errors"

// Setup CLI commands
const program = new Command()

program.name("dirac").description("Dirac CLI - AI coding assistant in your terminal").version(CLI_VERSION)

// Enable positional options to avoid conflicts between root and subcommand options with the same name
program.enablePositionalOptions()

program
	.command("task")
	.alias("t")
	.description("Run a new task")
	.argument("[prompt]", "The task prompt")
	.addOption(new Option("-a, --act", "Run in act mode").conflicts("plan"))
	.addOption(new Option("-p, --plan", "Run in plan mode").conflicts("act"))
	.option("-y, --yolo", "Enable yes/yolo mode (auto-approve actions)")
	.option("--auto-approve-all", "Enable auto-approve all actions while keeping interactive mode")
	.option("-t, --timeout <seconds>", "Optional timeout in seconds (applies only when provided)", parseTimeoutSeconds)
	.option("-m, --model <model>", "Model to use for the task")
	.option("-i, --images <paths...>", "Image file paths to include with the task")
	.option("--provider <provider>", "API provider to use (requires --model)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory for the task")
	.option("--config <path>", "Path to Dirac configuration directory")
	.option("--thinking [tokens]", "Enable extended thinking (default: 1024 tokens)", parseThinkingBudget)
	.option("--reasoning-effort <effort>", `Reasoning effort: ${OPENAI_REASONING_EFFORT_OPTIONS.join("|")}`, parseReasoningEffort)
	.option("--speed <speed>", `Inference speed: ${INFERENCE_SPEED_OPTIONS.join("|")}`, parseInferenceSpeed)
	.option(
		"--max-consecutive-mistakes <count>",
		"Maximum consecutive mistakes before halting in yolo mode",
		parsePositiveInteger,
	)
	.option("--json", "Output messages as JSON instead of styled text")
	.option("--double-check-completion", "Reject first completion attempt to force re-verification")
	.option("--auto-condense", "Enable AI-powered context compaction instead of mechanical truncation")
	.option("--auto-condense-at <tokens>", "Auto-condense when provider context reaches this token count", parsePositiveInteger)
	.option("--subagents", "Enable subagents for the task")
	.addOption(
		new Option("--enable-tool <tools>", "Enable comma-separated tools for this invocation")
			.argParser(parseToolIdentifiers)
			.conflicts("onlyTools"),
	)
	.addOption(
		new Option("--disable-tool <tools>", "Disable comma-separated tools for this invocation")
			.argParser(parseToolIdentifiers)
			.conflicts("onlyTools"),
	)
	.addOption(
		new Option("--only-tools <tools>", "Use only these comma-separated configurable tools")
			.argParser(parseToolIdentifiers)
			.conflicts(["enableTool", "disableTool"]),
	)
	.option("--hooks-dir <path>", "Path to additional hooks directory for runtime hook injection")
	.option("--no-index", "Disable symbol indexing for the workspace")
	.option("--no-emoji", "Disable emoji icons (use unicode/ascii fallbacks)")
	.option("--headers <headers>", "Custom headers for OpenAI-compatible provider (key1=value1,key2=value2 or JSON)")
	.option("-T, --taskId <id>", "Resume an existing task by ID")
	.action(async (prompt, options) => {
		const { combinePromptWithPipedInput, isEmptyPipedInput, readStdinIfPiped } = await import("./utils/piped")
		const stdinInput = await readStdinIfPiped()
		if (isEmptyPipedInput(stdinInput) && !prompt && !options.images?.length) {
			const { printWarning } = await import("./utils/display")
			printWarning("Empty input received from stdin. Please provide content to process.")
			exit(1)
		}
		const effectivePrompt = combinePromptWithPipedInput(prompt, stdinInput)
		const taskOptions = { ...options, stdinWasPiped: stdinInput !== null }
		const { runTask } = await import("./commands/task")
		const { resumeTask } = await import("./commands/resume")
		if (options.taskId) {
			return resumeTask(options.taskId, { ...taskOptions, initialPrompt: effectivePrompt })
		}
		return runTask(effectivePrompt || "", taskOptions)
	})

program
	.command("history")
	.alias("h")
	.description("List task history")
	.option("-n, --limit <number>", "Number of tasks to show", parsePositiveInteger, 10)
	.option("-p, --page <number>", "Page number (1-based)", parsePositiveInteger, 1)
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(async (options) => {
		const { listHistory } = await import("./commands/history")
		return listHistory(options)
	})

program
	.command("config")
	.description("Show current configuration")
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(async (options) => {
		const { showConfig } = await import("./commands/config")
		return showConfig(options)
	})

program
	.command("tools")
	.description("List effective tools for the current workspace")
	.option("-c, --cwd <path>", "Workspace used to discover tools")
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(async (options) => {
		const { listTools } = await import("./commands/tools")
		return listTools(options)
	})

program
	.command("auth")
	.description("Authenticate a provider and configure what model is used")
	.option("-p, --provider <id>", "Provider ID for quick setup (e.g., openai-native, anthropic, moonshot)")
	.option("-k, --apikey <key>", "API key for the provider")
	.option("-m, --modelid <id>", "Model ID to configure (e.g., gpt-4o, claude-sonnet-4-6, kimi-k2.5)")
	.option("-b, --baseurl <url>", "Base URL (optional, only for openai provider)")
	.option("--azure-api-version <version>", "Azure API version (optional, only for azure openai)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory for the task")
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(async (options) => {
		const { runAuth } = await import("./commands/auth")
		return runAuth(options)
	})

program
	.command("version")
	.description("Show Dirac CLI version number")
	.action(async () => {
		const { printInfo } = await import("./utils/display")
		printInfo(`Dirac CLI version: ${CLI_VERSION}`)
	})

program
	.command("update")
	.description("Check for updates and install if available")
	.option("-v, --verbose", "Show verbose output")
	.action(async (options) => {
		const { checkForUpdates } = await import("./utils/update")
		return checkForUpdates(CLI_VERSION, options)
	})

program
	.command("kanban")
	.description("Run npx kanban --agent dirac")
	.action(async () => {
		const { runKanbanAlias } = await import("./commands/kanban")
		return runKanbanAlias()
	})

// Dev command with subcommands
const devCommand = program.command("dev").description("Developer tools and utilities")

devCommand
	.command("log")
	.description("Open the log file")
	.option("--config <path>", "Path to Dirac configuration directory")
	.action(async (options) => {
		const { configureCliLogDirectoryFromDiracHome } = await import("./utils/path")
		const { openExternal } = await import("@/utils/env")
		configureCliLogDirectoryFromDiracHome(options.config)
		await openExternal(getCliLogFilePath())
	})

// Interactive mode (default when no command given)
program
	.argument("[prompt]", "Task prompt (starts task immediately)")
	.addOption(new Option("-a, --act", "Run in act mode").conflicts("plan"))
	.addOption(new Option("-p, --plan", "Run in plan mode").conflicts("act"))
	.option("-y, --yolo", "Enable yolo mode (auto-approve actions)")
	.option("--auto-approve-all", "Enable auto-approve all actions while keeping interactive mode")
	.option("-t, --timeout <seconds>", "Optional timeout in seconds (applies only when provided)", parseTimeoutSeconds)
	.option("-m, --model <model>", "Model to use for the task")
	.option("-i, --images <paths...>", "Image file paths to include with the task")
	.option("--provider <provider>", "API provider to use (requires --model)")
	.option("-v, --verbose", "Show verbose output")
	.option("-c, --cwd <path>", "Working directory")
	.option("--config <path>", "Configuration directory")
	.option("--thinking [tokens]", "Enable extended thinking (default: 1024 tokens)", parseThinkingBudget)
	.option("--reasoning-effort <effort>", `Reasoning effort: ${OPENAI_REASONING_EFFORT_OPTIONS.join("|")}`, parseReasoningEffort)
	.option("--speed <speed>", `Inference speed: ${INFERENCE_SPEED_OPTIONS.join("|")}`, parseInferenceSpeed)
	.option(
		"--max-consecutive-mistakes <count>",
		"Maximum consecutive mistakes before halting in yolo mode",
		parsePositiveInteger,
	)
	.option("--json", "Output messages as JSON instead of styled text")
	.option("--double-check-completion", "Reject first completion attempt to force re-verification")
	.option("--auto-condense", "Enable AI-powered context compaction instead of mechanical truncation")
	.option("--auto-condense-at <tokens>", "Auto-condense when provider context reaches this token count", parsePositiveInteger)
	.option("--subagents", "Enable subagents for the task")
	.addOption(
		new Option("--enable-tool <tools>", "Enable comma-separated tools for this invocation")
			.argParser(parseToolIdentifiers)
			.conflicts("onlyTools"),
	)
	.addOption(
		new Option("--disable-tool <tools>", "Disable comma-separated tools for this invocation")
			.argParser(parseToolIdentifiers)
			.conflicts("onlyTools"),
	)
	.addOption(
		new Option("--only-tools <tools>", "Use only these comma-separated configurable tools")
			.argParser(parseToolIdentifiers)
			.conflicts(["enableTool", "disableTool"]),
	)
	.option("--headers <headers>", "Custom headers for OpenAI-compatible provider (key1=value1,key2=value2 or JSON)")
	.option("--hooks-dir <path>", "Path to additional hooks directory for runtime hook injection")
	.option("--no-index", "Disable symbol indexing for the workspace")
	.option("--no-emoji", "Disable emoji icons (use unicode/ascii fallbacks)")
	.option("--acp", "Run in ACP (Agent Client Protocol) mode for editor integration")
	.option("--acp-auth", "Configure a provider for ACP clients")
	.option("--listen <socket>", "Run ACP detached on a Unix socket (implies --acp)")
	.option("--kanban", "Run npx kanban --agent dirac")
	.option("-T, --taskId <id>", "Resume an existing task by ID")
	.option("--continue", "Resume the most recent task from the current working directory")
	.action(async (prompt, options) => {
		const { printWarning } = await import("./utils/display")
		const { hasToolSelectionOptions } = await import("./utils/tool-options")
		if (hasToolSelectionOptions(options) && (options.kanban || options.acpAuth || options.acp || options.listen)) {
			printWarning("Tool-selection options can only be used with ordinary CLI tasks.")
			exit(1)
		}
		if (options.kanban) {
			if (prompt) {
				printWarning("Use --kanban without a prompt.")
				exit(1)
			}
			const { runKanbanAlias } = await import("./commands/kanban")
			await runKanbanAlias()
			return
		}

		if (options.acpAuth) {
			const { runAuth } = await import("./commands/auth")
			await runAuth({ config: options.config, cwd: options.cwd, verbose: options.verbose })
			return
		}
		// Check for ACP mode first - this takes precedence over everything else
		if (options.acp || options.listen) {
			if (isGoalRequest(prompt)) {
				printWarning(UNSUPPORTED_GOAL_CLI_MESSAGE)
				exit(1)
			}
			releaseCliSignalOwnership()
			const { runAcpMode } = await import("./acp/index.js")
			await runAcpMode({
				config: options.config,
				cwd: options.cwd,
				provider: options.provider,
				model: options.model,
				mode: options.plan ? "plan" : options.act ? "act" : undefined,
				autoApprove: options.autoApproveAll ? true : undefined,
				yolo: options.yolo ? true : undefined,
				thinkingBudgetTokens:
					options.thinking === undefined
						? undefined
						: typeof options.thinking === "boolean"
							? 1024
							: Number(options.thinking),
				reasoningEffort: options.reasoningEffort,
				inferenceSpeed: options.speed,
				hooksDir: options.hooksDir,
				verbose: options.verbose,
				listen: options.listen,
			})
			return
		}

		// Always check for piped stdin content
		const { combinePromptWithPipedInput, isEmptyPipedInput, readStdinIfPiped } = await import("./utils/piped")
		const stdinInput = await readStdinIfPiped()

		// Track whether stdin was actually piped (even if empty) vs not piped (null)
		// stdinInput === null means stdin wasn't piped (TTY or not FIFO/file)
		// Empty or whitespace-only input still counts as piped and is classified below.
		// stdinInput has content means stdin was piped with data
		const stdinWasPiped = stdinInput !== null

		if (options.taskId && options.continue) {
			printWarning("Use either --taskId or --continue, not both.")
			exit(1)
		}

		if (options.continue) {
			if (prompt) {
				printWarning("Use --continue without a prompt.")
				exit(1)
			}
			if (stdinWasPiped) {
				printWarning("Use --continue without piped input.")
				exit(1)
			}
			const { continueTask } = await import("./commands/resume")
			await continueTask(options)
			return
		}

		// Error if stdin was piped but empty AND no prompt was provided
		// This handles:
		// - `echo "" | dirac` -> error (empty stdin, no prompt)
		// - `dirac "prompt"` in GitHub Actions -> OK (empty stdin ignored, has prompt)
		// - `cat file | dirac "explain"` -> OK (has stdin AND prompt)
		if (isEmptyPipedInput(stdinInput) && !prompt && !options.images?.length) {
			printWarning("Empty input received from stdin. Please provide content to process.")
			exit(1)
		}

		// If no prompt argument, check if input is piped via stdin
		const effectivePrompt = combinePromptWithPipedInput(prompt, stdinInput)
		if (stdinInput) {
			// Debug: show that we received piped input
			if (options.verbose) {
				process.stderr.write(`[debug] Received ${stdinInput.length} bytes from stdin\n`)
			}
		}

		// Handle --taskId flag to resume an existing task
		if (options.taskId) {
			const { resumeTask } = await import("./commands/resume")
			await resumeTask(options.taskId, {
				...options,
				initialPrompt: effectivePrompt,
				stdinWasPiped,
			})
			return
		}

		if (effectivePrompt || options.images?.length) {
			const { runTask } = await import("./commands/task")
			// Pass stdinWasPiped flag so runTask knows to use plain text mode
			await runTask(effectivePrompt || "", { ...options, stdinWasPiped })
		} else {
			const { showWelcome } = await import("./commands/welcome")
			// Show welcome prompt if no prompt given
			await showWelcome(options)
		}
	})

// Parse and run
if (process.env.VITEST !== "true") {
	await program.parseAsync()
}
