import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"

type JsonRpcFrame = {
	jsonrpc?: string
	id?: number | string
	method?: string
	params?: Record<string, unknown>
	result?: Record<string, unknown>
	error?: { code: number; message: string }
}

class RawAcpClient {
	readonly child: ChildProcessWithoutNullStreams
	readonly updates: JsonRpcFrame[] = []
	readonly permissions: JsonRpcFrame[] = []
	readonly stderr: string[] = []
	#buffer = ""
	#nextId = 1
	#pending = new Map<number, { resolve: (frame: JsonRpcFrame) => void; reject: (error: Error) => void }>()

	constructor(configDir: string, cwd: string, cliArgs: string[] = []) {
		const cliEntry = path.resolve(process.cwd(), "dist/cli.mjs")
		this.child = spawn(process.execPath, [cliEntry, "--acp", "--config", configDir, "--cwd", cwd, ...cliArgs], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd,
			env: { ...process.env, VITEST: undefined }
		})
		this.child.stdout.setEncoding("utf8")
		this.child.stderr.setEncoding("utf8")
		this.child.stdout.on("data", (chunk: string) => this.receive(chunk))
		this.child.stdin.on("error", (error) => this.stderr.push(`stdin error: ${error.message}`))
		this.child.on("error", (error) => this.rejectPending(error))
		this.child.on("exit", (code, signal) => {
			if (this.#pending.size > 0) {
				this.rejectPending(new Error(`ACP process exited (${code ?? "null"}, ${signal ?? "none"}); stderr: ${this.stderr.join("")}`))
			}
		})
	}

	async initialize(): Promise<JsonRpcFrame> {
		return this.request("initialize", {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
		})
	}

	request(method: string, params: Record<string, unknown>): Promise<JsonRpcFrame> {
		const id = this.#nextId++
		const response = new Promise<JsonRpcFrame>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject })
		})
		this.write({ jsonrpc: "2.0", id, method, params })
		return response
	}

	notify(method: string, params: Record<string, unknown>): void {
		this.write({ jsonrpc: "2.0", method, params })
	}

	write(frame: JsonRpcFrame | string): void {
		if (this.child.stdin.writableEnded) throw new Error(`ACP stdin closed before sending ${typeof frame === "string" ? frame : JSON.stringify(frame)}; stderr: ${this.stderr.join("")}`)
		this.child.stdin.write(`${typeof frame === "string" ? frame : JSON.stringify(frame)}\n`)
	}

	async waitForPermission(timeoutMs = 10_000): Promise<JsonRpcFrame> {
		return this.waitFor(() => this.permissions[0], timeoutMs)
	}

	async close(): Promise<void> {
		this.child.stdin.end()
		if (this.child.exitCode !== null) return
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.child.kill("SIGKILL")
				resolve()
			}, 2_000)
			this.child.once("exit", () => {
				clearTimeout(timeout)
				resolve()
			})
		})
	}

	private receive(chunk: string): void {
		this.#buffer += chunk
		let newline = this.#buffer.indexOf("\n")
		while (newline >= 0) {
			const line = this.#buffer.slice(0, newline)
			this.#buffer = this.#buffer.slice(newline + 1)
			if (line.trim()) this.receiveFrame(JSON.parse(line) as JsonRpcFrame)
			newline = this.#buffer.indexOf("\n")
		}
	}

	private receiveFrame(frame: JsonRpcFrame): void {
		if (typeof frame.id === "number" && (frame.result || frame.error)) {
			const pending = this.#pending.get(frame.id)
			if (pending) {
				this.#pending.delete(frame.id)
				pending.resolve(frame)
				return
			}
		}
		if (frame.method === "session/update") this.updates.push(frame)
		if (frame.method === "session/request_permission") this.permissions.push(frame)
	}

	private async waitFor<T>(select: () => T | undefined, timeoutMs: number): Promise<T> {
		const startedAt = Date.now()
		while (true) {
			const value = select()
			if (value) return value
			if (Date.now() - startedAt >= timeoutMs) {
				throw new Error(`Timed out waiting for ACP notification. stderr: ${this.stderr.join("")}`)
			}
			await new Promise((resolve) => setTimeout(resolve, 10))
		}
	}

	private rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error)
		this.#pending.clear()
	}
}

const clients: RawAcpClient[] = []
const workspaces: string[] = []
const configs: string[] = []

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()))
	await Promise.all([...workspaces.splice(0), ...configs.splice(0)].map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("ACP protocol conformance over raw stdio", () => {
	it("continues after malformed and schema-invalid frames", async () => {
		const { client } = await createClient()
		client.write("this is not JSON")
		client.write({ jsonrpc: "2.0", id: 99, method: "initialize", params: {} })

		const initialized = await client.initialize()
		expect(initialized.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
	})

	it("round-trips config changes and emits a config update", async () => {
		const { client, cwd } = await createClient()
		await client.initialize()
		const session = await client.request("session/new", { cwd, mcpServers: [] })
		const sessionId = session.result?.sessionId as string

		const configured = await client.request("session/set_config_option", {
			sessionId,
			configId: "mode",
			value: "plan",
		})
		expect(configured.result?.configOptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "mode", currentValue: "plan" })]),
		)
		await waitForUpdate(client, "config_option_update")
	})

	it("uses explicit startup provider and model until the ACP client changes them", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const client = createRawClient(configDir, cwd, [
			"--provider",
			"deepseek",
			"--model",
			"deepseek-v4-flash",
		])
		await client.initialize()

		const session = await client.request("session/new", { cwd, mcpServers: [] })
		const sessionId = session.result?.sessionId as string
		expect(session.result?.configOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "provider", currentValue: "deepseek" }),
				expect.objectContaining({ id: "model", currentValue: "deepseek-v4-flash" }),
			]),
		)

		const configured = await client.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: "deepseek-v4-pro",
		})
		expect(configured.result?.configOptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "model", currentValue: "deepseek-v4-pro" })]),
		)
	})

	it("rejects an explicit startup provider without a model", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const client = createRawClient(configDir, cwd, ["--provider", "deepseek"])

		await expect(client.initialize()).resolves.toMatchObject({
			error: { message: expect.stringContaining("--provider requires --model") },
		})
	})

	it("cancels a prompt while a permission request is pending", async () => {
		const { client, cwd } = await createClient()
		await client.initialize()
		const session = await client.request("session/new", { cwd, mcpServers: [] })
		const sessionId = session.result?.sessionId as string

		const prompt = client.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "Use the write_to_file tool to create a file named cancelled.txt containing cancelled." }],
		})
		const permission = await client.waitForPermission(30_000)
		expect(permission.params?.sessionId).toBe(sessionId)
		client.notify("session/cancel", { sessionId })

		await expect(prompt).resolves.toMatchObject({ result: { stopReason: "cancelled" } })
	}, 45_000)

	it("loads and replays a persisted session in a new ACP process", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const sessionId = crypto.randomUUID()
		await seedPersistedSession(configDir, cwd, sessionId)

		const first = createRawClient(configDir, cwd)
		await first.initialize()
		await expect(first.request("session/load", { sessionId, cwd, mcpServers: [] })).resolves.toMatchObject({ result: expect.any(Object) })
		await expect(waitForUpdate(first, "user_message_chunk")).resolves.toMatchObject({
			params: {
				sessionId,
				update: { content: { type: "text", text: "Persisted user message" } },
			},
		})
		await first.close()

		const second = createRawClient(configDir, cwd)
		await second.initialize()
		await expect(second.request("session/load", { sessionId, cwd, mcpServers: [] })).resolves.toMatchObject({ result: expect.any(Object) })
		await expect(waitForUpdate(second, "user_message_chunk")).resolves.toMatchObject({
			params: {
				sessionId,
				update: { content: { type: "text", text: "Persisted user message" } },
			},
		})
	})
})

async function createClient(): Promise<{ client: RawAcpClient; cwd: string }> {
	const configDir = await temporaryDirectory("dirac-acp-config-")
	const cwd = await temporaryDirectory("dirac-acp-workspace-")
	return { client: createRawClient(configDir, cwd), cwd }
}

function createRawClient(configDir: string, cwd: string, cliArgs: string[] = []): RawAcpClient {
	const client = new RawAcpClient(configDir, cwd, cliArgs)
	clients.push(client)
	return client
}

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), prefix))
	if (prefix.includes("config")) configs.push(directory)
	else workspaces.push(directory)
	return directory
}

async function seedPersistedSession(configDir: string, cwd: string, sessionId: string): Promise<void> {
	const timestamp = Date.now()
	const taskDirectory = path.join(configDir, "data", "tasks", sessionId)
	await mkdir(path.join(configDir, "data", "state"), { recursive: true })
	await mkdir(taskDirectory, { recursive: true })
	await writeFile(
		path.join(configDir, "data", "state", "taskHistory.json"),
		JSON.stringify([
			{
				id: sessionId,
				ulid: sessionId,
				ts: timestamp,
				task: "Persisted ACP session",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				cwdOnTaskInitialization: cwd,
				workspaceRootPath: cwd,
			},
		]),
	)
	await writeFile(path.join(taskDirectory, "api_conversation_history.json"), "[]")
	await writeFile(
		path.join(taskDirectory, "ui_messages.json"),
		JSON.stringify([
			{
				id: "persisted-user-message",
				ts: timestamp,
				content: {
					type: "markdown",
					role: "user",
					content: "Persisted user message",
				},
			},
			{
				id: "persisted-agent-message",
				ts: timestamp + 1,
				content: {
					type: "markdown",
					role: "assistant",
					content: "Persisted assistant message",
				},
			},
		]),
	)
}


async function waitForUpdate(client: RawAcpClient, kind: string, timeoutMs = 10_000): Promise<JsonRpcFrame> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const update = client.updates.find((frame) => frame.params?.update && (frame.params.update as Record<string, unknown>).sessionUpdate === kind)
		if (update) return update
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`Timed out waiting for ${kind}. stderr: ${client.stderr.join("")}`)
}
