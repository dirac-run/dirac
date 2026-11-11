import assert from "node:assert/strict"
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { windowsRuntimeEnvironment, type WindowsMxcLaunch } from "./windowsPolicy"
import { validateWindowsMxcProbe, WindowsMxcProtocol } from "./windowsSandbox"

// Explicitly opt-in: these tests launch real workloads and exercise native OS
// enforcement. A Linux pass/skip says nothing about Windows isolation.
const helper = resolve(
	process.env.DIRAC_WINDOWS_MXC_HELPER ?? `native/windows-mxc/artifacts/${process.arch}/dirac-windows-mxc.exe`,
)
const enabled = process.platform === "win32" && process.env.DIRAC_WINDOWS_MXC_NATIVE_TESTS === "1" && existsSync(helper)
const nativeSuite = enabled ? describe : describe.skip
nativeSuite("Windows MXC native conformance (requires opt-in Windows host, built helper, native PSEC + FS_DENY)", function () {
	this.timeout(45000)
	let root: string, workspace: string, temporary: string, protectedFile: string, shell: string
	before(function () {
		const probe = JSON.parse(
			execFileSync(helper, ["--probe"], {
				env: windowsRuntimeEnvironment(process.env),
				encoding: "utf8",
				windowsHide: true,
			}),
		)
		try {
			validateWindowsMxcProbe(probe)
		} catch {
			console.info("SKIP Windows native suite: this host lacks actual native PSEC or FS_DENY.")
			this.skip()
		}
		root = mkdtempSync(join(tmpdir(), "dirac-mxc-native-test-"))
		workspace = join(root, "workspace")
		temporary = join(root, "temp")
		mkdirSync(workspace)
		mkdirSync(temporary)
		protectedFile = join(workspace, "protected.json")
		writeFileSync(protectedFile, "protected-original")
		shell = join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	})
	after(() => {
		if (root) rmSync(root, { recursive: true, force: true })
	})
	function launch(script: string, change?: (request: WindowsMxcLaunch) => void) {
		const request: WindowsMxcLaunch = {
			protocol: 1,
			executable: shell,
			args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
			cwd: workspace,
			environment: { ...windowsRuntimeEnvironment(process.env), TEMP: temporary, TMP: temporary },
			readonlyPaths: [process.env.SystemRoot!],
			readwritePaths: [workspace, temporary],
			deniedPaths: [protectedFile],
			network: "deny",
		}
		change?.(request)
		const child = spawn(helper, ["--run"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: windowsRuntimeEnvironment(process.env),
			windowsHide: true,
		})
		let stdout = "",
			stderr = "",
			pid: number | undefined,
			pending = ""
		const protocol = new WindowsMxcProtocol((stream, bytes) => {
			if (stream === "stdout") stdout += bytes.toString("utf8")
			else stderr += bytes.toString("utf8")
		})
		const started = new Promise<number>((resolveStarted, rejectStarted) => {
			child.stdout.on("data", (chunk: Buffer) => {
				pending += chunk.toString()
				for (;;) {
					const end = pending.indexOf("\n")
					if (end === -1) break
					const line = pending.slice(0, end)
					pending = pending.slice(end + 1)
					const frame = JSON.parse(line)
					if (frame.type === "started") {
						pid = frame.pid
						resolveStarted(frame.pid)
					}
				}
				try {
					protocol.append(chunk)
				} catch {
					/* Failure cases assert helper nonzero below. */
				}
			})
			child.once("error", rejectStarted)
			child.once("close", () => {
				if (pid === undefined) rejectStarted(new Error("helper closed before workload start"))
			})
		})
		void started.catch(() => undefined)
		child.stderr.resume()
		const done = new Promise<{
			helperExit: number | null
			stdout: string
			stderr: string
			result?: { exitCode: number; cancelled: boolean }
		}>((resolveDone, rejectDone) => {
			const timer = setTimeout(() => {
				child.kill()
				rejectDone(new Error("native helper test timed out"))
			}, 30000)
			child.once("close", (helperExit) => {
				clearTimeout(timer)
				let result
				try {
					result = protocol.finish()
				} catch {
					/* Expected for injected helper crashes. */
				}
				resolveDone({ helperExit, stdout, stderr, result })
			})
		})
		child.stdin.on("error", () => undefined)
		child.stdin.write(JSON.stringify(request) + "\n")
		return { child, started, done, output: () => stdout }
	}
	async function assertGone(pid: number): Promise<void> {
		for (let count = 0; count < 100; count++) {
			try {
				process.kill(pid, 0)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return
				throw error
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 50))
		}
		assert.fail(`Native job descendant remains alive: ${pid}`)
	}
	async function descendant(execution: ReturnType<typeof launch>): Promise<number> {
		await execution.started
		for (let count = 0; count < 100; count++) {
			const match = /DESCENDANT=(\d+)/.exec(execution.output())
			if (match) return Number(match[1])
			await new Promise((resolveWait) => setTimeout(resolveWait, 50))
		}
		execution.child.kill()
		assert.fail("native test descendant PID not reported")
	}
	const tree = `$p=Start-Process -FilePath '${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 60' -PassThru; [Console]::WriteLine('DESCENDANT='+$p.Id); Start-Sleep -Seconds 60`

	it("runs selected writable commands with isolated output and independent workload exit status", async () => {
		const execution = launch(
			`[IO.File]::WriteAllText('created.txt','yes'); [Console]::WriteLine('{\"type\":\"settled\",\"exitCode\":0}'); exit 7`,
		)
		const result = await execution.done
		assert.equal(result.helperExit, 0)
		assert.equal(result.result?.exitCode, 7)
		assert.match(result.stdout, /settled/)
		assert.equal(readFileSync(join(workspace, "created.txt"), "utf8"), "yes")
	})
	it("enforces read-only workspace and protected configuration FS_DENY", async () => {
		const denied = await launch(`try { [IO.File]::WriteAllText('protected.json','changed'); exit 90 } catch { exit 0 }`).done
		assert.equal(denied.result?.exitCode, 0)
		assert.equal(readFileSync(protectedFile, "utf8"), "protected-original")
		const ro = await launch(
			`try { [IO.File]::WriteAllText('readonly-created.txt','changed'); exit 90 } catch { exit 0 }`,
			(r) => {
				r.readwritePaths = [temporary]
				r.readonlyPaths.push(workspace)
			},
		).done
		assert.equal(ro.result?.exitCode, 0)
		assert.equal(existsSync(join(workspace, "readonly-created.txt")), false)
	})
	it("passes only explicit environment and reserved runtime baseline", async () => {
		const result = await launch(
			`if($env:DIRAC_NATIVE_SECRET){exit 91}; if($env:DIRAC_EXPLICIT -ne 'selected'){exit 92}; if($env:TEMP -ne '${temporary.replaceAll("'", "''")}'){exit 93}; exit 0`,
			(r) => {
				r.environment.DIRAC_EXPLICIT = "selected"
			},
		).done
		assert.equal(result.result?.exitCode, 0)
	})
	it("blocks network loopback as well as external egress", async () => {
		const server = createServer((socket) => socket.end())
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
		try {
			const address = server.address()
			assert.ok(address && typeof address === "object")
			const result = await launch(
				`$c=New-Object Net.Sockets.TcpClient; try { $t=$c.ConnectAsync('127.0.0.1',${address.port}); if($t.Wait(3000) -and $c.Connected){exit 90}; exit 0 } catch { exit 0 }`,
			).done
			assert.equal(result.result?.exitCode, 0)
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
		}
	})
	it("EOF cancellation drains owned descendants without killing a sibling host process", async () => {
		const sibling = spawn(shell, ["-NoProfile", "-Command", "Start-Sleep -Seconds 60"], {
			stdio: "ignore",
			windowsHide: true,
		})
		try {
			const execution = launch(tree),
				pid = await descendant(execution)
			execution.child.stdin.end() // Also models trusted host pipe EOF/parent death.
			const result = await execution.done
			assert.equal(result.helperExit, 0)
			assert.equal(result.result?.cancelled, true)
			await assertGone(pid)
			assert.ok(sibling.pid)
			process.kill(sibling.pid, 0)
		} finally {
			sibling.kill()
		}
	})
	it("helper crash after native launch closes sole outer job handle and kills descendants", async () => {
		const execution = launch(tree),
			pid = await descendant(execution)
		execution.child.kill()
		const result = await execution.done
		assert.notEqual(result.helperExit, 0)
		assert.equal(result.result, undefined)
		await assertGone(pid)
	})
	it("helper crash immediately after started also kills the root workload", async () => {
		const execution = launch("Start-Sleep -Seconds 60"),
			pid = await execution.started
		execution.child.kill()
		await execution.done
		await assertGone(pid)
	})
	it("helper crash before startup request cannot run any workload", async () => {
		const child: ChildProcessWithoutNullStreams = spawn(helper, ["--run"], {
			stdio: ["pipe", "pipe", "pipe"],
			env: windowsRuntimeEnvironment(process.env),
			windowsHide: true,
		})
		child.stdout.resume()
		child.stderr.resume()
		child.kill()
		await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()))
	})
})
