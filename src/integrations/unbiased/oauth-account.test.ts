import assert from "node:assert/strict"
import { describe, it } from "mocha"
import type { UnbiasedDeviceToken } from "./device-auth"
import { createUnbiasedOAuthAccount, getUnbiasedOAuthWorkloadName, isUnbiasedOAuthApiKey } from "./oauth-account"

const token: UnbiasedDeviceToken = {
	accessToken: "private-oauth-key",
	organizationId: "organization",
	workloadId: "workload",
	workloadName: "Dirac workload",
	keyName: "Dirac key",
}

describe("Unbiased OAuth account identity", () => {
	it("creates serializable account identity without copying the credential", () => {
		const account = createUnbiasedOAuthAccount(token)
		assert.equal(JSON.stringify(account).includes(token.accessToken), false)
		assert.match(account.unbiasedOAuthApiKeyHash, /^[a-f0-9]{64}$/)
		const reopened = JSON.parse(JSON.stringify(account)) as typeof account
		assert.equal(
			getUnbiasedOAuthWorkloadName(token.accessToken, reopened.unbiasedOAuthApiKeyHash, reopened.unbiasedOAuthWorkloadName),
			token.workloadName,
		)
	})

	it("supports existing and manually configured keys without inventing an OAuth identity", () => {
		assert.equal(getUnbiasedOAuthWorkloadName("existing-private-key", undefined, undefined), undefined)
	})

	it("does not attribute the old workload to a replacement or environment-overridden key", () => {
		const account = createUnbiasedOAuthAccount(token)
		for (const apiKey of ["different-effective-key", undefined]) {
			assert.equal(
				getUnbiasedOAuthWorkloadName(apiKey, account.unbiasedOAuthApiKeyHash, account.unbiasedOAuthWorkloadName),
				undefined,
			)
		}
	})

	it("creates replacement account identity for the next OAuth login", () => {
		const replacement = { ...token, accessToken: "new-private-key", workloadName: "New workload" }
		const account = createUnbiasedOAuthAccount(replacement)
		assert.equal(
			getUnbiasedOAuthWorkloadName(
				replacement.accessToken,
				account.unbiasedOAuthApiKeyHash,
				account.unbiasedOAuthWorkloadName,
			),
			replacement.workloadName,
		)
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, account.unbiasedOAuthApiKeyHash), false)
	})
})

describe("Unbiased OAuth key matching", () => {
	it("matches an explicit request key independently of the current default account", () => {
		const { unbiasedOAuthApiKeyHash: hash } = createUnbiasedOAuthAccount(token)
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, hash), true)
		assert.equal(isUnbiasedOAuthApiKey("replacement-or-environment-key", hash), false)
		assert.equal(isUnbiasedOAuthApiKey(undefined, hash), false)
		assert.equal(isUnbiasedOAuthApiKey("", hash), false)
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, undefined), false)
	})

	it("does not depend on a nonempty workload display name", () => {
		const account = createUnbiasedOAuthAccount({ ...token, workloadName: "" })
		assert.equal(isUnbiasedOAuthApiKey(token.accessToken, account.unbiasedOAuthApiKeyHash), true)
		assert.equal(getUnbiasedOAuthWorkloadName(token.accessToken, account.unbiasedOAuthApiKeyHash, ""), "")
	})
})
