import { Logger } from "@/shared/services/Logger"
import { HookOutput } from "../../shared/proto/dirac/hooks"

// Maximum size for context modification (to prevent prompt overflow)
const MAX_CONTEXT_MODIFICATION_SIZE = 50000 // ~50KB

/**
 * Validates hook output JSON structure.
 * Ensures required fields are present and have correct types.
 */
export function validateHookOutput(output: any): { valid: boolean; error?: string } {
	// Check if deprecated shouldContinue field is present
	if (output.shouldContinue !== undefined) {
		return {
			valid: false,
			error:
				"Invalid hook output: The 'shouldContinue' field has been removed.\n\n" +
				"Use 'cancel: true' instead to trigger task cancellation.\n\n" +
				"Migration guide:\n" +
				"  Before: { shouldContinue: false, errorMessage: '...' }\n" +
				"  After:  { cancel: true, errorMessage: '...' }\n\n" +
				"Example valid response:\n" +
				JSON.stringify(
					{
						cancel: false,
						contextModification: "Optional context here",
						errorMessage: "",
					},
					null,
					2,
				),
		}
	}

	// cancel is optional, but if provided must be a boolean
	if (output.cancel !== undefined && typeof output.cancel !== "boolean") {
		return {
			valid: false,
			error:
				"Invalid hook output: 'cancel' must be a boolean.\n\n" +
				`Received type: ${typeof output.cancel}\n\n` +
				"Example valid response:\n" +
				JSON.stringify({ cancel: true, errorMessage: "Cancelling task" }, null, 2),
		}
	}

	// contextModification is optional, but if provided must be a string
	if (output.contextModification !== undefined && typeof output.contextModification !== "string") {
		return {
			valid: false,
			error:
				"Invalid hook output: 'contextModification' must be a string.\n\n" +
				`Received type: ${typeof output.contextModification}\n\n` +
				"Example valid response:\n" +
				JSON.stringify({ contextModification: "Context here" }, null, 2),
		}
	}

	// errorMessage is optional, but if provided must be a string
	if (output.errorMessage !== undefined && typeof output.errorMessage !== "string") {
		return {
			valid: false,
			error:
				"Invalid hook output: 'errorMessage' must be a string.\n\n" +
				`Received type: ${typeof output.errorMessage}\n\n` +
				"Example valid response:\n" +
				JSON.stringify({ cancel: true, errorMessage: "Error description" }, null, 2),
		}
	}

	return { valid: true }
}

/**
 * Parses JSON hook output from stdout, with fallback extraction for mixed debug output.
 * Handles direct JSON parse, extraction from mixed output, and context truncation.
 */
export class HookResponseParser {
	/** Parses JSON hook output from stdout, returning null if no valid JSON found. */
	static parse(stdout: string, hookName: string): HookOutput | null {
		// Try direct JSON parse first
		try {
			return HookResponseParser.createValidatedOutput(JSON.parse(stdout), hookName)
		} catch {
			// Try to extract JSON from stdout mixed with debug output
			return HookResponseParser.extractJsonFromMixedOutput(stdout, hookName)
		}
	}

	/** Creates a validated HookOutput from parsed data, returning null if validation fails. */
	private static createValidatedOutput(outputData: any, hookName: string): HookOutput | null {
		const validation = validateHookOutput(outputData)
		if (!validation.valid) return null // Return null to let caller decide based on exit code

		const output = HookOutput.fromJSON(outputData)
		HookResponseParser.truncateContextModification(output, hookName)
		return output
	}

	/** Extracts JSON from stdout that may contain debug output before/after the actual JSON. */
	private static extractJsonFromMixedOutput(stdout: string, hookName: string): HookOutput | null {
		const lines = stdout.split("\n")
		let jsonCandidate = ""
		let braceCount = 0
		let startCollecting = false

		// Scan from the end to find the last complete JSON object
		for (let i = lines.length - 1; i >= 0; i--) {
			const line = lines[i].trimEnd()

			// Count braces to track JSON object boundaries
			for (let j = line.length - 1; j >= 0; j--) {
				if (line[j] === "}") {
					braceCount++
					if (!startCollecting) startCollecting = true
				} else if (line[j] === "{") {
					braceCount--
				}
			}

			if (startCollecting) jsonCandidate = `${line}\n${jsonCandidate}`

			// If we've closed all braces, we have a complete JSON object
			if (startCollecting && braceCount === 0) break
		}

		return HookResponseParser.parseExtractedJson(jsonCandidate, hookName)
	}

	/** Parses the extracted JSON candidate string, returning null if not valid. */
	private static parseExtractedJson(jsonCandidate: string, hookName: string): HookOutput | null {
		if (!jsonCandidate.trim()) return null

		try {
			// Trim everything before the first opening bracket
			const trimmedCandidate = jsonCandidate.trim()
			const firstBraceIndex = trimmedCandidate.indexOf("{")
			const cleanedJson = firstBraceIndex !== -1 ? trimmedCandidate.slice(firstBraceIndex) : trimmedCandidate
			return HookResponseParser.createValidatedOutput(JSON.parse(cleanedJson), hookName)
		} catch {
			return null // Couldn't extract valid JSON
		}
	}

	/** Truncates context modification if it exceeds the maximum allowed size. */
	static truncateContextModification(output: HookOutput, hookName: string): void {
		if (!output.contextModification || output.contextModification.length <= MAX_CONTEXT_MODIFICATION_SIZE) return

		Logger.warn(
			`Hook ${hookName} returned contextModification of ${output.contextModification.length} bytes, ` +
				`truncating to ${MAX_CONTEXT_MODIFICATION_SIZE} bytes`,
		)
		output.contextModification =
			output.contextModification.slice(0, MAX_CONTEXT_MODIFICATION_SIZE) +
			"\n\n[... context truncated due to size limit ...]"
	}
}
