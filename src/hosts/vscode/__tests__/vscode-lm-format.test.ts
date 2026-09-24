import "should"
import type { Anthropic } from "@anthropic-ai/sdk"
import { expect } from "chai"
import * as vscode from "vscode"
import { asObjectSafe, convertToAnthropicMessage, convertToAnthropicRole, convertToVsCodeLmMessages } from "../vscode-lm-format"

// Characterization tests for vscode-lm-format conversions.
// VSCode LM API only supports TextPart, ToolResultPart, and ToolCallPart — images are
// represented as descriptive text placeholders.
describe("vscode-lm-format", () => {
	describe("asObjectSafe", () => {
		it("returns empty object for null/undefined", () => {
			asObjectSafe(null).should.deepEqual({})
			asObjectSafe(undefined).should.deepEqual({})
		})
		it("parses JSON strings", () => {
			asObjectSafe('{"a":1}').should.deepEqual({ a: 1 })
		})
		it("returns empty object for invalid JSON strings", () => {
			asObjectSafe("not json").should.deepEqual({})
		})
		it("clones existing objects", () => {
			const obj = { a: 1 }
			asObjectSafe(obj).should.deepEqual({ a: 1 })
		})
		it("returns empty object for primitives", () => {
			asObjectSafe(42).should.deepEqual({})
		})
	})

	describe("convertToVsCodeLmMessages", () => {
		it("converts string user content to User message", () => {
			const result = convertToVsCodeLmMessages([{ role: "user", content: "hello" } as any])
			result.should.have.length(1)
			result[0].role.should.equal(vscode.LanguageModelChatMessageRole.User)
		})

		it("converts string assistant content to Assistant message", () => {
			const result = convertToVsCodeLmMessages([{ role: "assistant", content: "hi" } as any])
			result.should.have.length(1)
			result[0].role.should.equal(vscode.LanguageModelChatMessageRole.Assistant)
		})

		it("converts user text blocks to TextPart", () => {
			const result = convertToVsCodeLmMessages([
				{ role: "user", content: [{ type: "text", text: "hello" }] } as Anthropic.Messages.MessageParam,
			])
			result.should.have.length(1)
			result[0].content.should.have.length(1)
			result[0].content[0].should.be.instanceOf(vscode.LanguageModelTextPart)
		})

		it("converts user image blocks to descriptive text placeholder", () => {
			const result = convertToVsCodeLmMessages([
				{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png" } }] } as any,
			])
			const part = result[0].content[0] as vscode.LanguageModelTextPart
			expect(part.value as string).to.include("[Image")
			expect(part.value as string).to.include("image/png")
		})

		it("converts user tool_result to ToolResultPart", () => {
			const result = convertToVsCodeLmMessages([
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] } as any,
			])
			const part = result[0].content[0] as vscode.LanguageModelToolResultPart
			part.should.be.instanceOf(vscode.LanguageModelToolResultPart)
			part.callId.should.equal("t1")
		})

		it("converts assistant tool_use to ToolCallPart", () => {
			const result = convertToVsCodeLmMessages([
				{ role: "assistant", content: [{ type: "tool_use", id: "t1", name: "fn", input: { x: 1 } }] } as any,
			])
			const part = result[0].content[0] as vscode.LanguageModelToolCallPart
			part.should.be.instanceOf(vscode.LanguageModelToolCallPart)
			part.callId.should.equal("t1")
			part.name.should.equal("fn")
		})

		it("converts assistant text blocks to TextPart", () => {
			const result = convertToVsCodeLmMessages([
				{ role: "assistant", content: [{ type: "text", text: "response" }] } as any,
			])
			const part = result[0].content[0] as vscode.LanguageModelTextPart
			part.value.should.equal("response")
		})

		it("places tool parts before non-tool parts in user messages", () => {
			const result = convertToVsCodeLmMessages([
				{
					role: "user",
					content: [
						{ type: "text", text: "after" },
						{ type: "tool_result", tool_use_id: "t1", content: "r" },
					],
				} as any,
			])
			result[0].content[0].should.be.instanceOf(vscode.LanguageModelToolResultPart)
			result[0].content[1].should.be.instanceOf(vscode.LanguageModelTextPart)
		})
	})

	describe("convertToAnthropicRole", () => {
		it("maps User to user", () => {
			const role = convertToAnthropicRole(vscode.LanguageModelChatMessageRole.User)
			expect(role).to.equal("user")
		})
		it("maps Assistant to assistant", () => {
			const role = convertToAnthropicRole(vscode.LanguageModelChatMessageRole.Assistant)
			expect(role).to.equal("assistant")
		})
		it("returns null for unknown roles", () => {
			should.equal(convertToAnthropicRole(999 as any), null)
		})
	})

	describe("convertToAnthropicMessage", () => {
		it("converts assistant TextParts to text content blocks", () => {
			const msg = vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelTextPart("hello")])
			const result = convertToAnthropicMessage(msg)
			result.role.should.equal("assistant")
			result.content.should.have.length(1)
			result.content[0].type.should.equal("text")
		})

		it("converts ToolCallParts to tool_use blocks", () => {
			const msg = vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelToolCallPart("t1", "fn", { x: 1 })])
			const result = convertToAnthropicMessage(msg)
			result.content[0].type.should.equal("tool_use")
		})

		it("throws for non-assistant messages", () => {
			const msg = vscode.LanguageModelChatMessage.User([new vscode.LanguageModelTextPart("hi")])
			expect(() => convertToAnthropicMessage(msg)).to.throw("Only assistant messages are supported")
		})

		it("filters out unsupported part types", () => {
			const msg = vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelTextPart("keep"),
				new vscode.LanguageModelToolResultPart("t1", [] as any),
			] as any)
			const result = convertToAnthropicMessage(msg)
			result.content.should.have.length(1)
			result.content[0].type.should.equal("text")
		})
	})
})
