/**
 * Tests for environment check functions.
 * Verifies the functions correctly detect dev/test/local modes.
 * Uses process.env mutation to test each scenario in isolation.
 */
import "should"
import { isDev, isTest, isE2E, isLocal, isDevelopmentMode } from "./environment"

describe("environment checks", () => {
	const originalEnv = { ...process.env }

	afterEach(() => {
		// Restore original env state
		delete process.env.IS_DEV
		delete process.env.E2E_TEST
		delete process.env.IS_TEST
		delete process.env.DIRAC_ENVIRONMENT
		Object.assign(process.env, originalEnv)
	})

	describe("isDev", () => {
		it("returns true when IS_DEV is 'true'", () => {
			process.env.IS_DEV = "true"
			isDev().should.be.true()
		})
		it("returns false when IS_DEV is 'false' (string comparison, not truthy)", () => {
			process.env.IS_DEV = "false"
			isDev().should.be.false()
		})
		it("returns false when IS_DEV is unset", () => {
			delete process.env.IS_DEV
			isDev().should.be.false()
		})
		it("returns false when IS_DEV is empty string", () => {
			process.env.IS_DEV = ""
			isDev().should.be.false()
		})
		it("returns false when IS_DEV is '1' (not 'true')", () => {
			process.env.IS_DEV = "1"
			isDev().should.be.false()
		})
	})

	describe("isTest", () => {
		it("returns true when E2E_TEST is 'true'", () => {
			process.env.E2E_TEST = "true"
			isTest().should.be.true()
		})
		it("returns true when IS_TEST is 'true'", () => {
			process.env.IS_TEST = "true"
			isTest().should.be.true()
		})
		it("returns true when both E2E_TEST and IS_TEST are 'true'", () => {
			process.env.E2E_TEST = "true"
			process.env.IS_TEST = "true"
			isTest().should.be.true()
		})
		it("returns false when neither is set", () => {
			delete process.env.E2E_TEST
			delete process.env.IS_TEST
			isTest().should.be.false()
		})
		it("returns false when E2E_TEST is 'false'", () => {
			process.env.E2E_TEST = "false"
			isTest().should.be.false()
		})
	})

	describe("isE2E", () => {
		it("returns true when E2E_TEST is 'true'", () => {
			process.env.E2E_TEST = "true"
			isE2E().should.be.true()
		})
		it("returns false when E2E_TEST is unset (even if IS_TEST is set)", () => {
			delete process.env.E2E_TEST
			process.env.IS_TEST = "true"
			isE2E().should.be.false()
		})
		it("returns false when E2E_TEST is 'false'", () => {
			process.env.E2E_TEST = "false"
			isE2E().should.be.false()
		})
		it("returns false when both E2E_TEST and IS_TEST are unset", () => {
			delete process.env.E2E_TEST
			delete process.env.IS_TEST
			isE2E().should.be.false()
		})
		it("is narrower than isTest — IS_TEST alone does not flip isE2E", () => {
			delete process.env.E2E_TEST
			process.env.IS_TEST = "true"
			isTest().should.be.true()
			isE2E().should.be.false()
		})
	})

	describe("isLocal", () => {
		it("returns true when DIRAC_ENVIRONMENT is 'local'", () => {
			process.env.DIRAC_ENVIRONMENT = "local"
			isLocal().should.be.true()
		})
		it("returns false when DIRAC_ENVIRONMENT is 'production'", () => {
			process.env.DIRAC_ENVIRONMENT = "production"
			isLocal().should.be.false()
		})
		it("returns false when DIRAC_ENVIRONMENT is unset", () => {
			delete process.env.DIRAC_ENVIRONMENT
			isLocal().should.be.false()
		})
		it("returns false when DIRAC_ENVIRONMENT is 'dev' (not 'local')", () => {
			process.env.DIRAC_ENVIRONMENT = "dev"
			isLocal().should.be.false()
		})
	})

	describe("isDevelopmentMode", () => {
		it("returns true when IS_DEV=true, DIRAC_ENVIRONMENT=production", () => {
			process.env.IS_DEV = "true"
			process.env.DIRAC_ENVIRONMENT = "production"
			isDevelopmentMode().should.be.true()
		})
		it("returns true when IS_DEV=false, DIRAC_ENVIRONMENT=local", () => {
			delete process.env.IS_DEV
			process.env.DIRAC_ENVIRONMENT = "local"
			isDevelopmentMode().should.be.true()
		})
		it("returns true when both IS_DEV=true and DIRAC_ENVIRONMENT=local", () => {
			process.env.IS_DEV = "true"
			process.env.DIRAC_ENVIRONMENT = "local"
			isDevelopmentMode().should.be.true()
		})
		it("returns false when neither IS_DEV nor DIRAC_ENVIRONMENT=local", () => {
			delete process.env.IS_DEV
			process.env.DIRAC_ENVIRONMENT = "production"
			isDevelopmentMode().should.be.false()
		})
		it("returns false when both unset", () => {
			delete process.env.IS_DEV
			delete process.env.DIRAC_ENVIRONMENT
			isDevelopmentMode().should.be.false()
		})
	})
})
