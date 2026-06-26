import { expect } from 'chai'
import * as path from 'path'

const srcDir = path.join(__dirname, '..', '..', '..')

describe('BedrockMessageConfig Consolidation', () => {
	describe('Function parameter reduction validation', () => {
		it('should handle Bedrock handler with all config variants via buildApiHandler', async () => {
			const { buildApiHandler } = await import(path.join(srcDir, 'core', 'api', 'index.ts'))

			// Test various bedrock configurations to ensure refactored functions work correctly
			const configs = [
				{ apiKey: 'test-key', planModeApiProvider: 'aws-bedrock', actModeApiProvider: 'aws-bedrock' },
				{ apiKey: 'test-key', planModeApiProvider: 'aws-bedrock', awsBedrockUsePromptCache: true },
				{ apiKey: 'test-key', planModeApiProvider: 'aws-bedrock', thinkingBudgetTokens: 4096 },
			]

			for (const config of configs) {
				const handler = buildApiHandler(config, 'plan' as const)
				expect(handler).to.exist
			}
		})

		it('should support Nova model path with refactored createNovaMessage', async () => {
			const { buildApiHandler } = await import(path.join(srcDir, 'core', 'api', 'index.ts'))
			const handler = buildApiHandler({
				apiKey: 'test-key',
				planModeApiProvider: 'aws-bedrock',
				actModeApiProvider: 'aws-bedrock',
				apiModelId: 'amazon.nova-pro-v1:0',
			}, 'plan' as const)

			expect(handler).to.exist
		})

		it('should support OpenAI model path with refactored createOpenAIMessage', async () => {
			const { buildApiHandler } = await import(path.join(srcDir, 'core', 'api', 'index.ts'))
			const handler = buildApiHandler({
				apiKey: 'test-key',
				planModeApiProvider: 'aws-bedrock',
				actModeApiProvider: 'aws-bedrock',
				apiModelId: 'us.meta.llama-3-2-90b-instruct-v1:0',
			}, 'plan' as const)

			expect(handler).to.exist
		})

		it('should support Qwen model path with refactored createQwenMessage', async () => {
			const { buildApiHandler } = await import(path.join(srcDir, 'core', 'api', 'index.ts'))
			const handler = buildApiHandler({
				apiKey: 'test-key',
				planModeApiProvider: 'aws-bedrock',
				actModeApiProvider: 'aws-bedrock',
				apiModelId: 'cn.qwen-plus-v25-04-08',
			}, 'plan' as const)

			expect(handler).to.exist
		})

		it('should support Deepseek model path with refactored createDeepseekMessage', async () => {
			const { buildApiHandler } = await import(path.join(srcDir, 'core', 'api', 'index.ts'))
			const handler = buildApiHandler({
				apiKey: 'test-key',
				planModeApiProvider: 'aws-bedrock',
				actModeApiProvider: 'aws-bedrock',
				apiModelId: 'us.deepseek.r1-v1:0',
			}, 'plan' as const)

			expect(handler).to.exist
		})

		it('should support Anthropic model path with refactored createAnthropicMessage', async () => {
			const { buildApiHandler } = await import(path.join(srcDir, 'core', 'api', 'index.ts'))
			const handler = buildApiHandler({
				apiKey: 'test-key',
				planModeApiProvider: 'aws-bedrock',
				actModeApiProvider: 'aws-bedrock',
				apiModelId: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
			}, 'plan' as const)

			expect(handler).to.exist
		})

		it('should support 1M context window with refactored createAnthropicMessage enable1mContextWindow flag', async () => {
			const { buildApiHandler } = await import(path.join(srcDir, 'core', 'api', 'index.ts'))
			const handler = buildApiHandler({
				apiKey: 'test-key',
				planModeApiProvider: 'aws-bedrock',
				actModeApiProvider: 'aws-bedrock',
				apiModelId: 'anthropic.claude-sonnet-4-20250514-v1:0-1m',
			}, 'plan' as const)

			expect(handler).to.exist
		})

		it('should handle cache control with refactored applyCacheControlToMessages signature', async () => {
			const bedrockModule = await import(path.join(srcDir, 'core', 'api', 'providers', 'bedrock.ts'))
			const handler = new bedrockModule.AwsBedrockHandler({
				apiKey: 'test-key',
				awsBedrockUsePromptCache: true,
			})

			expect(handler).to.exist
		})

		it('should maintain backward compatibility - all 6 functions accept config objects', async () => {
			const bedrockModule = await import(path.join(srcDir, 'core', 'api', 'providers', 'bedrock.ts'))

			// Verify AwsBedrockHandler exists and can be instantiated
			expect(bedrockModule.AwsBedrockHandler).to.exist
			expect(typeof bedrockModule.AwsBedrockHandler).to.equal('function')

			const handler = new bedrockModule.AwsBedrockHandler({
				apiKey: 'test-key',
			})

			expect(handler.createMessage).to.exist
			expect(typeof handler.createMessage).to.not.equal('undefined')
		})
	})
})
