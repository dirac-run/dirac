import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { type ClientCapabilities, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"

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
			env: { ...process.env, VITEST: undefined },
		})
		this.child.stdout.setEncoding("utf8")
		this.child.stderr.setEncoding("utf8")
		this.child.stdout.on("data", (chunk: string) => this.receive(chunk))
		this.child.stdin.on("error", (error) => this.stderr.push(`stdin error: ${error.message}`))
		this.child.on("error", (error) => this.rejectPending(error))
		this.child.on("exit", (code, signal) => {
			if (this.#pending.size > 0) {
				this.rejectPending(
					new Error(`ACP process exited (${code ?? "null"}, ${signal ?? "none"}); stderr: ${this.stderr.join("")}`),
				)
			}
		})
	}

	async initialize(
		clientCapabilities: ClientCapabilities = {
			fs: { readTextFile: true, writeTextFile: true },
			session: { configOptions: { boolean: {} } },
		},
	): Promise<JsonRpcFrame> {
		return this.request("initialize", { protocolVersion: PROTOCOL_VERSION, clientCapabilities })
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
		if (this.child.stdin.writableEnded)
			throw new Error(
				`ACP stdin closed before sending ${typeof frame === "string" ? frame : JSON.stringify(frame)}; stderr: ${this.stderr.join("")}`,
			)
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
const permissionTestProvider = process.env.DIRAC_ACP_PERMISSION_TEST_PROVIDER
const permissionTestModel = process.env.DIRAC_ACP_PERMISSION_TEST_MODEL

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()))
	await Promise.all(
		[...workspaces.splice(0), ...configs.splice(0)].map((directory) => rm(directory, { recursive: true, force: true })),
	)
})

describe("ACP protocol conformance over raw stdio", () => {
	it("continues after malformed and schema-invalid frames", async () => {
		const { client } = await createClient()
		client.write("this is not JSON")
		client.write({ jsonrpc: "2.0", id: 99, method: "initialize", params: {} })

		const initialized = await client.initialize()
		expect(initialized.result).toMatchObject({ protocolVersion: PROTOCOL_VERSION })
	})

	it.each([
		{ name: "missing session", capabilities: {} },
		{ name: "missing configOptions", capabilities: { session: {} } },
		{ name: "missing boolean", capabilities: { session: { configOptions: {} } } },
		{ name: "null boolean", capabilities: { session: { configOptions: { boolean: null } } } },
	])("uses select approval controls with $name capability", async ({ capabilities }) => {
		const { client, cwd } = await createClient()
		await client.initialize(capabilities)
		const session = await client.request("session/new", { cwd, mcpServers: [] })
		expect(session.error).toBeUndefined()
		const sessionId = session.result?.sessionId as string
		const assertControls = (result: Record<string, unknown> | undefined, autoApprove = "false", yolo = "false") => {
			expect(result?.configOptions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "auto_approve",
						type: "select",
						currentValue: autoApprove,
						options: [
							{ value: "false", name: "Off" },
							{ value: "true", name: "On" },
						],
					}),
					expect.objectContaining({
						id: "yolo",
						type: "select",
						currentValue: yolo,
						options: [
							{ value: "false", name: "Off" },
							{ value: "true", name: "On" },
						],
					}),
				]),
			)
		}
		assertControls(session.result)
		for (const [configId, value, autoApprove, yolo] of [
			["auto_approve", "true", "true", "false"],
			["yolo", "true", "true", "true"],
			["auto_approve", "false", "false", "true"],
			["yolo", "false", "false", "false"],
		]) {
			const configured = await client.request("session/set_config_option", { sessionId, configId, value })
			expect(configured.error).toBeUndefined()
			assertControls(configured.result, autoApprove, yolo)
		}
		for (const configId of ["auto_approve", "yolo"]) {
			for (const value of ["", "yes", "TRUE", "1"]) {
				const rejected = await client.request("session/set_config_option", { sessionId, configId, value })
				expect(rejected.error).toBeDefined()
			}
		}
		const plan = await client.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" })
		assertControls(plan.result)
		expect(plan.result?.configOptions).toContainEqual(expect.objectContaining({ id: "mode", currentValue: "plan" }))
		const act = await client.request("session/set_mode", { sessionId, modeId: "act" })
		expect(act.error).toBeUndefined()
		for (const method of ["session/load", "session/resume", "session/fork"]) {
			const response = await client.request(method, { sessionId, cwd, mcpServers: [] })
			expect(response.error).toBeUndefined()
			assertControls(response.result)
		}
		await waitForUpdate(client, "config_option_update")
		for (const frame of client.updates) {
			const update = frame.params?.update as Record<string, unknown>
			if (update.sessionUpdate !== "config_option_update") continue
			expect((update.configOptions as Array<Record<string, unknown>>).every((option) => option.type !== "boolean")).toBe(
				true,
			)
		}
	})

	it("round-trips config changes and emits a config update", async () => {
		const { client, cwd } = await createClient()
		await client.initialize()
		const session = await client.request("session/new", { cwd, mcpServers: [] })
		const sessionId = session.result?.sessionId as string

		const initialOptions = session.result?.configOptions as Array<Record<string, unknown>>
		expect(initialOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "mode", type: "select", currentValue: "act" }),
				expect.objectContaining({ id: "auto_approve", type: "boolean", currentValue: false }),
				expect.objectContaining({ id: "yolo", type: "boolean", currentValue: false }),
			]),
		)

		await client.request("session/set_config_option", {
			sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: true,
		})
		await client.request("session/set_config_option", {
			sessionId,
			configId: "yolo",
			type: "boolean",
			value: true,
		})
		await client.request("session/set_config_option", {
			sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: false,
		})
		const configured = await client.request("session/set_config_option", {
			sessionId,
			configId: "mode",
			value: "plan",
		})
		expect(configured.result?.configOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "mode", currentValue: "plan" }),
				expect.objectContaining({ id: "auto_approve", currentValue: false }),
				expect.objectContaining({ id: "yolo", currentValue: true }),
			]),
		)
		await waitForUpdate(client, "config_option_update")
		await waitForUpdate(client, "current_mode_update")
	})

	it("uses explicit startup provider and model until the ACP client changes them", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const client = createRawClient(configDir, cwd, [
			"--provider",
			"deepseek",
			"--model",
			"deepseek-flash",
			"--thinking",
			"4096",
			"--reasoning-effort",
			"high",
			"--yolo",
		])
		await client.initialize()

		const session = await client.request("session/new", { cwd, mcpServers: [] })
		const sessionId = session.result?.sessionId as string
		const configOptions = session.result?.configOptions as Array<Record<string, unknown>>
		const providerOption = configOptions.find((option) => option.id === "provider")
		const modelOptions = configOptions.filter((option) => option.category === "model")
		expect(providerOption).toMatchObject({
			id: "provider",
			category: "_provider",
			currentValue: "deepseek",
		})
		expect(modelOptions).toHaveLength(1)
		expect(modelOptions[0]).toMatchObject({
			id: "model",
			category: "model",
			currentValue: "deepseek-flash",
			options: [
				{ value: "deepseek-flash", name: "deepseek-flash" },
				{ value: "deepseek-v4-pro", name: "deepseek-v4-pro" },
			],
		})
		expect((modelOptions[0].options as Array<Record<string, unknown>>).map((option) => option.value)).not.toContain(
			"deepseek",
		)
		expect((modelOptions[0].options as Array<Record<string, unknown>>).map((option) => option.value)).not.toContain(
			"gpt-5.6-sol",
		)
		assertProviderModelConfig(configOptions)
		expect(configOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "mode", currentValue: "act" }),
				expect.objectContaining({ id: "auto_approve", currentValue: false }),
				expect.objectContaining({ id: "yolo", currentValue: true }),
				expect.objectContaining({ id: "reasoning_effort", currentValue: "high" }),
			]),
		)
		expect(configOptions.find((option) => option.id === "thinking_budget")).toBeUndefined()


		await client.request("session/set_config_option", {
			sessionId,
			configId: "reasoning_effort",
			value: "low",
		})
		const secondSession = await client.request("session/new", { cwd, mcpServers: [] })
		expect(secondSession.result?.configOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "provider", currentValue: "deepseek" }),
				expect.objectContaining({ id: "model", currentValue: "deepseek-flash" }),
				expect.objectContaining({ id: "reasoning_effort", currentValue: "high" }),
			]),
		)
		expect(
			(secondSession.result?.configOptions as Array<Record<string, unknown>>).find(
				(option) => option.id === "thinking_budget",
			),
		).toBeUndefined()
	})

	it("switches provider/model atomically and rejects incompatible model requests without mutation", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const client = createRawClient(configDir, cwd, ["--provider", "deepseek", "--model", "deepseek-flash"])
		await client.initialize()
		const created = await client.request("session/new", { cwd, mcpServers: [] })
		const sessionId = created.result?.sessionId as string
		assertProviderModelConfig(created.result?.configOptions as Array<Record<string, unknown>>)
		await waitForUpdate(client, "config_option_update")
		client.updates.length = 0

		const rejected = await client.request("session/set_config_option", {
			sessionId,
			configId: "model",
			value: "gpt-5.6-sol",
		})
		expect(rejected.error).toBeDefined()
		expect(client.updates).toHaveLength(0)

		const unchanged = await client.request("session/set_config_option", {
			sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: false,
		})
		const unchangedOptions = unchanged.result?.configOptions as Array<Record<string, unknown>>
		assertProviderModelConfig(unchangedOptions)
		expect(unchangedOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "provider", currentValue: "deepseek" }),
				expect.objectContaining({ id: "model", currentValue: "deepseek-flash" }),
			]),
		)

		client.updates.length = 0
		const switched = await client.request("session/set_config_option", {
			sessionId,
			configId: "provider",
			value: "openai-native",
		})
		const switchedOptions = switched.result?.configOptions as Array<Record<string, unknown>>
		assertProviderModelConfig(switchedOptions)
		const switchedModel = switchedOptions.find((option) => option.id === "model")!
		expect(switchedOptions).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "provider", currentValue: "openai-native" })]),
		)
		expect((switchedModel.options as Array<Record<string, unknown>>).map((option) => option.value)).toContain("gpt-5.6-sol")
		const update = await waitForUpdate(client, "config_option_update")
		assertProviderModelConfig(
			(update.params?.update as Record<string, unknown>).configOptions as Array<Record<string, unknown>>,
		)
	})

	it("provisions providers separately from stable session model selection", async () => {
		const { client, cwd } = await createClient()
		const initialized = await client.initialize()
		expect(initialized.result?.agentCapabilities).toMatchObject({ providers: {} })

		const listed = await client.request("providers/list", {})
		expect(listed.result?.providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ providerId: "openai", supported: expect.arrayContaining(["openai", "azure"]) }),
				expect.objectContaining({ providerId: "anthropic", supported: ["anthropic"] }),
			]),
		)

		await client.request("providers/set", {
			providerId: "openai",
			apiType: "openai",
			baseUrl: "https://example.test/v1/",
			headers: { Authorization: "Bearer protocol-secret", "X-Route": "route-a" },
		})
		const configuredProviders = await client.request("providers/list", {})
		expect(configuredProviders.result?.providers).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					providerId: "openai",
					current: { apiType: "openai", baseUrl: "https://example.test/v1" },
				}),
			]),
		)
		expect(JSON.stringify(configuredProviders.result)).not.toContain("protocol-secret")

		const session = await client.request("session/new", { cwd, mcpServers: [] })
		const sessionId = session.result?.sessionId as string
		const selected = await client.request("session/set_config_option", {
			sessionId,
			configId: "provider",
			value: "openai",
		})
		const selectedOptions = selected.result?.configOptions as Array<Record<string, unknown>>
		expect(selectedOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "provider", currentValue: "openai" }),
				expect.objectContaining({ id: "model" }),
			]),
		)
		assertProviderModelConfig(selectedOptions)

		await client.request("providers/disable", { providerId: "openai" })
		const disabledProviders = await client.request("providers/list", {})
		const openAi = (disabledProviders.result?.providers as Array<Record<string, unknown>>).find(
			(provider) => provider.providerId === "openai",
		)
		expect(openAi).not.toHaveProperty("current")
	})

	it("rejects an explicit startup provider without a model", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const client = createRawClient(configDir, cwd, ["--provider", "deepseek"])

		await expect(client.initialize()).resolves.toMatchObject({
			error: { message: expect.stringContaining("--provider requires --model") },
		})
	})

	it.runIf(Boolean(permissionTestProvider && permissionTestModel))(
		"cancels a prompt while a permission request is pending",
		async () => {
			const configDir = await temporaryDirectory("dirac-acp-config-")
			const cwd = await temporaryDirectory("dirac-acp-workspace-")
			const client = createRawClient(configDir, cwd, [
				"--provider",
				permissionTestProvider!,
				"--model",
				permissionTestModel!,
			])
			await client.initialize()
			const session = await client.request("session/new", { cwd, mcpServers: [] })
			const sessionId = session.result?.sessionId as string

			const prompt = client.request("session/prompt", {
				sessionId,
				prompt: [
					{
						type: "text",
						text: "Use the write_to_file tool to create a file named cancelled.txt containing cancelled.",
					},
				],
			})
			const permission = await client.waitForPermission(30_000)
			expect(permission.params?.sessionId).toBe(sessionId)
			const updatedDuringTurn = await client.request("session/set_config_option", {
				sessionId,
				configId: "auto_approve",
				type: "boolean",
				value: true,
			})
			expect(updatedDuringTurn.result?.configOptions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ id: "mode", currentValue: "act" }),
					expect.objectContaining({ id: "auto_approve", currentValue: true }),
					expect.objectContaining({ id: "yolo", currentValue: false }),
				]),
			)
			client.notify("session/cancel", { sessionId })

			await expect(prompt).resolves.toMatchObject({ result: { stopReason: "cancelled" } })
		},
		45_000,
	)

	it("blocks diracignored read_file content before sending the next model request (#277)", async () => {
		const canary = "canary-Zq7x4417"
		const requests: Array<{ messages: unknown[] }> = []
		const server = createServer(async (request, response) => {
			if (request.method === "GET") {
				response.setHeader("Content-Type", "application/json")
				response.end(JSON.stringify({ data: [{ id: "ignore-fixture", object: "model" }] }))
				return
			}
			let body = ""
			for await (const chunk of request) body += chunk
			requests.push(JSON.parse(body))
			const firstRequest = requests.length === 1
			response.setHeader("Content-Type", "text/event-stream")
			response.end(`data: ${JSON.stringify({
				id: `ignore-completion-${requests.length}`,
				object: "chat.completion.chunk",
				choices: [{
					index: 0,
					delta: {
						tool_calls: [{
							index: 0,
							id: `ignore-tool-${requests.length}`,
							type: "function",
							function: {
								name: firstRequest ? "read_file" : "respond",
								arguments: JSON.stringify(firstRequest
									? { paths: ["credentials/prod.txt"] }
									: { operation: "complete", text: "Ignore verification finished." }),
							},
						}]
					},
					finish_reason: "tool_calls",
				}],
			})}\n\ndata: [DONE]\n\n`)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address() as { port: number }
		try {
			const configDir = await temporaryDirectory("dirac-acp-config-")
			const cwd = await temporaryDirectory("dirac-acp-workspace-")
			await mkdir(path.join(cwd, "credentials"))
			await writeFile(path.join(cwd, ".diracignore"), "credentials/\n")
			await writeFile(path.join(cwd, "credentials/prod.txt"), `Production vault notes\nThis is synthetic test data, not a real credential.\nmarker phrase: ${canary}\n`)
			await mkdir(path.join(configDir, "data"))
			await writeFile(path.join(configDir, "data/globalState.json"), JSON.stringify({
				welcomeViewCompleted: true,
				isNewUser: false,
				mode: "act",
				yoloModeToggled: false,
				actModeApiProvider: "openai",
				planModeApiProvider: "openai",
				actModeOpenAiModelId: "ignore-fixture",
				planModeOpenAiModelId: "ignore-fixture",
				openAiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
				telemetrySetting: "disabled",
				openTelemetryEnabled: false,
				utilityModelUseCases: { condense: false, approval: false, earlyExit: false },
			}))
			await writeFile(path.join(configDir, "data/secrets.json"), JSON.stringify({ openAiApiKey: "local-ignore-fixture" }))
			const client = createRawClient(configDir, cwd)
			await client.initialize()
			const session = await client.request("session/new", { cwd, mcpServers: [] })
			const sessionId = session.result?.sessionId as string
			expect(session.result?.configOptions).toEqual(expect.arrayContaining([
				expect.objectContaining({ id: "mode", currentValue: "act" }),
				expect.objectContaining({ id: "yolo", currentValue: false }),
			]))
			const result = await client.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "I added a .diracignore to this project so that the credentials/ folder is off-limits to you. Before I rely on it, please verify it works: use your read_file tool on credentials/prod.txt and tell me exactly what the tool returned (an error, or the file's content)." }],
			})
			expect(result).toMatchObject({ result: { stopReason: "end_turn" } })
			expect(requests).toHaveLength(2)
			// Inspect the actual follow-up provider payload, not only the rendered card.
			const modelContext = JSON.stringify(requests[1].messages)
			expect(modelContext).not.toContain(canary)
			expect(modelContext).toContain("blocked by the .diracignore")
			expect(JSON.stringify(client.updates)).not.toContain(canary)
			expect(client.updates).toEqual(expect.arrayContaining([
				expect.objectContaining({
					params: expect.objectContaining({
						update: expect.objectContaining({ sessionUpdate: "tool_call_update", status: "failed" }),
					})
				}),
			]))
			await client.request("session/close", { sessionId })
			await client.close()
		} finally {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
		}
	}, 30_000)

	it("sends saved model context on the first follow-up after a process restart", async () => {
		const requests: Array<{ messages: unknown[] }> = []
		const server = createServer(async (request, response) => {
			if (request.method === "GET") {
				response.setHeader("Content-Type", "application/json")
				response.end(JSON.stringify({ data: [{ id: "test-model", object: "model" }] }))
				return
			}
			let body = ""
			for await (const chunk of request) body += chunk
			requests.push(JSON.parse(body))
			response.setHeader("Content-Type", "text/event-stream")
			response.end(
				`data: ${JSON.stringify({
					id: `completion-${requests.length}`,
					object: "chat.completion.chunk",
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: `respond-${requests.length}`,
										type: "function",
										function: {
											name: "respond",
											arguments: JSON.stringify({ operation: "complete", text: "Follow-up complete." }),
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
				})}\n\ndata: [DONE]\n\n`,
			)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address() as { port: number }
		try {
			const configDir = await temporaryDirectory("dirac-acp-config-")
			const cwd = await temporaryDirectory("dirac-acp-workspace-")
			const sessionId = crypto.randomUUID()
			await seedPersistedSession(configDir, cwd, sessionId, "test-model", "openai")
			const client = createRawClient(configDir, cwd)
			await client.initialize()
			await client.request("providers/set", {
				providerId: "openai",
				apiType: "openai",
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				headers: { Authorization: "Bearer local-test" },
			})
			expect(await client.request("session/load", { sessionId, cwd, mcpServers: [] })).toHaveProperty("result")
			const followUp = await client.request("session/prompt", {
				sessionId,
				prompt: [{ type: "text", text: "Continue the saved work." }],
			})
			expect(followUp).toMatchObject({ result: { stopReason: "end_turn" } })
			expect(requests.length).toBeGreaterThan(0)
			const modelContext = JSON.stringify(requests[0].messages)
			expect(modelContext).toContain("Remember the established context: continuity-marker-257")
			expect(modelContext).toContain("Previous assistant response")
			expect(modelContext).toContain("Continue the saved work.")
			await client.request("session/close", { sessionId })
			await client.close()
		} finally {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
		}
	}, 30_000)

	it("forks retained tasklets into an independent root without replaying their executions", async () => {
		const requests: unknown[] = []
		const server = createServer(async (request, response) => {
			if (request.method === "GET") {
				response.setHeader("Content-Type", "application/json")
				response.end(JSON.stringify({ data: [{ id: "test-model", object: "model" }] }))
				return
			}
			let body = ""
			for await (const chunk of request) body += chunk
			requests.push(JSON.parse(body))
			response.setHeader("Content-Type", "text/event-stream")
			response.end(`data: ${JSON.stringify({
				id: `fork-completion-${requests.length}`,
				object: "chat.completion.chunk",
				choices: [{
					index: 0, delta: {
						tool_calls: [{
							index: 0, id: `fork-respond-${requests.length}`, type: "function",
							function: { name: "respond", arguments: JSON.stringify({ operation: "complete", text: "Fork follow-up complete." }) },
						}]
					}, finish_reason: "tool_calls"
				}],
			})}\n\ndata: [DONE]\n\n`)
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		const address = server.address() as { port: number }
		try {
			const configDir = await temporaryDirectory("dirac-acp-config-")
			const cwd = await temporaryDirectory("dirac-acp-workspace-")
			const sourceSessionId = crypto.randomUUID()
			await seedPersistedSession(configDir, cwd, sourceSessionId, "test-model", "openai")
			const dataDir = path.join(configDir, "data")
			const historyFile = path.join(dataDir, "state", "taskHistory.json")
			const [sourceHistory] = JSON.parse(await readFile(historyFile, "utf8"))
			const sourceTaskDir = path.join(dataDir, "tasks", sourceHistory.id)
			const timestamp = Date.now()
			const records = ["completed", "interrupted"].map((kind) => ({
				id: `tasklet_${crypto.randomUUID()}`,
				rootTaskId: sourceHistory.id,
				conversationUlid: crypto.randomUUID(),
				title: `Retained ${kind} child`,
				prompt: `Private ${kind} assignment`,
				createdAt: timestamp,
				outcome: kind === "completed"
					? { kind, response: "Private completed result", completedAt: timestamp }
					: { kind, reason: "Stopped before fork", interruptedAt: timestamp },
			}))
			for (const record of records) {
				const directory = path.join(sourceTaskDir, "tasklets", record.id)
				await mkdir(directory, { recursive: true })
				await writeFile(path.join(directory, "tasklet.json"), JSON.stringify(record))
				await writeFile(path.join(directory, "tasklet_events.json"), JSON.stringify([{
					id: crypto.randomUUID(), taskletId: record.id, createdAt: timestamp,
					communication: { type: "outcome", outcome: record.outcome },
				}]))
				await writeFile(path.join(directory, "api_conversation_history.json"), JSON.stringify([
					{ role: "user", content: [{ type: "text", text: record.prompt }] },
				]))
				await writeFile(path.join(directory, "ui_messages.json"), "[]")
			}
			await writeFile(path.join(dataDir, "globalState.json"), JSON.stringify({
				welcomeViewCompleted: true, subagentsEnabled: true, enableCheckpointsSetting: false,
				telemetrySetting: "disabled", openTelemetryEnabled: false,
				utilityModelUseCases: { condense: false, approval: false, earlyExit: false },
			}))
			const client = createRawClient(configDir, cwd)
			await client.initialize()
			expect(await client.request("providers/set", {
				providerId: "openai", apiType: "openai", baseUrl: `http://127.0.0.1:${address.port}/v1`,
				headers: { Authorization: "Bearer local-test" },
			})).toHaveProperty("result")
			expect(await client.request("session/load", { sessionId: sourceSessionId, cwd, mcpServers: [] })).toHaveProperty("result")
			expect(await client.request("session/prompt", {
				sessionId: sourceSessionId, prompt: [{ type: "text", text: "Check the original session." }],
			})).toMatchObject({ result: { stopReason: "end_turn" } })
			await client.request("session/close", { sessionId: sourceSessionId })
			const artifactNames = ["tasklet.json", "tasklet_events.json", "api_conversation_history.json", "ui_messages.json"]
			const sourceFiles = records.flatMap((record) => artifactNames.map((name) => path.join(sourceTaskDir, "tasklets", record.id, name)))
			const sourceBytes = await Promise.all(sourceFiles.map((file) => readFile(file)))
			const fork = await client.request("session/fork", { sessionId: sourceSessionId, cwd, mcpServers: [] })
			expect(fork.error).toBeUndefined()
			const forkSessionId = fork.result?.sessionId as string
			const history = JSON.parse(await readFile(historyFile, "utf8")) as Array<{ id: string; ulid: string }>
			const forkHistory = history.find((item) => item.ulid === forkSessionId)!
			expect(forkHistory.id).not.toBe(sourceHistory.id)
			const followUp = await client.request("session/prompt", {
				sessionId: forkSessionId, prompt: [{ type: "text", text: "Continue the independent fork." }],
			})
			expect(followUp).toMatchObject({ result: { stopReason: "end_turn" } })
			expect(requests).toHaveLength(2)
			for (const record of records) {
				const directory = path.join(dataDir, "tasks", forkHistory.id, "tasklets", record.id)
				expect(JSON.parse(await readFile(path.join(directory, "tasklet.json"), "utf8"))).toEqual({
					...record,
					rootTaskId: forkHistory.id,
				})
				for (const name of artifactNames.slice(1)) {
					expect(await readFile(path.join(directory, name))).toEqual(await readFile(path.join(sourceTaskDir, "tasklets", record.id, name)))
				}
			}
			await client.request("session/close", { sessionId: forkSessionId })
			expect(await client.request("session/delete", { sessionId: forkSessionId })).toHaveProperty("result")
			expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual([expect.objectContaining({ id: sourceHistory.id })])
			expect(await Promise.all(sourceFiles.map((file) => readFile(file)))).toEqual(sourceBytes)
		} finally {
			server.closeAllConnections()
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
		}
	}, 30_000)

	it("loads and replays a persisted session in a new ACP process", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const sessionId = crypto.randomUUID()
		await seedPersistedSession(configDir, cwd, sessionId)

		const first = createRawClient(configDir, cwd)
		await first.initialize()
		await expect(first.request("session/load", { sessionId, cwd, mcpServers: [] })).resolves.toMatchObject({
			result: expect.any(Object),
		})
		await expect(waitForUpdate(first, "user_message_chunk")).resolves.toMatchObject({
			params: {
				sessionId,
				update: { content: { type: "text", text: "Persisted user message" } },
			},
		})
		await first.close()

		const second = createRawClient(configDir, cwd)
		await second.initialize()
		await expect(second.request("session/load", { sessionId, cwd, mcpServers: [] })).resolves.toMatchObject({
			result: expect.any(Object),
		})
		await expect(waitForUpdate(second, "user_message_chunk")).resolves.toMatchObject({
			params: {
				sessionId,
				update: { content: { type: "text", text: "Persisted user message" } },
			},
		})
	})

	it("repairs a retired persisted DeepSeek model before returning load state", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const sessionId = crypto.randomUUID()
		await seedPersistedSession(configDir, cwd, sessionId, "deepseek-v4-flash")

		const client = createRawClient(configDir, cwd)
		await client.initialize()
		const loaded = await client.request("session/load", { sessionId, cwd, mcpServers: [] })
		const configOptions = loaded.result?.configOptions as Array<Record<string, unknown>>
		assertProviderModelConfig(configOptions)
		const model = configOptions.find((option) => option.id === "model")!
		expect(model.currentValue).toBe("deepseek-flash")
		expect((model.options as Array<Record<string, unknown>>).map((option) => option.value)).not.toContain("deepseek-v4-flash")
	})

	it("preserves persisted DeepSeek Pro when loading a session", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const sessionId = crypto.randomUUID()
		await seedPersistedSession(configDir, cwd, sessionId, "deepseek-v4-pro")

		const client = createRawClient(configDir, cwd)
		await client.initialize()
		const loaded = await client.request("session/load", { sessionId, cwd, mcpServers: [] })
		const configOptions = loaded.result?.configOptions as Array<Record<string, unknown>>
		assertProviderModelConfig(configOptions)
		const model = configOptions.find((option) => option.id === "model")!
		expect(model.currentValue).toBe("deepseek-v4-pro")
		expect((model.options as Array<Record<string, unknown>>).map((option) => option.value)).toContain("deepseek-v4-pro")
	})


	it("restores a changed never-prompted task without recomputing startup defaults", async () => {
		const configDir = await temporaryDirectory("dirac-acp-config-")
		const cwd = await temporaryDirectory("dirac-acp-workspace-")
		const first = createRawClient(configDir, cwd, ["--provider", "deepseek", "--model", "deepseek-flash"])
		await first.initialize()
		const created = await first.request("session/new", { cwd, mcpServers: [] })
		const sessionId = created.result?.sessionId as string

		await first.request("session/set_config_option", {
			sessionId,
			configId: "reasoning_effort",
			value: "high",
		})
		await first.request("session/set_config_option", {
			sessionId,
			configId: "auto_approve",
			type: "boolean",
			value: true,
		})
		await first.request("session/set_config_option", {
			sessionId,
			configId: "yolo",
			type: "boolean",
			value: true,
		})
		await first.request("session/close", { sessionId })
		await first.close()

		const second = createRawClient(configDir, cwd, ["--provider", "anthropic", "--model", "claude-sonnet-4-6"])
		await second.initialize()
		const loaded = await second.request("session/load", { sessionId, cwd, mcpServers: [] })

		expect(loaded.result?.configOptions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "mode", currentValue: "act" }),
				expect.objectContaining({ id: "auto_approve", currentValue: true }),
				expect.objectContaining({ id: "yolo", currentValue: true }),
				expect.objectContaining({ id: "provider", currentValue: "deepseek" }),
				expect.objectContaining({ id: "model", currentValue: "deepseek-flash" }),
				expect.objectContaining({ id: "reasoning_effort", currentValue: "high" }),
			]),
		)
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

async function seedPersistedSession(
	configDir: string,
	cwd: string,
	sessionId: string,
	modelId = "deepseek-flash",
	provider = "deepseek",
): Promise<void> {
	const timestamp = Date.now()
	const taskId = `persisted-task-${timestamp}`
	const taskDirectory = path.join(configDir, "data", "tasks", taskId)
	await mkdir(path.join(configDir, "data", "state"), { recursive: true })
	await mkdir(taskDirectory, { recursive: true })
	await writeFile(
		path.join(configDir, "data", "state", "taskHistory.json"),
		JSON.stringify([
			{
				id: taskId,
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
	await writeFile(
		path.join(taskDirectory, "api_conversation_history.json"),
		JSON.stringify([
			{ role: "user", content: [{ type: "text", text: "Remember the established context: continuity-marker-257" }] },
			{ role: "assistant", content: [{ type: "text", text: "Previous assistant response" }] },
		]),
	)
	await writeFile(
		path.join(configDir, "data", "acp-session-runtime-config.json"),
		JSON.stringify({
			[sessionId]: {
				version: 1,
				cwd,
				createdAt: timestamp,
				settings: {
					mode: "act",
					autoApproveAllToggled: false,
					yoloModeToggled: false,
					planActSeparateModelsSetting: false,
					planModeApiProvider: provider,
					actModeApiProvider: provider,
					planModeOpenAiModelId: modelId,
					actModeOpenAiModelId: modelId,
					planModeOpenAiModelInfo: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true },
					actModeOpenAiModelInfo: { contextWindow: 200_000, maxTokens: 8192, supportsTools: true },
					planModeApiModelId: modelId,
					actModeApiModelId: modelId,
					planModeThinkingBudgetTokens: 0,
					actModeThinkingBudgetTokens: 0,
					planModeReasoningEffort: "medium",
					actModeReasoningEffort: "medium",
				},
			},
		}),
	)
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

function assertProviderModelConfig(configOptions: Array<Record<string, unknown>>): void {
	const providerIndex = configOptions.findIndex((option) => option.id === "provider")
	const modelIndex = configOptions.findIndex((option) => option.id === "model")
	expect(providerIndex).toBeGreaterThanOrEqual(0)
	expect(modelIndex).toBeGreaterThan(providerIndex)

	const provider = configOptions[providerIndex]
	const model = configOptions[modelIndex]
	const providerValues = (provider.options as Array<Record<string, unknown>>).map((option) => option.value)
	const modelValues = (model.options as Array<Record<string, unknown>>).map((option) => option.value)
	expect(providerValues).toContain(provider.currentValue)
	expect(modelValues.length).toBeGreaterThan(0)
	expect(modelValues).toContain(model.currentValue)
}

async function waitForUpdate(client: RawAcpClient, kind: string, timeoutMs = 10_000): Promise<JsonRpcFrame> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const update = client.updates.find(
			(frame) => frame.params?.update && (frame.params.update as Record<string, unknown>).sessionUpdate === kind,
		)
		if (update) return update
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error(`Timed out waiting for ${kind}. stderr: ${client.stderr.join("")}`)
}
