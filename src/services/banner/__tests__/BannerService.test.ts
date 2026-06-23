/**
 * Characterization tests for BannerService.
 * Captures current behavior — bugs and all.
 *
 * Phase 0 — Prerequisite coverage for refactoring
 */

import type { Banner } from "@shared/DiracBanner"
import { BannerActionType } from "@shared/dirac/banner"
import { afterEach, beforeEach, describe, it } from "mocha"
import should from "should"
import sinon from "sinon"
import { DiracEnv } from "@/config"
import { StateManager } from "@/core/storage/StateManager"
import { HostRegistryInfo } from "@/registry"
import * as net from "@/shared/net"
import { FeatureFlag } from "@/shared/services/feature-flags/feature-flags"
import { Logger } from "@/shared/services/Logger"
import * as EnvUtils from "../../EnvUtils"
import { FeatureFlagsService } from "../../feature-flags"
import { BannerService } from "../BannerService"

describe("BannerService", () => {
	let sandbox: sinon.SinonSandbox
	let mockController: any
	let mockStateManager: any
	let mockHostInfo: any

	beforeEach(() => {
		sandbox = sinon.createSandbox()

		// Silence Logger
		sandbox.stub(Logger, "log")
		sandbox.stub(Logger, "error")
		sandbox.stub(Logger, "info")

		// Build mock StateManager
		mockStateManager = {
			getGlobalStateKey: sandbox.stub().returns([]),
			setGlobalState: sandbox.stub(),
			setGlobalStateBatch: sandbox.stub(),
			getApiConfiguration: sandbox.stub().returns({}),
			getGlobalSettingsKey: sandbox.stub().returns("act"),
		}
		sandbox.stub(StateManager, "get").returns(mockStateManager)

		// Build mock host info
		mockHostInfo = {
			distinctId: "test-distinct-id",
			hostVersion: "1.0.0",
			extensionVersion: "1.0.0",
			platform: "darwin",
			os: "darwin",
			ide: "vscode",
		}
		sandbox.stub(HostRegistryInfo, "get").returns(mockHostInfo)

		// Build mock Controller
		mockController = {
			stateManager: mockStateManager,
			postStateToWebview: sandbox.stub().resolves(),
		}

		// Stub DiracEnv
		sandbox.stub(DiracEnv, "config").returns({ apiBaseUrl: "https://api.dirac.run" } as any)

		// Stub buildBasicDiracHeaders
		sandbox.stub(EnvUtils, "buildBasicDiracHeaders").resolves({ "x-dirac-header": "test" })

		// Stub feature flags on prototype — the proxy calls getFeatureFlagsService()
		// which creates a real instance; stubbing the prototype intercepts all instances
		sandbox.stub(FeatureFlagsService.prototype, "getBooleanFlagEnabled").returns(false)
		sandbox.stub(FeatureFlagsService.prototype, "getFlagPayload").returns(undefined)

		// Stub fetch to prevent real network calls
		sandbox.stub(net, "fetch").resolves({
			ok: true,
			json: sandbox.stub().resolves({
				data: { items: [], nextToken: "" },
				success: true,
			}),
		} as any)

		// Reset singleton
		BannerService.reset()
	})

	afterEach(() => {
		BannerService.reset()
		sandbox.restore()
	})

	// ---------------------------------------------------------------
	describe("static initialize", () => {
		it("creates singleton instance when HostRegistryInfo is available", () => {
			const svc = BannerService.initialize(mockController)
			svc.should.be.instanceOf(BannerService)
		})

		it("returns existing instance if already initialized", () => {
			const first = BannerService.initialize(mockController)
			const second = BannerService.initialize(mockController)
			second.should.equal(first)
		})

		it("throws if HostRegistryInfo is not initialized", () => {
			BannerService.reset()
			;(HostRegistryInfo.get as sinon.SinonStub).returns(null)
			;(() => BannerService.initialize(mockController)).should.throw(/Ensure HostRegistryInfo is initialized/)
		})
	})

	// ---------------------------------------------------------------
	describe("static get", () => {
		it("returns singleton after initialize", () => {
			const svc = BannerService.initialize(mockController)
			BannerService.get().should.equal(svc)
		})

		it("throws if not initialized", () => {
			BannerService.reset()
			;(() => BannerService.get()).should.throw(/BannerService not initialized/)
		})
	})

	// ---------------------------------------------------------------
	describe("static reset", () => {
		it("clears singleton instance", () => {
			BannerService.initialize(mockController)
			BannerService.reset()
			;(() => BannerService.get()).should.throw()
		})

		it("is idempotent — does not throw when no instance exists", () => {
			BannerService.reset()
			BannerService.reset()
			// Should not throw
		})
	})

	// ---------------------------------------------------------------
	describe("getActiveBanners", () => {
		function makeBanner(overrides: Partial<Banner> = {}): Banner {
			return {
				id: "banner-1",
				titleMd: "Test Title",
				bodyMd: "Test Body",
				icon: "megaphone",
				rulesJson: "{}",
				actions: [{ title: "Click", action: BannerActionType.Link, arg: "https://example.com" }],
				placement: "top",
				...overrides,
			}
		}

		beforeEach(() => {
			BannerService.initialize(mockController)
		})

		it("returns active banners (placement !== 'welcome') that are not dismissed", () => {
			const svc = BannerService.get()
			// Seed cache directly and prevent fetch
			;(svc as any).remote.cachedBanners = [
				makeBanner({ id: "b1", placement: "top" }),
				makeBanner({ id: "b2", placement: "bottom" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getActiveBanners()
			result.should.have.length(2)
			result[0].id.should.equal("b1")
			result[1].id.should.equal("b2")
		})

		it("excludes welcome banners from active banners", () => {
			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [
				makeBanner({ id: "b1", placement: "top" }),
				makeBanner({ id: "w1", placement: "welcome" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getActiveBanners()
			result.should.have.length(1)
			result[0].id.should.equal("b1")
		})

		it("excludes dismissed banners", () => {
			const svc = BannerService.get()
			mockStateManager.getGlobalStateKey.returns([{ bannerId: "b1", dismissedAt: Date.now() }])
			;(svc as any).remote.cachedBanners = [
				makeBanner({ id: "b1", placement: "top" }),
				makeBanner({ id: "b2", placement: "top" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getActiveBanners()
			result.should.have.length(1)
			result[0].id.should.equal("b2")
		})

		it("excludes banners with invalid action types", () => {
			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [
				makeBanner({
					id: "b1",
					placement: "top",
					actions: [{ title: "Bad", action: "invalid-action-type" }],
				}),
				makeBanner({ id: "b2", placement: "top" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getActiveBanners()
			result.should.have.length(1)
			result[0].id.should.equal("b2")
		})

		it("excludes banners with actions missing title", () => {
			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [
				makeBanner({
					id: "b1",
					placement: "top",
					actions: [{ action: BannerActionType.Link, arg: "https://x.com" }], // no title
				}),
				makeBanner({ id: "b2", placement: "top" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getActiveBanners()
			result.should.have.length(1)
			result[0].id.should.equal("b2")
		})

		it("returns empty array when no cached banners", () => {
			const svc = BannerService.get()
			;(svc as any).remote.lastFetchTime = Date.now()
			;(svc as any).remote.cachedBanners = []

			const result = svc.getActiveBanners()
			result.should.be.an.Array()
			result.should.be.empty()
		})

		it("triggers fetch when cache is expired", () => {
			const svc = BannerService.get()
			;(svc as any).remote.lastFetchTime = 0 // expired
			;(svc as any).remote.cachedBanners = []

			// Allow REMOTE_BANNERS flag to be true so fetchBanners proceeds
			;(FeatureFlagsService.prototype.getBooleanFlagEnabled as sinon.SinonStub).returns(true)

			const result = svc.getActiveBanners()
			// Returns current (empty) cache while fetch is in-flight
			result.should.be.an.Array()
			result.should.be.empty()
		})

		it("returns BannerCardData with correct structure", () => {
			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [
				makeBanner({
					id: "b1",
					titleMd: "Hello",
					bodyMd: "World",
					icon: "star",
					placement: "top",
				}),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getActiveBanners()
			result[0].should.deepEqual({
				id: "b1",
				title: "Hello",
				description: "World",
				icon: "star",
				actions: [{ title: "Click", action: BannerActionType.Link, arg: "https://example.com" }],
			})
		})
	})

	// ---------------------------------------------------------------
	describe("getWelcomeBanners", () => {
		function makeBanner(overrides: Partial<Banner> = {}): Banner {
			return {
				id: "banner-1",
				titleMd: "Welcome Title",
				bodyMd: "Welcome Body",
				icon: "megaphone",
				rulesJson: "{}",
				actions: [{ title: "Click", action: BannerActionType.Link, arg: "https://example.com" }],
				placement: "welcome",
				...overrides,
			}
		}

		beforeEach(() => {
			BannerService.initialize(mockController)
		})

		it("returns welcome banners when feature flag is enabled", () => {
			;(FeatureFlagsService.prototype.getBooleanFlagEnabled as sinon.SinonStub)
				.withArgs(FeatureFlag.REMOTE_WELCOME_BANNERS)
				.returns(true)

			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [
				makeBanner({ id: "w1", placement: "welcome" }),
				makeBanner({ id: "w2", placement: "welcome" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getWelcomeBanners()
			result?.should.have.length(2)
			result?.[0].id.should.equal("w1")
		})

		it("returns undefined when REMOTE_WELCOME_BANNERS feature flag is off", () => {
			;(FeatureFlagsService.prototype.getBooleanFlagEnabled as sinon.SinonStub).returns(false)

			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [makeBanner({ id: "w1" })]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getWelcomeBanners()
			;(result === undefined).should.be.true()
		})

		it("excludes non-welcome banners", () => {
			;(FeatureFlagsService.prototype.getBooleanFlagEnabled as sinon.SinonStub)
				.withArgs(FeatureFlag.REMOTE_WELCOME_BANNERS)
				.returns(true)

			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [
				makeBanner({ id: "w1", placement: "welcome" }),
				makeBanner({ id: "b1", placement: "top" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getWelcomeBanners()
			result?.should.have.length(1)
			result?.[0].id.should.equal("w1")
		})

		it("excludes dismissed welcome banners", () => {
			;(FeatureFlagsService.prototype.getBooleanFlagEnabled as sinon.SinonStub)
				.withArgs(FeatureFlag.REMOTE_WELCOME_BANNERS)
				.returns(true)

			mockStateManager.getGlobalStateKey.returns([{ bannerId: "w1", dismissedAt: Date.now() }])

			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [
				makeBanner({ id: "w1", placement: "welcome" }),
				makeBanner({ id: "w2", placement: "welcome" }),
			]
			;(svc as any).remote.lastFetchTime = Date.now()

			const result = svc.getWelcomeBanners()
			result?.should.have.length(1)
			result?.[0].id.should.equal("w2")
		})
	})

	// ---------------------------------------------------------------
	describe("isBannerDismissed", () => {
		beforeEach(() => {
			BannerService.initialize(mockController)
		})

		it("returns true when banner is in dismissed list", () => {
			mockStateManager.getGlobalStateKey.returns([
				{ bannerId: "b1", dismissedAt: Date.now() },
				{ bannerId: "b2", dismissedAt: Date.now() },
			])

			const svc = BannerService.get()
			svc.isBannerDismissed("b1").should.be.true()
			svc.isBannerDismissed("b2").should.be.true()
		})

		it("returns false when banner is not in dismissed list", () => {
			mockStateManager.getGlobalStateKey.returns([{ bannerId: "b1", dismissedAt: Date.now() }])

			const svc = BannerService.get()
			svc.isBannerDismissed("unknown").should.be.false()
		})

		it("returns false when no banners have been dismissed", () => {
			mockStateManager.getGlobalStateKey.returns([])

			const svc = BannerService.get()
			svc.isBannerDismissed("anything").should.be.false()
		})

		it("returns false when getGlobalStateKey returns undefined/null", () => {
			mockStateManager.getGlobalStateKey.returns(undefined)

			const svc = BannerService.get()
			svc.isBannerDismissed("b1").should.be.false()
		})

		it("returns false when getGlobalStateKey throws", () => {
			mockStateManager.getGlobalStateKey.throws(new Error("boom"))

			const svc = BannerService.get()
			svc.isBannerDismissed("b1").should.be.false()
		})
	})

	// ---------------------------------------------------------------
	describe("dismissBanner", () => {
		beforeEach(() => {
			BannerService.initialize(mockController)
		})

		it("adds banner to dismissed list via StateManager", async () => {
			mockStateManager.getGlobalStateKey.returns([])

			const svc = BannerService.get()
			await svc.dismissBanner("b1")

			sinon.assert.calledWith(
				mockStateManager.setGlobalState,
				"dismissedBanners",
				sinon.match([{ bannerId: "b1", dismissedAt: sinon.match.number }]),
			)
		})

		it("does not re-add banner that is already dismissed", async () => {
			mockStateManager.getGlobalStateKey.returns([{ bannerId: "b1", dismissedAt: 123 }])

			const svc = BannerService.get()
			await svc.dismissBanner("b1")

			// setGlobalState should not be called since already dismissed
			;(mockStateManager.setGlobalState as sinon.SinonStub).called.should.be.false()
		})

		it("clears cache after dismissal", async () => {
			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [{ id: "b1" }]
			;(svc as any).remote.lastFetchTime = 100

			mockStateManager.getGlobalStateKey.returns([])
			await svc.dismissBanner("b1")

			;(svc as any).remote.cachedBanners.should.be.empty()
			;(svc as any).remote.lastFetchTime.should.equal(0)
		})
	})

	// ---------------------------------------------------------------
	describe("clearCache", () => {
		beforeEach(() => {
			BannerService.initialize(mockController)
		})

		it("resets all cache-related state", () => {
			const svc = BannerService.get()
			;(svc as any).remote.cachedBanners = [{ id: "b1" }]
			;(svc as any).remote.lastFetchTime = 12345
			;(svc as any).remote.consecutiveFailures = 5
			;(svc as any).remote.backoffUntil = 99999
			;(svc as any).remote.fetchPromise = Promise.resolve([])

			svc.clearCache()

			;(svc as any).remote.cachedBanners.should.be.empty()
			;(svc as any).remote.lastFetchTime.should.equal(0)
			;(svc as any).remote.consecutiveFailures.should.equal(0)
			;(svc as any).remote.backoffUntil.should.equal(0)
			should((svc as any).remote.fetchPromise).be.null()
		})

		it("aborts pending fetch if abortController exists", () => {
			const svc = BannerService.get()
			const abortStub = sandbox.stub()
			;(svc as any).remote.abortController = { abort: abortStub }

			svc.clearCache()

			sinon.assert.calledOnce(abortStub)
			should((svc as any).remote.abortController).be.null()
		})
	})

	// ---------------------------------------------------------------
	describe("sendBannerEvent", () => {
		beforeEach(() => {
			BannerService.initialize(mockController)
		})

		it("sends POST request to banners API with correct body", async () => {
			const svc = BannerService.get()
			await svc.sendBannerEvent("b1", "dismiss")

			sinon.assert.calledOnce(net.fetch as sinon.SinonStub)
			const callArgs = (net.fetch as sinon.SinonStub).firstCall.args
			const url: string = callArgs[0]
			const options: any = callArgs[1]

			url.should.containEql("/banners/v2/messages")
			options.method.should.equal("POST")
			const body = JSON.parse(options.body)
			body.banner_id.should.equal("b1")
			body.instance_id.should.equal(mockHostInfo.distinctId)
			body.event_type.should.equal("dismiss")
		})

		it("does not throw when fetch fails", async () => {
			;(net.fetch as sinon.SinonStub).rejects(new Error("network down"))

			const svc = BannerService.get()
			// Should not throw — errors are caught internally
			await svc.sendBannerEvent("b1", "dismiss")
		})
	})
})
