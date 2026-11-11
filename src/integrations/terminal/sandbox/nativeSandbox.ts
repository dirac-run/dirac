import { type ChildProcess, execFile, spawn } from "node:child_process"
import { access, constants } from "node:fs/promises"
import type { Writable } from "node:stream"
import { promisify } from "node:util"
import { BUBBLEWRAP_VERSION, defaultNativeArguments, permissiveSeccompFilter } from "./defaultPolicy"
import { type LinuxPolicyLaunch, prepareLinuxPolicy } from "./linuxPolicy"
import { MACOS_ENVIRONMENT_BOOTSTRAP } from "./macosEnvironment"
import { type MacOSPolicyLaunch, prepareMacOSPolicy } from "./macosPolicy"
import { probeMacOSRestrictiveSupport } from "./macosProbe"
import { ownNativeProcess } from "./processLifecycle"
import {
	type AvailableNativeSandbox,
	type NativeSandboxBackendLaunch,
	type NativeSandboxCapability,
	NativeSandboxError,
	type NativeSandboxRequest,
	type PreparedSandboxLaunch,
} from "./types"
import { prepareWindowsSandbox, probeWindowsSandbox, validateWindowsSandboxRequest } from "./windowsSandbox"

const execFileAsync = promisify(execFile)
let capability: Promise<NativeSandboxCapability> | undefined

function killOwnedGroup(child: ChildProcess): void {
	if (!child.pid) return
	try {
		process.kill(-child.pid, "SIGKILL")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
			throw new NativeSandboxError(
				"Native execution cleanup failed; descendants may remain.",
				"cleanup-failed",
				"execution-uncertain",
			)
		}
	}
}

function preparePosixBackend(
	available: AvailableNativeSandbox,
	request: NativeSandboxRequest,
	linux?: LinuxPolicyLaunch,
	mac?: MacOSPolicyLaunch,
): NativeSandboxBackendLaunch {
	let launched = false
	let lifetime: ReturnType<typeof ownNativeProcess> | undefined
	return {
		spawn(): ChildProcess {
			mac?.revalidate()
			const args = linux
				? ["--args", "4", "--", request.executable, ...request.args]
				: mac
					? [
							...mac.parameters,
							"-p",
							mac.policy,
							"/bin/sh",
							"-c",
							MACOS_ENVIRONMENT_BOOTSTRAP,
							"dirac-env-bootstrap",
							request.executable,
							...request.args,
						]
					: defaultNativeArguments(available, request)
			let child: ChildProcess
			try {
				child = spawn(available.helperPath, args, {
					cwd: linux ? "/" : request.cwd,
					env: linux || mac ? { PATH: "/usr/bin:/bin" } : request.env,
					detached: true,
					stdio: linux
						? ["ignore", "pipe", "pipe", "pipe", "pipe", ...linux.fds]
						: available.backend === "bubblewrap" || mac
							? ["ignore", "pipe", "pipe", "pipe"]
							: ["ignore", "pipe", "pipe"],
				})
				launched = true
			} finally {
				linux?.dispose()
			}
			lifetime = ownNativeProcess(child, {
				descendantsContained: available.backend === "bubblewrap",
				killGroup: () => killOwnedGroup(child),
				cleanup: () => mac?.dispose(),
			})
			const deliver = (pipe: Writable, value: Buffer, message: string) => {
				pipe.on("error", () => {
					if (!child.pid) return
					try {
						killOwnedGroup(child)
					} catch (error) {
						child.emit("error", error)
						return
					}
					child.emit("error", new NativeSandboxError(message, "launch-failed", "execution-uncertain"))
				})
				pipe.end(value)
			}
			if (available.backend === "bubblewrap") {
				deliver(
					child.stdio[3] as Writable,
					linux?.filter ?? permissiveSeccompFilter(),
					"Seccomp delivery failed; execution state is uncertain.",
				)
				if (linux) deliver(child.stdio[4] as Writable, linux.args, "Native policy argument delivery failed.")
			}
			if (mac)
				deliver(
					child.stdio[3] as Writable,
					mac.environmentPayload,
					"Native environment delivery failed; execution state is uncertain.",
				)
			return child
		},
		dispose(): void {
			linux?.dispose()
			if (!launched) mac?.dispose()
		},
		terminate(): Promise<void> {
			if (!lifetime)
				return Promise.reject(
					new NativeSandboxError("No owned execution was launched.", "cleanup-failed", "execution-uncertain"),
				)
			return lifetime.terminate()
		},
	}
}

async function probeDefaultLaunch(available: AvailableNativeSandbox): Promise<void> {
	const launch = preparePosixBackend(available, {
		executable: "/usr/bin/true",
		args: [],
		cwd: "/",
		env: process.env,
		policy: { id: "default" },
	})
	const child = launch.spawn()
	child.stdout?.resume()
	child.stderr?.resume()
	let timer: NodeJS.Timeout | undefined
	try {
		await new Promise<void>((resolve, reject) => {
			child.on("error", reject)
			child.once("close", (code, signal) => {
				if (code === 0 && !signal) resolve()
				else
					reject(
						new NativeSandboxError(
							"Native Default probe failed; check host namespace and sandbox support.",
							"setup-failed",
							"before-launch",
							true,
						),
					)
			})
			timer = setTimeout(() => {
				void launch
					.terminate(child)
					.then(
						() =>
							reject(
								new NativeSandboxError("Native Default probe timed out.", "setup-failed", "before-launch", true),
							),
						reject,
					)
			}, 5000)
		})
	} finally {
		clearTimeout(timer)
	}
}

async function discoverNativeSandbox(): Promise<NativeSandboxCapability> {
	if (process.platform === "win32") return probeWindowsSandbox()
	if (process.platform !== "linux" && process.platform !== "darwin") {
		return {
			available: false,
			error: new NativeSandboxError(
				`Native command sandbox is not implemented for ${process.platform}.`,
				"unsupported-host",
				"before-launch",
				true,
			),
		}
	}
	const helperPath = process.platform === "linux" ? "/usr/bin/bwrap" : "/usr/bin/sandbox-exec"
	try {
		await access(helperPath, constants.X_OK)
		let helperVersion: string | undefined
		if (process.platform === "linux") {
			const result = await execFileAsync(helperPath, ["--version"], { timeout: 5000, maxBuffer: 4096 })
			helperVersion = result.stdout.trim().replace(/^bubblewrap /, "")
			if (helperVersion !== BUBBLEWRAP_VERSION)
				throw new NativeSandboxError(
					`Bubblewrap ${BUBBLEWRAP_VERSION} is required by this foundation.`,
					"unsupported-version",
					"before-launch",
					true,
				)
		}
		let restrictiveProfiles = process.platform === "linux" && process.arch === "x64"
		if (process.platform === "darwin") {
			// Real host conformance, including bootstrap/RO/case/rename/link/IPC/network behavior.
			restrictiveProfiles = await probeMacOSRestrictiveSupport(helperPath)
		}
		const available: AvailableNativeSandbox = Object.freeze({
			available: true,
			backend: process.platform === "linux" ? "bubblewrap" : "seatbelt",
			helperPath,
			helperVersion,
			policyCapabilities: Object.freeze({
				restrictiveProfiles,
				taskPolicies: process.platform === "linux" && process.arch === "x64",
				unsupportedControls: Object.freeze(
					process.platform === "darwin"
						? [
								"taskPolicies",
								"environment.dynamic-loader",
								"local-ipc",
								"lifecycle.escaped-session-cleanup",
								...(!restrictiveProfiles ? ["restrictiveProfiles"] : []),
							]
						: [],
				),
			}),
			limitations: Object.freeze([
				"Default is permissive and provides no meaningful isolation; filesystem and network remain accessible.",
				...(process.platform === "linux"
					? [
							"Default retains host /proc. Custom restrictive policies require Linux x86-64 and separately validated native prerequisites.",
							"Bubblewrap encodes workload signals as exit codes 128+signal, not a separate signal event.",
						]
					: [
							"Seatbelt policy is inherited by descendants, including escaped sessions; lifetime ownership covers the original process group only. Cancellation reports uncertainty, not complete descendant cleanup.",
							"macOS native conformance is unverified by Linux tests. Private temp is host-backed per execution, not Linux tmpfs; no storage quota or host-shutdown guarantee.",
							"Restrictive macOS blocks local IPC and loader environment injection; runtime/toolchain compatibility is intentionally limited.",
						]),
			]),
		})
		await probeDefaultLaunch(available)
		return available
	} catch (error) {
		if (error instanceof NativeSandboxError) return { available: false, error }
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
		return {
			available: false,
			error: new NativeSandboxError(
				missing ? `Required native helper is missing: ${helperPath}.` : `Cannot prepare native helper: ${helperPath}.`,
				missing ? "missing-helper" : "setup-failed",
				"before-launch",
				true,
			),
		}
	}
}

/** Cached for this execution host/process. No discovery or installation runs during synchronous spawn. */
export function probeNativeSandbox(): Promise<NativeSandboxCapability> {
	capability ??= discoverNativeSandbox()
	return capability
}

/** Single-use wrapper also used by backend-local fake-process tests. No retries after spawn is entered. */
export function ownPreparedSandboxLaunch(
	available: AvailableNativeSandbox,
	request: NativeSandboxRequest,
	launch: NativeSandboxBackendLaunch,
): PreparedSandboxLaunch {
	let child: ChildProcess | undefined
	let consumed = false
	return Object.freeze({
		backend: available.backend,
		policy: request.policy,
		spawn(): ChildProcess {
			if (consumed)
				throw new NativeSandboxError(
					"Prepared launch has already been used; replay is forbidden.",
					"launch-failed",
					"execution-uncertain",
				)
			consumed = true
			try {
				child = launch.spawn()
				return child
			} catch (error) {
				launch.dispose()
				throw error
			}
		},
		dispose(): void {
			consumed = true
			launch.dispose()
		},
		terminate(candidate: ChildProcess): Promise<void> {
			if (!child || candidate !== child)
				return Promise.reject(
					new NativeSandboxError("Process belongs to a different execution.", "cleanup-failed", "execution-uncertain"),
				)
			return launch.terminate(candidate)
		},
	})
}

/** Validation and platform compilation precede availability errors: unsupported controls never authorize fallback. */
export async function prepareNativeSandboxWithProbe(
	request: NativeSandboxRequest,
	probe: () => Promise<NativeSandboxCapability>,
	platform: NodeJS.Platform = process.platform,
): Promise<PreparedSandboxLaunch> {
	const custom = "kind" in request.policy && request.policy.kind === "custom"
	if (!custom && request.policy.id !== "default")
		throw new NativeSandboxError("Unsupported native policy.", "invalid-policy", "before-launch")
	const snapshot: NativeSandboxRequest = structuredClone({ ...request, args: [...request.args], env: { ...request.env } })
	const profile = "kind" in snapshot.policy ? snapshot.policy : undefined
	if (platform === "win32") validateWindowsSandboxRequest(snapshot)
	if (profile && platform !== "linux" && platform !== "darwin" && platform !== "win32")
		throw new NativeSandboxError(
			"Restrictive policy controls are unsupported on this execution host.",
			"invalid-policy",
			"before-launch",
		)
	const linux = profile && platform === "linux" ? prepareLinuxPolicy(snapshot, profile) : undefined
	const mac = profile && platform === "darwin" ? prepareMacOSPolicy(snapshot, profile) : undefined
	try {
		const available = await probe()
		if (!available.available) throw available.error
		if (custom && !available.policyCapabilities?.restrictiveProfiles)
			throw new NativeSandboxError(
				"Restrictive policies are unsupported by this host's native backend.",
				"invalid-policy",
				"before-launch",
			)
		if (available.backend === "windows-mxc")
			return ownPreparedSandboxLaunch(available, snapshot, await prepareWindowsSandbox(snapshot, available))
		return ownPreparedSandboxLaunch(available, snapshot, preparePosixBackend(available, snapshot, linux, mac))
	} catch (error) {
		linux?.dispose()
		mac?.dispose()
		throw error
	}
}

export function prepareNativeSandbox(request: NativeSandboxRequest): Promise<PreparedSandboxLaunch> {
	return prepareNativeSandboxWithProbe(request, probeNativeSandbox)
}
