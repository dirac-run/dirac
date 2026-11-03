import { once } from "node:events"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import path from "node:path"
import { createTaskletFixture } from "./tasklet-fixture.mjs"

export const LONG_RESPONSE = Array.from(
	{ length: 80 },
	(_, index) => `Response line ${String(index + 1).padStart(2, "0")}: deterministic CLI scrolling fixture.`,
).join("\n")

export const LONG_PLAN = Array.from(
	{ length: 80 },
	(_, index) => `Plan line ${String(index + 1).padStart(2, "0")}: deterministic CLI scrolling fixture.`,
).join("\n")

export const MARKDOWN_PLAN = [
	"Markdown plan start.",
	...Array.from({ length: 3 }, (_, block) => [
		"```text",
		...Array.from({ length: 24 }, (_, line) => `Code ${block + 1}.${String(line + 1).padStart(2, "0")}: **literal**`),
		"```",
		`**Prose between blocks ${block + 1} and ${block + 2}.**`,
		"",
	]).flat(),
	"Markdown plan end.",
].join("\n")

export const MARKDOWN_RESPONSE = [
	"## Auto-approved commands",
	"",
	"**Read-only commands** can run without approval.",
	"",
	"- Inspect files with `ls` and `pwd`.",
	"- Check changes with `git status`.",
	"",
	"1. Review the command.",
	"2. Ask before making changes.",
	"",
	"[Approval documentation][approvals]",
	"",
	"```sh",
	...Array.from({ length: 24 }, (_, line) => `echo "Code ${String(line + 1).padStart(2, "0")}: **literal**"`),
	"```",
	"",
	"**Approval summary:** changes still need permission.",
	"",
	"[approvals]: https://example.com/approvals",
].join("\n")

export const CREATE_FILE_PATH =
	"src/features/permission-dialog/regressions/long-directory-name-for-file-creation/a-very-long-file-name-that-must-remain-readable-in-the-permission-prompt.txt"
export const CREATE_FILE_CONTENT = "Permission prompt regression fixture.\n"

export const EDIT_FILE_PATH = "permission-scroll.txt"
export const EDIT_FILE_CONTENT = `${Array.from({ length: 40 }, (_, index) => `Context line ${String(index + 1).padStart(2, "0")}.`).join("\n")}\n`
export const EDIT_FILE_INSERTIONS = [18, 28].map((length, block) =>
	Array.from(
		{ length },
		(_, index) => `Added ${block + 1}.${String(index + 1).padStart(2, "0")}: permission scrolling fixture.`,
	).join("\n"),
)

function editFileArguments(completion) {
	const messages = JSON.stringify(completion.messages)
	const anchors = ["05", "35"].map((line) => {
		const match = messages.match(new RegExp(`[A-Z][a-zA-Z]*§Context line ${line}\\.`))
		if (!match) throw new Error(`Fixture requires the read_file anchor for line ${line}`)
		return match[0]
	})
	return {
		files: [
			{
				path: EDIT_FILE_PATH,
				edits: anchors.map((anchor, index) => ({
					edit_type: "insert_after",
					anchor,
					text: `${EDIT_FILE_INSERTIONS[index]}\n`,
				})),
			},
		],
	}
}

/** Deterministic tool calls; all UI, provider parsing, task execution and storage remain real. */
export async function startFixtureProvider(home, scenario = "long-response", workspace, vimMode = false) {
	if (
		!["long-response", "long-plan", "markdown-plan", "markdown-response", "create-file", "edit-file", "tasklets"].includes(
			scenario,
		)
	) {
		throw new Error(`Unknown fixture: ${scenario}`)
	}
	if (scenario === "edit-file") await writeFile(path.join(workspace, EDIT_FILE_PATH), EDIT_FILE_CONTENT)
	const taskletFixture = scenario === "tasklets" ? createTaskletFixture(workspace) : undefined
	let requests = 0
	const server = createServer(async (request, response) => {
		try {
			if (request.method === "GET" && request.url === "/v1/models") {
				response.setHeader("content-type", "application/json")
				response.end(JSON.stringify({ object: "list", data: [{ id: "tui-fixture", object: "model" }] }))
				return
			}
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end("Unsupported fixture endpoint")
				return
			}
			let body = ""
			for await (const chunk of request) body += chunk
			const completion = JSON.parse(body)
			const taskletCall = await taskletFixture?.(completion)
			const createFile = scenario === "create-file" && requests === 0
			const readFile = scenario === "edit-file" && requests === 0
			const editFile = scenario === "edit-file" && requests === 1
			const toolName =
				taskletCall?.name ?? (createFile ? "write_to_file" : readFile ? "read_file" : editFile ? "edit_file" : "respond")
			const tool = completion.tools?.find((candidate) => candidate.function?.name === toolName)
			if (!tool) throw new Error(`Fixture requires the native ${toolName} tool`)
			const args = taskletCall
				? taskletCall.args
				: createFile
					? { path: CREATE_FILE_PATH, content: CREATE_FILE_CONTENT }
					: readFile
						? { paths: [EDIT_FILE_PATH], include_anchors: true }
						: editFile
							? editFileArguments(completion)
							: {
									operation: scenario === "long-plan" || scenario === "markdown-plan" ? "plan" : "complete",
									text:
										scenario === "markdown-response"
											? MARKDOWN_RESPONSE
											: scenario === "markdown-plan"
												? MARKDOWN_PLAN
												: scenario === "long-plan"
													? LONG_PLAN
													: scenario === "edit-file"
														? "File edit fixture completed."
														: scenario === "create-file"
															? "File creation fixture completed."
															: LONG_RESPONSE,
								}
			requests++
			const chunk = (delta, finishReason = null) => ({
				id: `tui-completion-${requests}`,
				object: "chat.completion.chunk",
				created: 0,
				model: "tui-fixture",
				choices: [{ index: 0, delta, finish_reason: finishReason }],
			})
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
			response.write(
				`data: ${JSON.stringify(
					chunk({
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: `tui-tool-${requests}`,
								type: "function",
								function: {
									name: toolName,
									arguments: JSON.stringify(args),
								},
							},
						],
					}),
				)}\n\n`,
			)
			response.write(`data: ${JSON.stringify(chunk({}, "tool_calls"))}\n\n`)
			response.write(
				`data: ${JSON.stringify({ ...chunk({}), choices: [], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })}\n\n`,
			)
			response.end("data: [DONE]\n\n")
		} catch (error) {
			response
				.writeHead(500, { "content-type": "application/json" })
				.end(JSON.stringify({ error: { message: error.message } }))
		}
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
	const dataDir = path.join(home, "data")
	await mkdir(dataDir, { recursive: true })
	await writeFile(
		path.join(dataDir, "globalState.json"),
		JSON.stringify({
			welcomeViewCompleted: true,
			isNewUser: false,
			mode: "act",
			actModeApiProvider: "openai",
			planModeApiProvider: "openai",
			actModeOpenAiModelId: "tui-fixture",
			planModeOpenAiModelId: "tui-fixture",
			openAiBaseUrl: baseUrl,
			telemetrySetting: "disabled",
			openTelemetryEnabled: false,
			utilityModelUseCases: { condense: false, approval: false, earlyExit: false },
			cliTerminalColorMode: "dark",
			cliVimMode: vimMode,
			...(scenario === "tasklets" ? { subagentsEnabled: true, enableCheckpointsSetting: false } : {}),
		}),
	)
	await writeFile(path.join(dataDir, "secrets.json"), JSON.stringify({ openAiApiKey: "local-tui-fixture" }), { mode: 0o600 })
	return {
		baseUrl,
		get requests() {
			return requests
		},
		async stop() {
			server.closeAllConnections()
			await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
		},
	}
}
