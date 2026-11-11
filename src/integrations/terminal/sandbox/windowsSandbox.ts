import { ChildProcess, execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough } from "node:stream"
import { promisify } from "node:util"
import {
	type AvailableNativeSandbox,
	type NativeSandboxBackendLaunch,
	type NativeSandboxCapability,
	NativeSandboxError,
	type NativeSandboxRequest,
} from "./types"
import {
	translateWindowsPolicy,
	WINDOWS_MXC_HELPER_VERSION,
	WINDOWS_MXC_PROTOCOL,
	WINDOWS_MXC_REVISION,
	windowsRuntimeEnvironment,
	windowsTemporaryParent,
} from "./windowsPolicy"

const execute = promisify(execFile)
const MAX_FRAME = 64 * 1024
const MAX_REQUEST = 1024 * 1024
const FEATURES = ["native-psec", "fs-deny", "self-job", "framed-output"]

function uncertain(message: string): NativeSandboxError {
	return new NativeSandboxError(message, "launch-failed", "execution-uncertain")
}

/** Control input is helper-owned only; workload bytes are encoded, never parsed as control. */
export class WindowsMxcProtocol {
	private pending = ""
	private started = false
	private settled?: { exitCode: number; cancelled: boolean }
	constructor(private readonly output: (stream: "stdout" | "stderr", bytes: Buffer) => void) {}
	append(chunk: Buffer): void {
		this.pending += chunk.toString("latin1")
		let end: number
		while ((end = this.pending.indexOf("\n")) !== -1) {
			if (end > MAX_FRAME) throw uncertain("MXC control frame exceeds its bound.")
			const line = this.pending.slice(0, end)
			this.pending = this.pending.slice(end + 1)
			let value: unknown
			try {
				value = JSON.parse(line)
			} catch {
				throw uncertain("Invalid MXC control JSON.")
			}
			this.frame(value)
		}
		if (this.pending.length > MAX_FRAME) throw uncertain("MXC control frame exceeds its bound.")
	}
	private frame(value: unknown): void {
		if (!value || typeof value !== "object" || Array.isArray(value) || this.settled)
			throw uncertain("Invalid MXC control sequence.")
		const frame = value as Record<string, unknown>
		const keys = Object.keys(frame).sort().join(",")
		if (
			frame.type === "started" &&
			keys === "pid,type" &&
			Number.isSafeInteger(frame.pid) &&
			(frame.pid as number) > 0 &&
			!this.started
		) {
			this.started = true
			return
		}
		if (
			(frame.type === "stdout" || frame.type === "stderr") &&
			keys === "data,type" &&
			typeof frame.data === "string" &&
			this.started
		) {
			const bytes = Buffer.from(frame.data, "base64")
			if (bytes.toString("base64") !== frame.data) throw uncertain("Invalid MXC output encoding.")
			this.output(frame.type, bytes)
			return
		}
		if (
			frame.type === "settled" &&
			keys === "cancelled,exitCode,type" &&
			this.started &&
			typeof frame.cancelled === "boolean" &&
			Number.isInteger(frame.exitCode) &&
			(frame.exitCode as number) >= -2147483648 &&
			(frame.exitCode as number) <= 2147483647
		) {
			this.settled = { exitCode: frame.exitCode as number, cancelled: frame.cancelled }
			return
		}
		throw uncertain("MXC helper reported failure or an invalid control frame; execution is not replayable.")
	}
	finish(): { exitCode: number; cancelled: boolean } {
		if (this.pending || !this.settled) throw uncertain("MXC helper closed without a complete settlement proof.")
		return this.settled
	}
}

export function validateWindowsMxcProbe(value: unknown): { networkIngress: boolean } {
	if (!value || typeof value !== "object") throw new Error("Invalid MXC probe")
	const p = value as Record<string, unknown>
	const features = p.features
	if (
		Object.keys(p).sort().join(",") !== "features,fsDeny,native,networkIngress,protocol,revision,version" ||
		p.protocol !== WINDOWS_MXC_PROTOCOL ||
		p.version !== WINDOWS_MXC_HELPER_VERSION ||
		p.revision !== WINDOWS_MXC_REVISION ||
		!Array.isArray(features) ||
		features.length !== FEATURES.length ||
		!FEATURES.every((feature) => features.includes(feature))
	)
		throw new Error("MXC helper protocol, revision, or feature mismatch")
	if (p.native !== true || p.fsDeny !== true || typeof p.networkIngress !== "boolean")
		throw new Error("This Windows build lacks native PSEC creation or FS_DENY; no AppContainer/ACL fallback is permitted")
	return { networkIngress: p.networkIngress }
}

async function verifyArtifact(helperPath: string): Promise<void> {
	const metadata: unknown = JSON.parse(await readFile(join(helperPath, "..", "manifest.json"), "utf8"))
	if (!metadata || typeof metadata !== "object") throw new Error("Invalid MXC artifact manifest")
	const m = metadata as Record<string, unknown>
	if (
		m.protocol !== WINDOWS_MXC_PROTOCOL ||
		m.version !== WINDOWS_MXC_HELPER_VERSION ||
		m.revision !== WINDOWS_MXC_REVISION ||
		m.arch !== process.arch ||
		typeof m.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(m.sha256)
	)
		throw new Error("MXC artifact metadata does not match this runtime")
	const digest = createHash("sha256")
		.update(await readFile(helperPath))
		.digest("hex")
	if (digest !== m.sha256) throw new Error("MXC artifact integrity mismatch")
}

export async function probeWindowsSandbox(): Promise<NativeSandboxCapability> {
	const helperPath = join(__dirname, "native", "windows-mxc", process.arch, "dirac-windows-mxc.exe")
	try {
		await verifyArtifact(helperPath)
		const { stdout } = await execute(helperPath, ["--probe"], {
			timeout: 10000,
			maxBuffer: 65536,
			windowsHide: true,
			env: windowsRuntimeEnvironment(process.env),
		})
		const features = validateWindowsMxcProbe(JSON.parse(stdout))
		return Object.freeze({
			available: true,
			backend: "windows-mxc",
			helperPath,
			helperVersion: WINDOWS_MXC_HELPER_VERSION,
			policyCapabilities: Object.freeze({
				restrictiveProfiles: true,
				taskPolicies: true,
				unsupportedControls: Object.freeze([
					"default",
					"filesystem.broad-read",
					"filesystem.read-only-exceptions",
					"paths.unc",
					"paths.reparse",
					"paths.case-sensitive",
					"paths.non-ascii",
					"paths.dos-alias",
					...(!features.networkIngress ? ["network.allow"] : []),
				]),
			}),
			limitations: Object.freeze([
				"Native ProcessContainer/PSEC only; no AppContainer, ACL mutation, VM, or WSL fallback.",
				"Per-execution temporary storage is a unique host-backed directory, not tmpfs.",
				"Native Windows lifecycle and enforcement require Windows runtime verification; Linux tests cover translation/protocol only.",
				"Foreground exit terminates remaining descendants; background executions retain the helper while the foreground remains alive.",
			]),
		})
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
		return {
			available: false,
			error: new NativeSandboxError(
				missing
					? "Packaged native MXC helper is missing; build/package the Windows helper for this architecture."
					: "Native MXC helper integrity, version, PSEC, or FS_DENY probe failed; no legacy fallback is allowed.",
				missing ? "missing-helper" : "setup-failed",
				"before-launch",
				true,
			),
		}
	}
}

/** Must run before helper discovery: unsupported authority is never fallback-eligible. */
export function validateWindowsSandboxRequest(request: NativeSandboxRequest): void {
	const parent = windowsTemporaryParent(request)
	translateWindowsPolicy(request, `${parent}\\dirac-mxc-validation`, process.env)
}

export async function prepareWindowsSandbox(
	request: NativeSandboxRequest,
	capability: AvailableNativeSandbox,
): Promise<NativeSandboxBackendLaunch> {
	validateWindowsSandboxRequest(request)
	if (
		"kind" in request.policy &&
		request.policy.network === "allow" &&
		capability.policyCapabilities?.unsupportedControls.includes("network.allow")
	)
		throw new NativeSandboxError(
			"This Windows build cannot represent unrestricted native network ingress/loopback.",
			"invalid-policy",
			"before-launch",
		)
	const parent = windowsTemporaryParent(request)
	const directory = await mkdtemp(join(parent, "dirac-mxc-"))
	let payload: string
	try {
		await verifyArtifact(capability.helperPath)
		const actual = await realpath(directory)
		if (actual.toLowerCase() !== directory.toLowerCase())
			throw new NativeSandboxError("MXC temporary parent resolves through an alias.", "invalid-policy", "before-launch")
		// Internal protection participates in precedence validation, rather than
		// appending a deny that a more-specific grant could reopen in PSEC.
		const translated = translateWindowsPolicy(request, directory, process.env, [join(capability.helperPath, "..")])
		payload = JSON.stringify({ ...translated, pathIdentities: request.context?.pathIdentities ?? [] }) + "\n"
		if (Buffer.byteLength(payload) > MAX_REQUEST)
			throw new NativeSandboxError("MXC launch request exceeds its size bound.", "invalid-policy", "before-launch")
	} catch (error) {
		await rm(directory, { recursive: true })
		throw error
	}
	let running: { child: ChildProcess; cancel(): void; force(): void; closed: Promise<void> } | undefined
	let disposed = false
	const cleanup = () => rm(directory, { recursive: true })
	return {
		spawn(): ChildProcess {
			const helper = spawn(capability.helperPath, ["--run"], {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
				env: windowsRuntimeEnvironment(process.env),
			})
			const child = new ChildProcess()
			const stdout = new PassThrough(),
				stderr = new PassThrough()
			child.stdout = stdout
			child.stderr = stderr
			child.stdin = null
			Object.defineProperties(child, {
				stdio: { value: [null, stdout, stderr, null, null] },
				pid: { value: helper.pid },
			})
			let failure: Error | undefined
			const cancel = () => {
				if (!helper.stdin.destroyed && !helper.stdin.writableEnded) helper.stdin.end()
			}
			const fail = (_error: Error) => {
				failure ??= uncertain("MXC helper transport failed; execution and cleanup are uncertain.")
				cancel()
			}
			const blocked = new Set<PassThrough>()
			const protocol = new WindowsMxcProtocol((stream, bytes) => {
				const target = stream === "stdout" ? stdout : stderr
				if (!target.write(bytes) && !blocked.has(target)) {
					blocked.add(target)
					helper.stdout.pause()
					target.once("drain", () => {
						blocked.delete(target)
						if (!blocked.size) helper.stdout.resume()
					})
				}
			})
			helper.stdout.on("data", (bytes: Buffer) => {
				if (!failure) {
					try {
						protocol.append(bytes)
					} catch (error) {
						fail(error as Error)
					}
				}
			})
			// SDK diagnostics are deliberately not forwarded: they can contain secrets.
			helper.stderr.resume()
			helper.on("error", fail)
			helper.stdin.on("error", fail)
			helper.stdout.on("error", fail)
			helper.stderr.on("error", fail)
			helper.on("spawn", () => child.emit("spawn"))
			const closed = new Promise<void>((resolve, reject) => {
				helper.once("close", (code, signal) => {
					void (async () => {
						let exitCode: number | null = null
						try {
							if (code !== 0 || signal || failure)
								throw failure ?? uncertain("MXC helper failed; workload status and cleanup are uncertain.")
							exitCode = protocol.finish().exitCode
						} catch (error) {
							failure = error as Error
						}
						try {
							await cleanup()
						} catch (error) {
							failure = new NativeSandboxError(
								"MXC host temporary cleanup failed after helper closure.",
								"cleanup-failed",
								"execution-uncertain",
							)
						}
						stdout.end()
						stderr.end()
						Object.defineProperty(child, "exitCode", { value: exitCode })
						if (failure) {
							child.emit("error", failure)
							reject(failure)
						} else resolve()
						child.emit("exit", exitCode, null)
						child.emit("close", exitCode, null)
					})()
				})
			})
			// Observe errors even when the caller is not currently cancelling.
			void closed.catch(() => undefined)
			running = {
				child,
				cancel,
				force: () => {
					helper.kill()
					helper.stdout.resume()
				},
				closed,
			}
			helper.stdin.write(payload)
			return child
		},
		dispose(): void {
			if (disposed || running) return
			disposed = true
			void cleanup().catch((error) => {
				process.emitWarning(`MXC preparation cleanup failed: ${(error as Error).name}`)
			})
		},
		async terminate(child: ChildProcess): Promise<void> {
			if (!running || running.child !== child)
				throw new NativeSandboxError("MXC process ownership mismatch.", "cleanup-failed", "execution-uncertain")
			running.cancel()
			let timer: NodeJS.Timeout | undefined
			try {
				await Promise.race([
					running.closed,
					new Promise<never>((_, reject) => {
						timer = setTimeout(() => {
							running!.force() // Killing the helper closes its sole kill-on-close job handle.
							reject(
								new NativeSandboxError(
									"MXC cancellation settlement timed out; forced helper termination requested, descendant cleanup is uncertain.",
									"cleanup-failed",
									"execution-uncertain",
								),
							)
						}, 30000)
					}),
				])
			} finally {
				clearTimeout(timer)
			}
		},
	}
}
