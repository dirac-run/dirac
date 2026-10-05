import { describe, it } from "mocha"
import "should"
import { getHostCapabilities } from "@/hosts/host-capabilities"
import { HostProvider } from "@/hosts/host-provider"
import type { HostCapabilities } from "@/hosts/host-provider-types"
import { setVscodeHostProviderMock } from "@/test/host-provider-test-utils"

// The leaf accessor must fail exactly like HostProvider.get() so callers keep
// their existing error handling for uninitialized hosts.
describe("getHostCapabilities", () => {
	beforeEach(() => {
		HostProvider.reset()
	})

	afterEach(() => {
		HostProvider.reset()
	})

	it("throws before HostProvider is initialized", () => {
		;(() => getHostCapabilities()).should.throw("HostProvider not setup. Call HostProvider.initialize() first.")
	})

	it("returns the capabilities object passed to HostProvider.initialize", () => {
		const caps: HostCapabilities = { createVsCodeLmHandler: () => ({}) as never }
		setVscodeHostProviderMock({ capabilities: caps })
		;(getHostCapabilities() === caps).should.be.true()
	})

	it("throws again after HostProvider.reset()", () => {
		setVscodeHostProviderMock({ capabilities: {} })
		HostProvider.reset()
		;(() => getHostCapabilities()).should.throw("HostProvider not setup. Call HostProvider.initialize() first.")
	})
})
