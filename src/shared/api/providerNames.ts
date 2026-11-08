export type ApiProvider =
	| "anthropic"
	| "claude-code"
	| "openrouter"
	| "bedrock"
	| "vertex"
	| "openai"
	| "lmstudio"
	| "gemini"
	| "openai-native"
	| "openai-codex"
	| "requesty"
	| "together"
	| "deepseek"
	| "unbiased"
	| "qwen"
	| "qwen-code"
	| "doubao"
	| "mistral"
	| "github-copilot"
	| "vscode-lm"
	| "litellm"
	| "moonshot"
	| "nebius"
	| "fireworks"
	| "xai"
	| "sambanova"
	| "cerebras"
	| "groq"
	| "huggingface"
	| "huawei-cloud-maas"
	| "dify"
	| "baseten"
	| "vercel-ai-gateway"
	| "zai"
	| "oca"
	| "aihubmix"
	| "minimax"
	| "nousResearch"
	| "wandb"

export const ALL_PROVIDERS: ApiProvider[] = [
	"anthropic",
	"claude-code",
	"openrouter",
	"bedrock",
	"vertex",
	"openai",
	"lmstudio",
	"gemini",
	"openai-native",
	"openai-codex",
	"requesty",
	"together",
	"deepseek",
	"unbiased",
	"qwen",
	"qwen-code",
	"doubao",
	"mistral",
	"github-copilot",
	"vscode-lm",
	"litellm",
	"moonshot",
	"nebius",
	"fireworks",
	"xai",
	"sambanova",
	"cerebras",
	"groq",
	"huggingface",
	"huawei-cloud-maas",
	"dify",
	"baseten",
	"vercel-ai-gateway",
	"zai",
	"oca",
	"aihubmix",
	"minimax",
	"nousResearch",
	"wandb",
]

export const DEFAULT_API_PROVIDER = "openrouter" as ApiProvider
