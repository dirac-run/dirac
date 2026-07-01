import { expect } from "chai"
import * as path from "path"
import { expectLoggerErrors } from "@/test/loggerGuard"

const srcDir = path.join(__dirname, "..", "..", "..")

describe("API Retry Logic", () => {
	describe("withRetry", () => {
		it("should retry on 429 errors by default", async () => {
			const { withRetry, RetriableError } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 2, baseDelay: 10 })
				async *testMethod() {
					attempts++
					if (attempts < 2) {
						const err = new Error("rate limited")
							; (err as any).status = 429
						throw err
					}
					yield "success"
				}
			}
			const handler = new TestHandler()
			const result = handler.testMethod()
			const next = await result.next()
			expect(next.value).to.equal("success")
		})

		it("should throw after max retries exceeded", async () => {
			const { withRetry, RetriableError } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 2, baseDelay: 10 })
				async *testMethod() {
					attempts++
					const err = new Error("rate limited")
						; (err as any).status = 429
					throw err
				}
			}
			const handler = new TestHandler()
			try {
				await handler.testMethod().next()
				expect.fail("should have thrown")
			} catch (e: any) {
				expect(e.status).to.equal(429)
			}
		})

		it("should throw immediately on non-429 errors without retryAllErrors", async () => {
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 3, baseDelay: 10 })
				async *testMethod() {
					attempts++
					const err = new Error("server error")
						; (err as any).status = 500
					throw err
				}
			}
			const handler = new TestHandler()
			try {
				await handler.testMethod().next()
				expect.fail("should have thrown")
			} catch (e: any) {
				expect(e.status).to.equal(500)
				expect(attempts).to.equal(1)
			}
		})

		it("should retry on non-429 errors when retryAllErrors is true", async () => {
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 2, baseDelay: 10, retryAllErrors: true })
				async *testMethod() {
					attempts++
					if (attempts < 2) {
						const err = new Error("server error")
							; (err as any).status = 500
						throw err
					}
					yield "success"
				}
			}
			const handler = new TestHandler()
			const next = await handler.testMethod().next()
			expect(next.value).to.equal("success")
		})

		it("should call onRetryAttempt callback with attempt info", async () => {
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			const retryAttempts: number[] = []
			class TestHandler {
				options = { onRetryAttempt: async (attempt: number) => retryAttempts.push(attempt) }
				@withRetry({ maxRetries: 2, baseDelay: 10 })
				async *testMethod() {
					const err = new Error("rate limited")
						; (err as any).status = 429
					throw err
				}
			}
			const handler = new TestHandler()
			try {
				await handler.testMethod().next()
			} catch (e) { }
			expect(retryAttempts).to.have.length(1)
			expect(retryAttempts[0]).to.equal(1)
		})

		it("should use retry-after header for delay calculation", async () => {
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 2, baseDelay: 10 })
				async *testMethod() {
					attempts++
					const err = new Error("rate limited")
						; (err as any).status = 429
						; (err as any).headers = { "retry-after": "0.01" }
					throw err
				}
			}
			const handler = new TestHandler()
			const start = Date.now()
			try {
				await handler.testMethod().next()
			} catch (e) { }
			const elapsed = Date.now() - start
			expect(elapsed).to.be.lessThan(200)
		})

		it("should use exponential backoff when no retry-after header", async () => {
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 2, baseDelay: 10, maxDelay: 100 })
				async *testMethod() {
					attempts++
					const err = new Error("rate limited")
						; (err as any).status = 429
					throw err
				}
			}
			const handler = new TestHandler()
			const start = Date.now()
			try {
				await handler.testMethod().next()
			} catch (e) { }
			const elapsed = Date.now() - start
			expect(elapsed).to.be.lessThan(500)
		})

		it("should cap delay at maxDelay", async () => {
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 3, baseDelay: 1000, maxDelay: 50 })
				async *testMethod() {
					attempts++
					const err = new Error("rate limited")
						; (err as any).status = 429
					throw err
				}
			}
			const handler = new TestHandler()
			const start = Date.now()
			try {
				await handler.testMethod().next()
			} catch (e) { }
			const elapsed = Date.now() - start
			expect(elapsed).to.be.lessThan(200)
		})

		it("should handle RetriableError as retriable", async () => {
			const { withRetry, RetriableError } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 2, baseDelay: 10 })
				async *testMethod() {
					attempts++
					if (attempts < 2) {
						throw new RetriableError("rate limited")
					}
					yield "success"
				}
			}
			const handler = new TestHandler()
			const next = await handler.testMethod().next()
			expect(next.value).to.equal("success")
		})

		it("should handle retry-after as Unix timestamp", async () => {
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			let attempts = 0
			class TestHandler {
				options = { onRetryAttempt: async () => { } }
				@withRetry({ maxRetries: 2, baseDelay: 10 })
				async *testMethod() {
					attempts++
					const futureTime = Date.now() / 1000 + 0.01
					const err = new Error("rate limited")
						; (err as any).status = 429
						; (err as any).headers = { "retry-after": String(Math.floor(futureTime)) }
					throw err
				}
			}
			const handler = new TestHandler()
			const start = Date.now()
			try {
				await handler.testMethod().next()
			} catch (e) { }
			const elapsed = Date.now() - start
			expect(elapsed).to.be.lessThan(200)
		})

		it("should log error when onRetryAttempt callback throws", async () => {
			expectLoggerErrors()
			const { withRetry } = await import(path.join(srcDir, "core", "api", "retry.ts"))
			class TestHandler {
				options = {
					onRetryAttempt: async () => {
						throw new Error("callback error")
					},
				}
				@withRetry({ maxRetries: 2, baseDelay: 10 })
				async *testMethod() {
					const err = new Error("rate limited")
						; (err as any).status = 429
					throw err
				}
			}
			const handler = new TestHandler()
			try {
				await handler.testMethod().next()
			} catch (e) { }
		})
	})
})
