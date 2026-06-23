import { Logger } from "@/shared/services/Logger"

// Maximum total output size (stdout + stderr combined)
const MAX_HOOK_OUTPUT_SIZE = 1024 * 1024 // 1MB

type LineEmitter = (event: "line", line: string, stream: "stdout" | "stderr") => void

/**
 * HookOutputParser absorbs raw stdout/stderr chunks from a hook child process,
 * enforces a 1MB total output cap, and re-emits complete lines through the
 * supplied emitter. It also retains the full stdout/stderr buffers so callers
 * can parse the JSON response and report errors after the process exits.
 */
export class HookOutputParser {
	private buffer = ""
	private fullOutput = ""
	private lastRetrievedIndex = 0

	// Separate buffers for stdout and stderr
	private stdoutBuffer = ""
	private stderrBuffer = ""

	// Output size tracking
	private stdoutSize = 0
	private stderrSize = 0
	private outputTruncated = false

	constructor(private readonly emitLine: LineEmitter) {}

	/** Ingest a raw data chunk from the given stream, enforcing the size cap. */
	parseOutput(data: string, stream: "stdout" | "stderr"): void {
		// Stream buffers receive all data before the size check (matches original behavior).
		if (stream === "stdout") this.stdoutBuffer += data
		else this.stderrBuffer += data

		const dataSize = Buffer.byteLength(data)
		if (this.exceedsSizeLimit(dataSize)) {
			this.emitTruncationMarker(stream)
			return // Drop further output from fullOutput/line events
		}

		this.trackSize(dataSize, stream)
		this.fullOutput += data
		this.emitLines(data, stream)
	}

	/** Flush any partial line remaining in the buffer when the process closes. */
	emitRemainingBuffer(): void {
		if (!this.buffer) return
		const remaining = this.buffer.trimEnd()
		if (remaining) this.emitLine("line", remaining, "stdout")
		this.buffer = ""
		this.lastRetrievedIndex = this.fullOutput.length
	}

	getStdout(): string {
		return this.stdoutBuffer
	}

	getStderr(): string {
		return this.stderrBuffer
	}

	/** Returns output not yet retrieved via line events (for terminal-style polling). */
	getUnretrievedOutput(): string {
		const unretrieved = this.fullOutput.slice(this.lastRetrievedIndex)
		this.lastRetrievedIndex = this.fullOutput.length
		return unretrieved.trimEnd()
	}

	private exceedsSizeLimit(dataSize: number): boolean {
		return this.stdoutSize + this.stderrSize + dataSize > MAX_HOOK_OUTPUT_SIZE
	}

	private emitTruncationMarker(stream: "stdout" | "stderr"): void {
		if (this.outputTruncated) return
		this.outputTruncated = true
		this.emitLine("line", "\n\n[Output truncated: exceeded 1MB limit]", stream)
		Logger.warn(`[HookProcess] Output exceeded ${MAX_HOOK_OUTPUT_SIZE} bytes, truncating`)
	}

	private trackSize(dataSize: number, stream: "stdout" | "stderr"): void {
		if (stream === "stdout") this.stdoutSize += dataSize
		else this.stderrSize += dataSize
	}

	/** Split a chunk on newlines and emit each complete line. */
	private emitLines(chunk: string, stream: "stdout" | "stderr"): void {
		this.buffer += chunk
		let lineEndIndex: number
		while ((lineEndIndex = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, lineEndIndex).trimEnd()
			this.emitLine("line", line, stream)
			this.buffer = this.buffer.slice(lineEndIndex + 1)
		}
		this.lastRetrievedIndex = this.fullOutput.length - this.buffer.length
	}
}
