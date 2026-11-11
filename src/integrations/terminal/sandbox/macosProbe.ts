import { type ChildProcess, execFile, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import net from "node:net"
import path from "node:path"
import type { Writable } from "node:stream"
import { promisify } from "node:util"
import { MACOS_ENVIRONMENT_BOOTSTRAP, macOSEnvironmentPayload } from "./macosEnvironment"
import { compileSeatbeltPolicy } from "./macosPolicy"
import { MACOS_SELECTED_READABLE_BASELINE } from "./platformPolicy"

const execute = promisify(execFile)
type CompiledPolicy = ReturnType<typeof compileSeatbeltPolicy>

/** Bounded trusted fixture execution only, not a user-command retry path. Output is never logged. */
export async function runMacOSConformanceCommand(
	helperPath: string,
	compiled: CompiledPolicy,
	args: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<boolean> {
	const payload = macOSEnvironmentPayload(env)
	const child = spawn(
		helperPath,
		[
			...compiled.parameters,
			"-p",
			compiled.policy,
			"/bin/sh",
			"-c",
			MACOS_ENVIRONMENT_BOOTSTRAP,
			"dirac-env-bootstrap",
			"/bin/sh",
			"-c",
			...args,
		],
		{
			cwd: "/",
			env: { PATH: "/usr/bin:/bin" },
			detached: true,
			stdio: ["ignore", "ignore", "ignore", "pipe"],
		},
	)
	return settleMacOSProbeProcess(child, payload)
}

/** A failed probe must settle even when kill/pipe drain cannot establish cleanup. */
export function settleMacOSProbeProcess(
	child: ChildProcess,
	payload: Buffer,
	options: { timeoutMs?: number; killGroup?: () => void } = {},
): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		let settled = false
		const finish = (success: boolean) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			resolve(success)
		}
		const failClosed = () => {
			if (settled) return
			// Failure is not proof of cleanup: never wait indefinitely for close after kill.
			finish(false)
			try {
				if (options.killGroup) options.killGroup()
				else if (child.pid) process.kill(-child.pid, "SIGKILL")
			} catch {
				// Capability remains unsupported; process termination is explicitly uncertain.
			}
			for (const stream of child.stdio) stream?.destroy()
			child.unref()
		}
		const timer = setTimeout(failClosed, options.timeoutMs ?? 3000)
		child.on("error", failClosed)
		child.once("close", (code, signal) => finish(code === 0 && signal === null))
		const pipe = child.stdio[3] as Writable
		pipe.on("error", failClosed)
		pipe.end(payload)
	})
}

const FILE_CONFORMANCE = `
[ "$DIRAC_PROBE_VALUE" = 'literal ; $() = value' ] || exit 10
[ -z "\${DIRAC_UNSELECTED+x}" ] || exit 11
printf allowed > "$1/allowed" || exit 12
(printf changed > "$1/readonly/data") && exit 13
/bin/cat "$1/blocked/data" >/dev/null 2>&1 && exit 14
/bin/cat "$1/parent/protected/data" >/dev/null 2>&1 && exit 15
/bin/cat "$1/PARENT/PROTECTED/data" >/dev/null 2>&1 && exit 16
(printf changed > "$1/READONLY/data") && exit 17
/bin/mv "$1/parent" "$1/moved" >/dev/null 2>&1 && exit 18
/bin/mv "$1/readonly" "$1/renamed" >/dev/null 2>&1 && exit 19
/bin/ln "$1/parent/protected/data" "$1/hardlink" >/dev/null 2>&1 && exit 20
/bin/ln -s "$1/parent/protected" "$1/new-symlink" >/dev/null 2>&1 || exit 21
/bin/cat "$1/new-symlink/data" >/dev/null 2>&1 && exit 22
[ ! -e /dev/fd/3 ] || exit 23
exit 0
`

async function listen(server: net.Server, options: net.ListenOptions): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(options, resolve)
	})
}
async function close(server: net.Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

/** On-host behavioral gate, not certification of every filesystem layout or toolchain. */
export async function probeMacOSRestrictiveSupport(helperPath: string): Promise<boolean> {
	const root = realpathSync(mkdtempSync("/private/tmp/dirac-seatbelt-probe-"))
	const workspace = path.join(root, "workspace")
	const readonly = path.join(workspace, "readonly")
	const blocked = path.join(workspace, "blocked")
	const authority = path.join(workspace, "parent", "protected")
	const tcp = net.createServer((socket) => socket.destroy())
	const unix = net.createServer((socket) => socket.destroy())
	let tcpListening = false,
		unixListening = false
	try {
		for (const directory of [workspace, readonly, blocked, authority]) mkdirSync(directory, { recursive: true })
		for (const directory of [readonly, blocked, authority]) writeFileSync(path.join(directory, "data"), "unchanged")
		const readable = [
			...MACOS_SELECTED_READABLE_BASELINE.filter((value) => {
				try {
					statSync(value)
					return true
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
					throw error
				}
			}),
			readonly,
		]
		const policyInput = { readable, writable: [workspace], blocked: [blocked, "/dev/zero"], protected: [authority] }
		const denied = compileSeatbeltPolicy({ ...policyInput, network: "deny" })
		if (
			!(await runMacOSConformanceCommand(helperPath, denied, [FILE_CONFORMANCE, "probe", workspace], {
				DIRAC_PROBE_VALUE: "literal ; $() = value",
			}))
		)
			return false
		// The fixed device baseline must not reopen an explicit block.
		if (
			!(await runMacOSConformanceCommand(helperPath, denied, [
				"! /bin/dd if=/dev/zero of=/dev/null bs=1 count=1 2>/dev/null",
				"probe",
			]))
		)
			return false
		await listen(tcp, { host: "127.0.0.1", port: 0 })
		tcpListening = true
		const port = (tcp.address() as net.AddressInfo).port
		const socketPath = path.join(root, "socket")
		await listen(unix, { path: socketPath })
		unixListening = true
		// Verify clients actually work outside Seatbelt; a missing/broken client is not denial evidence.
		await execute("/usr/bin/nc", ["-z", "-w", "1", "127.0.0.1", String(port)], {
			timeout: 2000,
			env: { PATH: "/usr/bin:/bin" },
		})
		await execute("/usr/bin/nc", ["-z", "-w", "1", "-U", socketPath], { timeout: 2000, env: { PATH: "/usr/bin:/bin" } })
		const allowed = compileSeatbeltPolicy({ ...policyInput, network: "allow" })
		const ipCommand = '/usr/bin/nc -z -w 1 127.0.0.1 "$1"'
		if (!(await runMacOSConformanceCommand(helperPath, allowed, [ipCommand, "probe", String(port)]))) return false
		if (!(await runMacOSConformanceCommand(helperPath, denied, [`! ${ipCommand}`, "probe", String(port)]))) return false
		// Include the socket's path in filesystem access; only IPC policy may deny it.
		const unixPolicy = compileSeatbeltPolicy({ ...policyInput, readable: [...readable, root], network: "allow" })
		return await runMacOSConformanceCommand(helperPath, unixPolicy, ['! /usr/bin/nc -z -w 1 -U "$1"', "probe", socketPath])
	} catch {
		return false
	} finally {
		if (tcpListening) await close(tcp)
		if (unixListening) await close(unix)
		rmSync(root, { recursive: true, force: true })
	}
}
