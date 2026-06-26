import { ParseEntry, parse } from "shell-quote"
import { Logger } from "@/shared/services/Logger"

const REDIRECT_OPERATORS = new Set([">", ">>", "<", ">&", "<&", "|&", "<(", ">("])
const COMMAND_SEPARATOR_OPERATORS = new Set(["&&", "||", "|", ";"])

/** Result of parsing a command into segments (recursive structure). */
export interface ParsedCommand {
	segments: string[] // Individual commands between operators
	subshells: ParsedCommand[] // Recursively parsed contents of (...) and $(...)
	hasRedirects: boolean // Whether redirect operators (>, >>, <, etc.) were found
}

/**
 * Parses shell commands into segments split by operators (&&, ||, |, ;).
 * Detects redirect operators and recursively parses subshell contents.
 */
export class CommandParser {
	/** Parse a command string into segments, subshells, and redirect detection. */
	parseCommandSegments(input: string): ParsedCommand {
		let tokens: ParseEntry[] = []
		try {
			tokens = parse(input)
		} catch (err) {
			Logger.error(`Error parsing command: ${err.message}`)
			return { segments: [], subshells: [], hasRedirects: false }
		}

		return this.processTokens(tokens)
	}

	private processTokens(tokenList: ParseEntry[]): ParsedCommand {
		const result: ParsedCommand = { segments: [], subshells: [], hasRedirects: false }
		let currentSegmentParts: string[] = []

		const flushSegment = () => {
			if (currentSegmentParts.length > 0) {
				result.segments.push(currentSegmentParts.join(" "))
				currentSegmentParts = []
			}
		}

		for (let i = 0; i < tokenList.length; i++) {
			const token = tokenList[i]
			const op = this.getTokenOp(token)

			// 1. Handle Subshells: ( ... )
			if (op === "(") {
				flushSegment()
				const { subTokens, nextIndex } = this.extractSubshell(tokenList, i)
				result.subshells.push(this.processTokens(subTokens))
				i = nextIndex
				continue
			}

			// 2. Handle Logic Separators: &&, ||, ;, |
			if (op && COMMAND_SEPARATOR_OPERATORS.has(op)) {
				flushSegment()
				continue
			}

			// 3. Handle Redirect Operators: >, >>, <, etc.
			if (op && REDIRECT_OPERATORS.has(op)) {
				result.hasRedirects = true
				continue
			}

			// 4. Handle Strings (Commands and Arguments)
			if (typeof token === "string") {
				// Preserve '$' for subshell interpolation $(...) so "echo $(whoami)" becomes "echo $"
				const nextToken = tokenList[i + 1]
				if (token === "$" && this.getTokenOp(nextToken) === "(") {
					currentSegmentParts.push(token)
					continue
				}
				currentSegmentParts.push(token)
			}
			// 5. Handle Glob/Pattern objects
			else if (typeof token === "object" && "pattern" in token) {
				currentSegmentParts.push(token.pattern)
			}
		}

		flushSegment()
		return result
	}

	/** Extract the operator string from a token, if it has one. */
	private getTokenOp(token: ParseEntry | undefined): string | undefined {
		if (typeof token === "object" && "op" in token) {
			return token.op as string
		}
		return undefined
	}

	/** Extract subshell tokens between matching parens, starting at index `start` (the opening paren). */
	private extractSubshell(tokenList: ParseEntry[], start: number): { subTokens: ParseEntry[]; nextIndex: number } {
		let balance = 1
		let j = start + 1
		const subTokens: ParseEntry[] = []

		while (j < tokenList.length && balance > 0) {
			const subToken = tokenList[j]
			const op = this.getTokenOp(subToken)
			if (op === "(") balance++
			if (op === ")") balance--

			if (balance > 0) {
				subTokens.push(subToken)
			}
			j++
		}

		return { subTokens, nextIndex: j - 1 } // Skip processed tokens
	}
}
