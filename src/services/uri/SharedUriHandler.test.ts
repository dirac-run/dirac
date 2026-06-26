import { expect } from "chai"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as sinon from "sinon"
import { DiracWebviewProvider } from "@/core/webview"
import { Logger } from "@/shared/services/Logger"
import { ErrorService } from "../error"
import { SharedUriHandler } from "./SharedUriHandler"

describe("SharedUriHandler", () => {
	let sandbox: sinon.SinonSandbox
	let completeOpenRouterAuthStub: sinon.SinonStub
	let handleAuthCallbackStub: sinon.SinonStub

	beforeEach(async () => {
		sandbox = sinon.createSandbox()

		// Mock Logger methods to avoid HostProvider dependency
		sandbox.stub(Logger, "info").returns()
		sandbox.stub(Logger, "error").returns()
		// Mock ErrorService to avoid telemetry dependency
		const mockErrorService = {
			logMessage: sandbox.stub(),
			logException: sandbox.stub(),
			toDiracError: sandbox.stub(),
			isEnabled: sandbox.stub().returns(false),
			getSettings: sandbox.stub().returns({ enabled: false, hostEnabled: false }),
			getProvider: sandbox.stub(),
			dispose: sandbox.stub().resolves(),
		}
		sandbox.stub(ErrorService, "initialize").resolves(mockErrorService as any)
		sandbox.stub(ErrorService, "get").returns(mockErrorService as any)

		await ErrorService.initialize()

		completeOpenRouterAuthStub = sandbox.stub().resolves()
		handleAuthCallbackStub = sandbox.stub().resolves()
		const mockDiracWebviewProvider = {
			controller: {
				completeOpenRouterAuth: completeOpenRouterAuthStub,
				handleAuthCallback: handleAuthCallbackStub,
			},
		} as any
		sandbox.stub(DiracWebviewProvider, "getVisibleInstance").returns(mockDiracWebviewProvider)
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("handleUri", () => {
		describe("OpenRouter callback handling", () => {
			it("should successfully handle OpenRouter callback with code", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/openrouter?code=test123")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(completeOpenRouterAuthStub, "test123")
			})

			it("should return false when OpenRouter code is missing", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/openrouter")

				expect(result).to.be.false
				expect(completeOpenRouterAuthStub.called).to.be.false
			})

			it("should handle URL with plus signs in code parameter", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/openrouter?code=test+123+abc")

				expect(result).to.be.true
				// Plus signs in query params are preserved
				sinon.assert.calledOnceWithExactly(completeOpenRouterAuthStub, "test+123+abc")
			})
		})

		describe("Auth callback handling", () => {
			it("should return false for auth path since handler was removed", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/auth?idToken=jwt123&provider=google")

				expect(result).to.be.false
				expect(handleAuthCallbackStub.called).to.be.false
			})
		})

		describe("Unknown path handling", () => {
			it("should return false for unknown paths", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/unknown?param=value")

				expect(result).to.be.false
				expect(handleAuthCallbackStub.called).to.be.false
				expect(completeOpenRouterAuthStub.called).to.be.false
			})
		})

		describe("Error handling", () => {
			it("should catch and log errors from controller methods", async () => {
				completeOpenRouterAuthStub.rejects(new Error("Controller error"))

				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/openrouter?code=test123")

				expect(result).to.be.false
			})

			it("should handle malformed URIs gracefully", async () => {
				const result = await SharedUriHandler.handleUri("invalid://uri")

				expect(result).to.be.false
				expect(handleAuthCallbackStub.called).to.be.false
				expect(completeOpenRouterAuthStub.called).to.be.false
			})
		})

		describe("Query parameter parsing", () => {
			it("should correctly parse multiple query parameters", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/openrouter?code=test123&extra=param")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(completeOpenRouterAuthStub, "test123")
			})

			it("should handle URL-encoded parameters", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/openrouter?code=test%20123")

				expect(result).to.be.true
				// URLSearchParams should decode %20 to spaces
				sinon.assert.calledOnceWithExactly(completeOpenRouterAuthStub, "test 123")
			})

			it("should handle empty query string", async () => {
				const result = await SharedUriHandler.handleUri("vscode://dirac.dirac/openrouter")

				expect(result).to.be.false
				expect(handleAuthCallbackStub.called).to.be.false
				expect(completeOpenRouterAuthStub.called).to.be.false
			})
		})

		describe("Different URI schemes", () => {
			it("should handle HTTP scheme URIs", async () => {
				const result = await SharedUriHandler.handleUri("http://localhost:3000/openrouter?code=test123")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(completeOpenRouterAuthStub, "test123")
			})

			it("should handle HTTPS scheme URIs", async () => {
				const result = await SharedUriHandler.handleUri("https://example.com/openrouter?code=test123")

				expect(result).to.be.true
				sinon.assert.calledOnceWithExactly(completeOpenRouterAuthStub, "test123")
			})
		})
	})
})
