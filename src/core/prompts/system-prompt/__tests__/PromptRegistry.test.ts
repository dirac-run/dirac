import { expect } from "chai"
import { PromptRegistry } from "../registry/PromptRegistry"
import type { SystemPromptContext } from "../types"
import type { ToolRequestSnapshot } from "@core/task/tools/runtime/ToolSnapshot"
import { mockProviderInfo } from "./integration.test"

function emptyToolSnapshot(): ToolRequestSnapshot {
	return {
		inventoryVersion: 0,
		requestId: "test",
		promptVisibleSpecs: [],
		inventoryEnabledTools: [],
		nativeTools: [],
		coordinator: { has: () => false } as any,
		executableToolNames: new Set(),
		dynamicSubagentToolNames: new Set(),
	}
}

describe("PromptRegistry", () => {
	let registry: PromptRegistry
	const mockContext: SystemPromptContext = {
		cwd: "/test/project",
		ide: "TestIde",
		supportsBrowserUse: true,
		browserSettings: {
			viewport: {
				width: 1280,
				height: 720,
			},
		},
		isTesting: true,
		providerInfo: mockProviderInfo,
	}

	beforeEach(() => {
		// Get a fresh instance for each test
		PromptRegistry.dispose()
		registry = PromptRegistry.getInstance()
	})

	describe("getInstance", () => {
		it("should return singleton instance", () => {
			const instance1 = PromptRegistry.getInstance()
			const instance2 = PromptRegistry.getInstance()

			expect(instance1).to.equal(instance2)
		})
	})

	describe("get method", () => {
		it("should return a prompt string", async () => {
			const prompt = await registry.get(mockContext, emptyToolSnapshot())

			// If we get a prompt, it should be a string
			expect(prompt).to.be.a("string")
			expect(prompt.length).to.be.greaterThan(10)
		})
	})

	describe("basic functionality", () => {
		it("should be able to create registry instance", () => {
			expect(registry).to.be.instanceOf(PromptRegistry)
		})

		it("should have required methods", () => {
			expect(registry.get).to.be.a("function")
		})
	})
})
