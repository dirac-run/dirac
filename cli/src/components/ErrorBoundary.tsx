import { Box, Text } from "ink"
import React from "react"
import { ErrorService } from "@/services/error"
import { StaticRobotFrame } from "./AsciiMotionCli"
import { DIRAC_CLI_DIR } from "../utils/path"
import { appendFileSync, mkdirSync } from "node:fs"

function writeErrorToLog(error: Error, errorInfo: React.ErrorInfo) {
	try {
		const logDir = DIRAC_CLI_DIR.log

		mkdirSync(logDir, { recursive: true })
		const logPath = `${logDir}/crash.log`
		const entry = `\n--- ${new Date().toISOString()} ---\n${error.stack || error.message}\nComponent Stack:\n${errorInfo.componentStack || "(none)"}\n`
		appendFileSync(logPath, entry)
	} catch {
		// Best effort
	}
}
type Props = React.PropsWithChildren<{ exit: (error?: Error) => void }>

async function onReactError(props: Props, error: Error, errorInfo: React.ErrorInfo) {
	// Write to stderr immediately so the user can see what broke
	process.stderr.write(`\n[Dirac ErrorBoundary] ${error.message}\n`)
	if (error.stack) process.stderr.write(`${error.stack}\n`)
	if (errorInfo.componentStack) process.stderr.write(`Component Stack:${errorInfo.componentStack}\n`)

	// Also write to crash log file
	writeErrorToLog(error, errorInfo)

	try {
		await ErrorService.get().captureException(error, { context: "ErrorBoundary", errorInfo })
		await ErrorService.get().dispose()
	} catch {
		// Ignore errors
	} finally {
		props.exit(error)
	}
}

export class ErrorBoundary extends React.Component<Props, { hasError: boolean }> {
	override state = { hasError: false }

	constructor(props: Props) {
		super(props)
	}

	override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
		onReactError(this.props, error, errorInfo)
	}

	static getDerivedStateFromError() {
		return { hasError: true }
	}

	override render() {
		if (this.state.hasError) {
			return (
				<Box flexDirection="column" height="100%" key="header" width="100%">
					<StaticRobotFrame />
					<Text> </Text>
					<Text bold color="white">
						Something went wrong. We're sorry.
					</Text>
					<Text color="white">Please check the logs for more details.</Text>
					<Text color="yellow">Log: {DIRAC_CLI_DIR.log}/crash.log</Text>
					<Text> </Text>
				</Box>
			)
		}

		return this.props.children
	}
}
