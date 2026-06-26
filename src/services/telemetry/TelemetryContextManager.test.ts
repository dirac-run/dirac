/**
 * Tests for TelemetryContextManager.
 * Verifies context state management and attribute merging.
 */
import { describe, it } from "mocha"
import "should"
import { TelemetryContextManager } from "./TelemetryContextManager"
import type { TelemetryMetadata } from "./TelemetryService"

const MOCK_METADATA: TelemetryMetadata = {
	extension_version: "1.0.0",
	dirac_type: "vscode",
	platform: "VSCode",
	platform_version: "1.85.0",
	os_type: "darwin",
	os_version: "Darwin 21.6.0",
} as any

const MOCK_USER = {
	id: "user-123",
	organizationId: "org-456",
	organizationName: "Test Org",
	memberId: "member-789",
}

describe("TelemetryContextManager", () => {
	describe("getStandardAttributes", () => {
		it("returns metadata only when user is not identified", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			const attrs = ctx.getStandardAttributes()
			attrs.should.have.property("extension_version", "1.0.0")
			attrs.should.not.have.property("userId")
		})

		it("includes userId and org info after setUserInfo", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			ctx.setUserInfo(MOCK_USER)
			const attrs = ctx.getStandardAttributes()
			attrs.should.have.property("userId", "user-123")
			attrs.should.have.property("organization_id", "org-456")
			attrs.should.have.property("organization_name", "Test Org")
			attrs.should.have.property("member_id", "member-789")
		})

		it("merges extra attributes", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			const attrs = ctx.getStandardAttributes({ custom: "value", task_id: "abc" })
			attrs.should.have.property("custom", "value")
			attrs.should.have.property("task_id", "abc")
			attrs.should.have.property("extension_version", "1.0.0")
		})

		it("extra attributes override metadata keys", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			const attrs = ctx.getStandardAttributes({ extension_version: "2.0.0" })
			attrs.should.have.property("extension_version", "2.0.0")
		})

		it("handles undefined extra", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			const attrs = ctx.getStandardAttributes(undefined)
			attrs.should.have.property("extension_version", "1.0.0")
		})

		it("handles empty object extra", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			const attrs = ctx.getStandardAttributes({})
			attrs.should.have.property("extension_version", "1.0.0")
		})
	})

	describe("setUserInfo", () => {
		it("sets userId", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			ctx.setUserInfo(MOCK_USER)
			should.equal(ctx.getUserId(), "user-123")
		})

		it("sets activeOrg", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			ctx.setUserInfo(MOCK_USER)
			const org = ctx.getActiveOrg()
			org!.should.not.be.null()
			org!.organization_id.should.equal("org-456")
		})

		it("overwrites previous user info on re-call", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			ctx.setUserInfo(MOCK_USER)
			ctx.setUserInfo({ id: "user-999", organizationId: "org-999", organizationName: "New Org", memberId: "m-999" })
			should.equal(ctx.getUserId(), "user-999")
			should.equal(ctx.getActiveOrg()?.organization_name, "New Org")
		})
	})

	describe("getUserId", () => {
		it("returns undefined before setUserInfo", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			should.equal(ctx.getUserId(), undefined)
		})
	})

	describe("getActiveOrg", () => {
		it("returns null before setUserInfo", () => {
			const ctx = new TelemetryContextManager(MOCK_METADATA)
			should.equal(ctx.getActiveOrg(), null)
		})
	})
})
