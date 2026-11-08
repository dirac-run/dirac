import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import { buildApiHandler, buildApiHandlerForSelection, type ApiHandler } from "@core/api"
import { buildEffectiveApiConfigurationFromCache, type StateManagerSettingsCaches } from "@core/storage/StateManagerSettings"
import { GLOBAL_STATE_DEFAULTS, SETTINGS_DEFAULTS } from "@shared/storage/state-keys"
import { mockFetchForTesting } from "@/shared/net"
import { OpenAiHandler } from "../openai"
import { OpenAiResponsesCompatibleHandler } from "../openai-responses-compatible"

const environmentKeys = [
	"OPENAI_API_KEY", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_COMPATIBLE_CUSTOM_KEY",
	"AZURE_OPENAI_API_KEY", "DIRAC_PROVIDER", "DIRAC_API_KEY", "DIRAC_BASE_URL", "DIRAC_MODEL", "OPENAI_API_BASE",
	"OPENAI_BASE_URL",
] as const

async function consume(handler: ApiHandler): Promise<void> {
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
		// Consume the real SDK stream, including authentication and URL construction.
	}
}

for (const protocol of ["chat", "responses"] as const) {
	describe(`OpenAI-compatible ${protocol} credential policy`, () => {
		let previous: (string | undefined)[]
		beforeEach(() => {
			previous = environmentKeys.map((key) => process.env[key])
			for (const key of environmentKeys) delete process.env[key]
			process.env.OPENAI_API_KEY = "ambient-openai-secret"
			process.env.OPENAI_ORG_ID = "ambient-organization"
			process.env.OPENAI_PROJECT_ID = "ambient-project"
		})
		afterEach(() => {
			environmentKeys.forEach((key, index) => {
				if (previous[index] === undefined) delete process.env[key]
				else process.env[key] = previous[index]
			})
		})
		const endpoint = protocol === "responses" ? "http://localhost:1234/v1/responses" : "http://localhost:1234/v1"
		const requestUrl = protocol === "responses" ? endpoint : `${endpoint}/chat/completions`
		const Handler = protocol === "responses" ? OpenAiResponsesCompatibleHandler : OpenAiHandler
		function response(): Response {
			const event = protocol === "responses"
				? { type: "response.output_text.delta", delta: "reply" }
				: { choices: [{ delta: { content: "reply" }, finish_reason: null }] }
			return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
				headers: { "Content-Type": "text/event-stream" },
			})
		}
		async function capture(handler: ApiHandler): Promise<Request> {
			const requests: Request[] = []
			await mockFetchForTesting(async (input, init) => {
				requests.push(new Request(input, init))
				return response()
			}, () => consume(handler))
			assert.equal(requests.length, 1)
			assert.equal(requests[0].url, requestUrl)
			assert.equal((await requests[0].clone().json()).model, "local/model")
			return requests[0]
		}
		function effectiveConfiguration(named: boolean) {
			const caches = {
				globalStateCache: {
					...GLOBAL_STATE_DEFAULTS, ...SETTINGS_DEFAULTS,
					actModeApiProvider: "openai", actModeOpenAiModelId: "local/model",
					openAiBaseUrl: endpoint,
					actModeOpenAiProfileName: named ? "Local" : undefined,
					openAiCompatibleProfiles: named ? [{
						name: "Local", baseUrl: endpoint, apiKey: "", modelId: "",
						modelInfo: { supportsPromptCache: false }, headers: { "X-Endpoint": "explicit" },
					}] : [],
				},
				secretsCache: { openAiApiKey: "" }, taskStateCache: {}, sessionOverrideCache: {},
			} as unknown as StateManagerSettingsCaches
			return buildEffectiveApiConfigurationFromCache(caches)
		}

		it("blocks SDK ambient credentials for a directly supplied keyless endpoint", async () => {
			const request = await capture(new Handler({
				openAiBaseUrl: ` ${endpoint} `, openAiModelId: "local/model", disableRetries: true,
				openAiHeaders: { "X-Endpoint": "explicit" },
			}))
			for (const header of ["authorization", "openai-organization", "openai-project"]) {
				assert.equal(request.headers.get(header), null)
			}
			assert.equal(request.headers.get("x-endpoint"), "explicit")
		})

		it("preserves explicitly supplied authentication headers", async () => {
			const request = await capture(new Handler({
				openAiBaseUrl: endpoint, openAiModelId: "local/model", disableRetries: true,
				openAiHeaders: { Authorization: "Bearer endpoint-header" },
			}))
			assert.equal(request.headers.get("authorization"), "Bearer endpoint-header")
		})

		if (protocol === "responses") {
			it("retains the SDK public endpoint when an explicit key has no base URL", async () => {
				await mockFetchForTesting(async (input, init) => {
					const request = new Request(input, init)
					assert.equal(request.url, "https://api.openai.com/v1/responses")
					assert.equal(request.headers.get("authorization"), "Bearer explicit-public-key")
					return response()
				}, () => consume(new OpenAiResponsesCompatibleHandler({
					openAiApiKey: "explicit-public-key", openAiModelId: "local/model", disableRetries: true,
				})))
			})
		}

		it("requires an explicit key for implicit OpenAI, public OpenAI and Azure", async () => {
			for (const openAiBaseUrl of [undefined, " ", "https://api.openai.com/v1", "https://example.openai.azure.com/v1"]) {
				await assert.rejects(consume(new Handler({ openAiBaseUrl, openAiModelId: "local/model", disableRetries: true })), /API key/)
			}
		})

		it("isolates named main and independent selections from ordinary environment fallback", async () => {
			const configuration = effectiveConfiguration(true)
			assert.equal(configuration.openAiApiKey, "ambient-openai-secret")
			const independent = { provider: "openai" as const, modelId: "local/model", openAiProfileName: "Local" }
			for (const handler of [buildApiHandler(configuration, "act"), buildApiHandlerForSelection(configuration, independent)]) {
				const request = await capture(handler)
				assert.equal(request.headers.get("authorization"), null)
				assert.equal(request.headers.get("openai-organization"), null)
				assert.equal(request.headers.get("openai-project"), null)
				assert.equal(request.headers.get("x-endpoint"), "explicit")
			}
		})

		it("preserves the ordinary environment fallback for unnamed endpoints", async () => {
			const request = await capture(buildApiHandler(effectiveConfiguration(false), "act"))
			assert.equal(request.headers.get("authorization"), "Bearer ambient-openai-secret")
		})

		it("preserves the explicit compatible-key override even for named endpoints", async () => {
			process.env.OPENAI_COMPATIBLE_CUSTOM_KEY = "explicit-compatible-override"
			const request = await capture(buildApiHandler(effectiveConfiguration(true), "act"))
			assert.equal(request.headers.get("authorization"), "Bearer explicit-compatible-override")
		})
	})
}
