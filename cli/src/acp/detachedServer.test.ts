import net from "node:net"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { PermissionHandler, RequestPermissionRequest } from "../agent/types.js"
import { listenForDetachedAcp, type DetachedAcpServer } from "./detachedServer.js"

const mocks = vi.hoisted(() => {
	class DiracAgent {
		static instance: DiracAgent | undefined
		permissionHandler: PermissionHandler | undefined
		readonly initialize = vi.fn().mockResolvedValue({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {},
			agentInfo: { name: "Dirac test agent", version: "test" },
		})
		readonly newSession = vi.fn().mockResolvedValue({ sessionId: "session-1" })
		readonly shutdown = vi.fn().mockResolvedValue(undefined)

		constructor() {
			DiracAgent.instance = this
		}

		setPermissionHandler(handler: PermissionHandler): void {
			this.permissionHandler = handler
		}

		setElicitationHandler(): void { }

		emitterForSession() {
			return { on: vi.fn(), off: vi.fn() }
		}

		publishSessionSetupUpdates = vi.fn().mockResolvedValue(undefined)

		requestPermission(request: Parameters<PermissionHandler>[0]): Promise<Parameters<PermissionHandler>[1] extends (response: infer Response) => void ? Response : never> {
			return new Promise((resolve) => this.permissionHandler?.(request, resolve))
		}
	}

	return { DiracAgent }
})

vi.mock("../agent/DiracAgent.js", () => ({ DiracAgent: mocks.DiracAgent }))

type JsonRpcFrame = {
	jsonrpc?: string
	id?: number | string
	method?: string
	params?: Record<string, unknown>
	result?: Record<string, unknown>
	error?: { code: number; message: string }
}

class RawSocketClient {
	readonly frames: JsonRpcFrame[] = []
	readonly socket: net.Socket
	#buffer = ""
	#nextId = 1
	#closed = false
	#pending = new Map<number, { resolve: (frame: JsonRpcFrame) => void; reject: (error: Error) => void }>()

	private constructor(socket: net.Socket) {
		this.socket = socket
		socket.setEncoding("utf8")
		socket.on("data", (chunk: string) => this.receive(chunk))
		socket.once("close", () => {
			this.#closed = true
			this.rejectPending(new Error("ACP socket closed"))
		})
		socket.once("error", (error) => this.rejectPending(error))
	}

	static async connect(socketPath: string): Promise<RawSocketClient> {
		const socket = net.createConnection(socketPath)
		await new Promise<void>((resolve, reject) => {
			socket.once("connect", resolve)
			socket.once("error", reject)
		})
		return new RawSocketClient(socket)
	}

	request(method: string, params: Record<string, unknown>): Promise<JsonRpcFrame> {
		const id = this.#nextId++
		const response = new Promise<JsonRpcFrame>((resolve, reject) => this.#pending.set(id, { resolve, reject }))
		this.write({ jsonrpc: "2.0", id, method, params })
		return response
	}

	respond(id: number | string, result: Record<string, unknown>): void {
		this.write({ jsonrpc: "2.0", id, result })
	}

	async initialize(): Promise<JsonRpcFrame> {
		return this.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
	}

	async waitForRequest(method: string, timeoutMs = 2_000): Promise<JsonRpcFrame> {
		return waitFor(() => this.frames.find((frame) => frame.method === method), timeoutMs)
	}

	async waitForClose(timeoutMs = 2_000): Promise<void> {
		await waitFor(() => (this.#closed ? true : undefined), timeoutMs)
	}

	async close(): Promise<void> {
		if (this.#closed) return
		this.socket.destroy()
		await this.waitForClose()
	}

	private write(frame: JsonRpcFrame): void {
		if (this.#closed || this.socket.destroyed) throw new Error("ACP socket is closed")
		this.socket.write(`${JSON.stringify(frame)}\n`)
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
		if (typeof frame.id === "number" && (frame.result || frame.error) && !frame.method) {
			const pending = this.#pending.get(frame.id)
			if (pending) {
				this.#pending.delete(frame.id)
				pending.resolve(frame)
				return
			}
		}
		this.frames.push(frame)
	}

	private rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error)
		this.#pending.clear()
	}
}

const clients: RawSocketClient[] = []
let server: DetachedAcpServer | undefined
let tempDirectory: string | undefined
let socketPath: string

beforeEach(async () => {
	vi.clearAllMocks()
	mocks.DiracAgent.instance = undefined
	tempDirectory = await mkdtemp(path.join(tmpdir(), "dirac-detached-acp-"))
	socketPath = path.join(tempDirectory, "agent.sock")
	server = await listenForDetachedAcp({ socketPath, cwd: tempDirectory })
})

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()))
	await server?.close()
	server = undefined
	if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
})

describe("detached ACP server", () => {
	it("replaces the active client without allowing the stale close to clobber the replacement", async () => {
		const first = await connectClient()
		await first.initialize()
		const second = await connectClient()
		await second.initialize()

		await first.waitForClose()
		expect(() => first.request("session/new", { cwd: tempDirectory, mcpServers: [] })).toThrow("closed")

		await expect(second.request("session/new", { cwd: tempDirectory, mcpServers: [] })).resolves.toMatchObject({
			result: { sessionId: "session-1" },
		})
		expect(mocks.DiracAgent.instance?.newSession).toHaveBeenCalledTimes(1)
	})

	it("transfers a pending permission to the replacement client exactly once", async () => {
		const first = await connectClient()
		await first.initialize()
		const permission = mocks.DiracAgent.instance!.requestPermission(permissionRequest())
		const firstRequest = await first.waitForRequest("session/request_permission")

		const second = await connectClient()
		await first.waitForClose()
		const transferred = await second.waitForRequest("session/request_permission")
		await second.initialize()
		expect(second.frames.filter((frame) => frame.method === "session/request_permission")).toHaveLength(1)

		second.respond(transferred.id!, { outcome: { outcome: "selected", optionId: "allow-once" } })
		await expect(permission).resolves.toEqual({ outcome: { outcome: "selected", optionId: "allow-once" } })
		expect(firstRequest.id).toBeDefined()
		await new Promise((resolve) => setTimeout(resolve, 25))
		expect(second.frames.filter((frame) => frame.method === "session/request_permission")).toHaveLength(1)
	})

	it("cancels a retained permission when the server closes", async () => {
		const client = await connectClient()
		await client.initialize()
		await client.close()
		const permission = mocks.DiracAgent.instance!.requestPermission(permissionRequest())

		await server!.close()
		server = undefined

		await expect(permission).resolves.toEqual({ outcome: { outcome: "cancelled" } })
	})
})

async function connectClient(): Promise<RawSocketClient> {
	const client = await RawSocketClient.connect(socketPath)
	clients.push(client)
	return client
}

function permissionRequest(): RequestPermissionRequest {
	return {
		sessionId: "session-1",
		toolCall: { toolCallId: "tool-1" },
		options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
	}
}

async function waitFor<T>(select: () => T | undefined, timeoutMs: number): Promise<T> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const value = select()
		if (value !== undefined) return value
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error("Timed out waiting for detached ACP event")
}
