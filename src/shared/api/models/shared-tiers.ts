export const CLAUDE_SONNET_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 3.0,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER, // storing infinity in vs storage is not possible, it converts to 'null', which causes crash in webview ModelInfoView
		inputPrice: 6,
		outputPrice: 22.5,
		cacheWritesPrice: 7.5,
		cacheReadsPrice: 0.6,
	},
]

export const CLAUDE_OPUS_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 5.0,
		outputPrice: 25,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 10,
		outputPrice: 37.5,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1.0,
	},
]

export const GPT_5_5_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 5.0,
		outputPrice: 30.0,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 10.0,
		outputPrice: 45.0,
		cacheReadsPrice: 1.0,
	},
]

export const GPT_5_4_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 2.5,
		outputPrice: 15.0,
		cacheReadsPrice: 0.25,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 5.0,
		outputPrice: 22.5,
		cacheReadsPrice: 0.5,
	},
]

export const GPT_5_4_PRO_TIERS = [
	{
		contextWindow: 272_000,
		inputPrice: 30.0,
		outputPrice: 180.0,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 60.0,
		outputPrice: 270.0,
	},
]
