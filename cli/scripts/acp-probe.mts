#!/usr/bin/env -S npx tsx
/**
 * acp-probe — drive `dirac --acp` from a minimal ACP client, without Zed.
 *
 * Usage:
 *   npx tsx scripts/acp-probe.mts <subcommand> [flags]
 *
 * Subcommands:
 *   init                          initialize and exit (no session)
 *   new                           initialize + newSession, drain setup updates, exit
 *   prompt <text...>              initialize + newSession + one prompt
 *   load   <sessionId>            initialize + loadSession, drain replay, exit
 *   load-prompt <sessionId> <text..> loadSession + prompt (tests resumed-session flow)
 *   chat                          interactive multi-prompt (read stdin)
 *   set <configId> <value>        new + unstable_setSessionConfigOption + exit
 *
 * Common flags:
 *   --cmd <bin>          binary to spawn (default: dirac)
 *   --cwd <dir>          session cwd (default: process.cwd())
 *   --config <dir>       --config passed to dirac
 *   --no-fs              don't advertise fs.readTextFile/writeTextFile
 *   --no-load            don't advertise loadSession capability
 *   --reject             reject all permission requests (default: auto-approve "allow_once")
 *   --approve-delay-ms <n>  wait n ms before answering each permission request, to
 *                           simulate a slow human approving in Zed (default 0)
 *   --idle-ms <n>        drain quiet-period before considering "new" complete (default 1500)
 *   --timeout-ms <n>     hard overall timeout (default 60000)
 *   --log <path>         raw JSON-RPC frame log (default /tmp/dirac-acp-probe.frames.log)
 *   --stderr-log <path>  capture dirac stderr to file (default /tmp/dirac-acp-probe.stderr.log)
 *   --verbose            print every Client method invocation as it happens
 *
 * Exit codes:
 *   0 = clean run, 1 = error from dirac/probe, 124 = timeout
 */

import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { createWriteStream, type WriteStream } from "node:fs"
import * as readline from "node:readline/promises"
import * as acp from "@agentclientprotocol/sdk"

type Argv = {
	sub: string
	rest: string[]
	cmd: string
	cwd: string
	config?: string
	noFs: boolean
	noLoad: boolean
	reject: boolean
	idleMs: number
	timeoutMs: number
	frameLog: string
	stderrLog: string
	verbose: boolean
	preSets: Array<{ configId: string; value: string }>
	approveDelayMs: number
}

function parseArgs(): Argv {
	const args = process.argv.slice(2)
	const out: Argv = {
		sub: "",
		rest: [],
		cmd: "dirac",
		cwd: process.cwd(),
		noFs: false,
		noLoad: false,
		reject: false,
		idleMs: 1500,
		timeoutMs: 60000,
		frameLog: "/tmp/dirac-acp-probe.frames.log",
		stderrLog: "/tmp/dirac-acp-probe.stderr.log",
		verbose: false,
		preSets: [],
		approveDelayMs: 0,
	}
	const positional: string[] = []
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		const next = () => args[++i]
		switch (a) {
			case "--cmd":
				out.cmd = next()
				break
			case "--cwd":
				out.cwd = next()
				break
			case "--config":
				out.config = next()
				break
			case "--no-fs":
				out.noFs = true
				break
			case "--no-load":
				out.noLoad = true
				break
			case "--reject":
				out.reject = true
				break
			case "--idle-ms":
				out.idleMs = Number(next())
				break
			case "--timeout-ms":
				out.timeoutMs = Number(next())
				break
			case "--log":
				out.frameLog = next()
				break
			case "--stderr-log":
				out.stderrLog = next()
				break
			case "--verbose":
				out.verbose = true
				break
			case "--approve-delay-ms":
				out.approveDelayMs = Number(next())
				break
			case "--pre-set": {
				const kv = next()
				const eq = kv.indexOf("=")
				if (eq < 1) {
					console.error(`--pre-set requires key=value, got: ${kv}`)
					printHelpAndExit(2)
				}
				out.preSets.push({ configId: kv.slice(0, eq), value: kv.slice(eq + 1) })
				break
			}
			case "-h":
			case "--help":
				printHelpAndExit(0)
				break
			default:
				if (a.startsWith("--")) {
					console.error(`Unknown flag: ${a}`)
					printHelpAndExit(2)
				}
				positional.push(a)
		}
	}
	out.sub = positional[0] ?? "init"
	out.rest = positional.slice(1)
	return out
}

function printHelpAndExit(code: number): never {
	process.stderr.write(
		"Usage: npx tsx scripts/acp-probe.mts <init|new|prompt|load|chat> [flags]\n" + "See file header for full flag list.\n",
	)
	process.exit(code)
}

const TS = () => new Date().toISOString().slice(11, 23) // HH:MM:SS.mmm
const log = (tag: string, msg: string) => process.stderr.write(`[${TS()}] ${tag} ${msg}\n`)

/**
 * Wrap a stream so every chunk passing through is mirrored to a log file
 * with a direction marker. Used to tap raw JSON-RPC frames in both directions.
 */
function tapStream(
	src: ReadableStream<Uint8Array>,
	logFile: WriteStream,
	direction: "→A" | "→C", // →A: client to agent, →C: agent to client
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder()
	let buf = ""
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const reader = src.getReader()
			try {
				while (true) {
					const { value, done } = await reader.read()
					if (done) {
						controller.close()
						return
					}
					buf += decoder.decode(value, { stream: true })
					let nl: number
					while ((nl = buf.indexOf("\n")) >= 0) {
						const line = buf.slice(0, nl)
						buf = buf.slice(nl + 1)
						if (line.trim()) logFile.write(`[${TS()}] ${direction} ${line}\n`)
					}
					controller.enqueue(value)
				}
			} catch (err) {
				controller.error(err)
			}
		},
	})
}

/**
 * Tap the writable side: same shape, mirror chunks before forwarding.
 */
function tapWritable(dst: WritableStream<Uint8Array>, logFile: WriteStream, direction: "→A" | "→C"): WritableStream<Uint8Array> {
	const decoder = new TextDecoder()
	let buf = ""
	const writer = dst.getWriter()
	return new WritableStream<Uint8Array>({
		async write(chunk) {
			buf += decoder.decode(chunk, { stream: true })
			let nl: number
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl)
				buf = buf.slice(nl + 1)
				if (line.trim()) logFile.write(`[${TS()}] ${direction} ${line}\n`)
			}
			await writer.write(chunk)
		},
		async close() {
			await writer.close()
		},
		async abort(reason) {
			await writer.abort(reason)
		},
	})
}

class ProbeClient implements acp.Client {
	private readonly argv: Argv
	private readonly counters = new Map<string, number>()
	public idleAt = Date.now()
	public availableCommandsSeen = false
	public sessionInfoSeen = false
	public lastError: string | null = null
	public toolCallIds = new Set<string>()
	public lastAgentText = ""

	constructor(argv: Argv) {
		this.argv = argv
	}

	private bump(key: string) {
		this.counters.set(key, (this.counters.get(key) ?? 0) + 1)
		this.idleAt = Date.now()
	}

	summary(): Record<string, number | boolean | string | null> {
		return {
			...Object.fromEntries(this.counters),
			availableCommandsSeen: this.availableCommandsSeen,
			sessionInfoSeen: this.sessionInfoSeen,
			toolCalls: this.toolCallIds.size,
			lastError: this.lastError,
		}
	}

	async sessionUpdate(params: acp.SessionNotification): Promise<void> {
		const kind = params.update?.sessionUpdate ?? "unknown"
		this.bump(`update:${kind}`)
		if (kind === "available_commands_update") this.availableCommandsSeen = true
		if (kind === "session_info_update") this.sessionInfoSeen = true
		if (kind === "tool_call") {
			const id = (params.update as any).toolCallId
			if (id) this.toolCallIds.add(id)
		}
		if (kind === "agent_message_chunk") {
			const c = (params.update as any).content
			if (c?.type === "text") this.lastAgentText += c.text
		}
		if (this.argv.verbose) {
			log("update", `${kind} ${JSON.stringify(params.update).slice(0, 200)}`)
		}
	}

	async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
		this.bump("requestPermission")
		const tool = params.toolCall?.title ?? "<no title>"
		log("permission", `requested for "${tool}" — ${params.options.length} options`)
		if (this.argv.approveDelayMs > 0) {
			log("permission", `(simulating human delay ${this.argv.approveDelayMs}ms before responding)`)
			await new Promise((r) => setTimeout(r, this.argv.approveDelayMs))
		}
		for (const opt of params.options) {
			log("permission", `  - ${opt.optionId} (${opt.kind}): ${opt.name}`)
		}
		if (this.argv.reject) {
			const reject = params.options.find((o) => o.kind === "reject_once") ?? params.options[params.options.length - 1]
			log("permission", `rejecting with optionId=${reject.optionId}`)
			return { outcome: { outcome: "selected", optionId: reject.optionId } }
		}
		// Default: pick allow_once if available, else allow_always, else first option
		const pick =
			params.options.find((o) => o.kind === "allow_once") ??
			params.options.find((o) => o.kind === "allow_always") ??
			params.options[0]
		log("permission", `auto-approving with optionId=${pick.optionId}`)
		return { outcome: { outcome: "selected", optionId: pick.optionId } }
	}

	async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
		this.bump("readTextFile")
		log("fs", `readTextFile path=${params.path} line=${params.line} limit=${params.limit}`)
		try {
			const { readFile } = await import("node:fs/promises")
			const content = await readFile(params.path, "utf8")
			return { content }
		} catch (err) {
			log("fs", `readTextFile failed: ${(err as Error).message}`)
			throw err
		}
	}

	async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
		this.bump("writeTextFile")
		log("fs", `writeTextFile path=${params.path} (${params.content.length} bytes)`)
		try {
			const { writeFile, mkdir } = await import("node:fs/promises")
			const { dirname } = await import("node:path")
			await mkdir(dirname(params.path), { recursive: true })
			await writeFile(params.path, params.content, "utf8")
			return {}
		} catch (err) {
			log("fs", `writeTextFile failed: ${(err as Error).message}`)
			throw err
		}
	}
}

async function waitForIdle(client: ProbeClient, idleMs: number, hardCapMs: number): Promise<void> {
	const start = Date.now()
	client.idleAt = Date.now()
	// Resolve once we've gone `idleMs` without a session update, or hit hardCapMs.
	while (true) {
		const sinceLast = Date.now() - client.idleAt
		const totalElapsed = Date.now() - start
		if (sinceLast >= idleMs) return
		if (totalElapsed >= hardCapMs) {
			log("idle", `hard cap reached at ${hardCapMs}ms while waiting for quiet period`)
			return
		}
		await new Promise((r) => setTimeout(r, 100))
	}
}

async function main(): Promise<number> {
	const argv = parseArgs()
	const frameLog = createWriteStream(argv.frameLog, { flags: "w" })
	const stderrLog = createWriteStream(argv.stderrLog, { flags: "w" })

	const childArgs = ["--acp"]
	if (argv.config) childArgs.push("--config", argv.config)
	if (argv.verbose) childArgs.push("--verbose")
	log("spawn", `${argv.cmd} ${childArgs.join(" ")} (cwd=${argv.cwd})`)

	const child = spawn(argv.cmd, childArgs, {
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
	})
	child.stderr.pipe(stderrLog)
	child.on("exit", (code, sig) => {
		log("agent-exit", `code=${code} signal=${sig}`)
	})
	child.on("error", (err) => {
		log("agent-error", err.message)
	})

	// Wire bidirectional taps for raw JSON-RPC frames.
	const rawIn = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>
	const rawOut = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
	const tappedIn = tapWritable(rawIn, frameLog, "→A")
	const tappedOut = tapStream(rawOut, frameLog, "→C")

	const stream = acp.ndJsonStream(tappedIn, tappedOut)
	const client = new ProbeClient(argv)
	const conn = new acp.ClientSideConnection(() => client, stream)

	// Global timeout.
	const timeoutHandle = setTimeout(() => {
		log("timeout", `${argv.timeoutMs}ms reached — killing agent`)
		child.kill("SIGTERM")
		setTimeout(() => child.kill("SIGKILL"), 500)
		process.exitCode = 124
	}, argv.timeoutMs)
	timeoutHandle.unref()

	let exitCode = 0
	try {
		// === initialize ===
		log("call", "initialize")
		const initRes = await conn.initialize({
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {
				fs: argv.noFs ? {} : { readTextFile: true, writeTextFile: true },
			},
		})
		log(
			"ok",
			`initialize → protocolVersion=${initRes.protocolVersion} agent=${initRes.agentInfo?.name}@${initRes.agentInfo?.version}`,
		)
		log("ok", `  capabilities=${JSON.stringify(initRes.agentCapabilities)}`)
		if (initRes.authMethods?.length) {
			log("ok", `  authMethods=${initRes.authMethods.map((m: any) => m.id).join(",")}`)
		}

		if (argv.sub === "init") {
			log("done", "init-only — exiting")
		} else if (argv.sub === "load") {
			const sessionId = argv.rest[0]
			if (!sessionId) {
				log("error", "load requires <sessionId>")
				exitCode = 2
			} else {
				log("call", `loadSession ${sessionId}`)
				try {
					const res = await conn.loadSession({ sessionId, cwd: argv.cwd, mcpServers: [] })
					log("ok", `loadSession → ${JSON.stringify(res)}`)
					await waitForIdle(client, argv.idleMs, argv.timeoutMs)
				} catch (err) {
					log("error", `loadSession failed: ${(err as Error).message}`)
					exitCode = 1
				}
			}
		} else if (argv.sub === "load-prompt") {
			const [sessionId, ...rest] = argv.rest
			const promptText = rest.join(" ")
			if (!sessionId || !promptText) {
				log("error", "load-prompt requires <sessionId> <text...>")
				exitCode = 2
			} else {
				log("call", `loadSession ${sessionId}`)
				try {
					const res = await conn.loadSession({ sessionId, cwd: argv.cwd, mcpServers: [] })
					log("ok", `loadSession → sessionId=${sessionId}`)
					await waitForIdle(client, argv.idleMs, argv.timeoutMs)
					log("info", `post-load summary: ${JSON.stringify(client.summary())}`)
					for (const { configId, value } of argv.preSets) {
						log("call", `pre-set ${configId}=${value}`)
						try {
							const r: any = await (conn as any).unstable_setSessionConfigOption({ sessionId, configId, value })
							const echoed = r?.configOptions?.find((o: any) => o.id === configId)
							log("ok", `pre-set ${configId}.currentValue=${echoed?.currentValue ?? "<not in response>"}`)
						} catch (err) {
							log("error", `pre-set ${configId} failed: ${(err as Error).message}`)
						}
					}
					log("call", `prompt: ${JSON.stringify(promptText)}`)
					client.lastAgentText = ""
					const promptRes = await conn.prompt({
						sessionId,
						prompt: [{ type: "text", text: promptText }],
					})
					log("ok", `prompt → stopReason=${promptRes.stopReason}`)
					if (client.lastAgentText) {
						log(
							"info",
							`agent text (${client.lastAgentText.length} chars): ${JSON.stringify(client.lastAgentText.slice(0, 500))}`,
						)
					}
					log("summary", JSON.stringify(client.summary()))
				} catch (err) {
					log("error", `load-prompt failed: ${(err as Error).message}`)
					exitCode = 1
				}
			}
		} else {
			// new / prompt / chat all need a session
			log("call", `newSession cwd=${argv.cwd}`)
			const session = await conn.newSession({ cwd: argv.cwd, mcpServers: [] })
			log("ok", `newSession → sessionId=${session.sessionId}`)
			await waitForIdle(client, argv.idleMs, argv.timeoutMs)
			log("info", `setup-update summary: ${JSON.stringify(client.summary())}`)

			for (const { configId, value } of argv.preSets) {
				log("call", `pre-set ${configId}=${value}`)
				try {
					const res: any = await (conn as any).unstable_setSessionConfigOption({
						sessionId: session.sessionId,
						configId,
						value,
					})
					const echoed = res?.configOptions?.find((o: any) => o.id === configId)
					log("ok", `pre-set ${configId}.currentValue=${echoed?.currentValue ?? "<not in response>"}`)
				} catch (err) {
					log("error", `pre-set ${configId} failed: ${(err as Error).message}`)
				}
			}

			if (argv.sub === "new") {
				log("done", "new-only — exiting")
			} else if (argv.sub === "prompt") {
				const text = argv.rest.join(" ")
				if (!text) {
					log("error", "prompt requires <text>")
					exitCode = 2
				} else {
					log("call", `prompt: ${JSON.stringify(text)}`)
					client.lastAgentText = ""
					try {
						const res = await conn.prompt({
							sessionId: session.sessionId,
							prompt: [{ type: "text", text }],
						})
						log("ok", `prompt → stopReason=${res.stopReason}`)
						if (client.lastAgentText) {
							log(
								"info",
								`agent text (${client.lastAgentText.length} chars): ${JSON.stringify(client.lastAgentText.slice(0, 500))}`,
							)
						}
					} catch (err) {
						log("error", `prompt failed: ${(err as Error).message}`)
						exitCode = 1
					}
				}
			} else if (argv.sub === "set") {
				const [configId, value] = argv.rest
				if (!configId || value === undefined) {
					log("error", "set requires <configId> <value>")
					exitCode = 2
				} else {
					log("call", `unstable_setSessionConfigOption ${configId}=${value}`)
					try {
						const res: any = await (conn as any).unstable_setSessionConfigOption({
							sessionId: session.sessionId,
							configId,
							value,
						})
						const echoed = res?.configOptions?.find((o: any) => o.id === configId)
						log(
							"ok",
							`setSessionConfigOption response: ${configId}.currentValue=${echoed?.currentValue ?? "<not in response>"}`,
						)
						// Also wait briefly for any follow-up config_option_update notification.
						await new Promise((r) => setTimeout(r, 500))
					} catch (err) {
						log("error", `setSessionConfigOption failed: ${(err as Error).message}`)
						exitCode = 1
					}
				}
			} else if (argv.sub === "chat") {
				const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
				while (true) {
					const text = (await rl.question("\n[you] > ")).trim()
					if (!text || text === "/quit" || text === "/exit") break
					client.lastAgentText = ""
					log("call", `prompt: ${JSON.stringify(text)}`)
					try {
						const res = await conn.prompt({
							sessionId: session.sessionId,
							prompt: [{ type: "text", text }],
						})
						log("ok", `prompt → stopReason=${res.stopReason}`)
					} catch (err) {
						log("error", `prompt failed: ${(err as Error).message}`)
					}
				}
				rl.close()
			} else {
				log("error", `unknown subcommand: ${argv.sub}`)
				exitCode = 2
			}
		}

		log("summary", JSON.stringify(client.summary()))
	} catch (err) {
		log("fatal", (err as Error).stack ?? (err as Error).message)
		exitCode = 1
	} finally {
		clearTimeout(timeoutHandle)
		try {
			child.stdin?.end()
		} catch {}
		// Give the agent ~300ms to flush, then kill.
		await new Promise((r) => setTimeout(r, 300))
		if (!child.killed) child.kill("SIGTERM")
		frameLog.end()
		stderrLog.end()
		log("logs", `frames=${argv.frameLog}  stderr=${argv.stderrLog}`)
	}
	return exitCode
}

main().then((code) => process.exit(code))
