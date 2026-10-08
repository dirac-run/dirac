import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, it } from "mocha"
import sinon from "sinon"
import type { Controller } from "@/core/controller"
import * as deviceAuth from "@/integrations/unbiased/device-auth"
import { EmptyRequest } from "@/shared/proto/dirac/common"
import type { UnbiasedAuthEvent } from "@/shared/proto/dirac/models"
import { authenticateUnbiased } from "../authenticateUnbiased"
import { getUnbiasedOAuthWorkloadName } from "@/integrations/unbiased/oauth-account"
import * as transaction from "../apiConfigurationTransaction"

const token: deviceAuth.UnbiasedDeviceToken = {
	accessToken: "new-private-key",
	organizationId: "organization",
	workloadId: "workload",
	workloadName: "Dirac",
	keyName: "Dirac key",
}

function createHarness() {
	let key = "existing-private-key"
	const events: string[] = []
	const globalState: Record<string, string | undefined> = {}
	const stateManager = {
		getSecretKey: () => key,
		getApiConfiguration: () => ({ unbiasedApiKey: key }),
		getGlobalStateKey: (name: string) => globalState[name],
		setGlobalStateBatch: (updates: Record<string, string | undefined>) => Object.assign(globalState, updates),
		setApiConfiguration: sinon.stub().callsFake((patch: { unbiasedApiKey: string }) => {
			key = patch.unbiasedApiKey
		}),
		flushPendingState: sinon.stub().callsFake(async () => {
			events.push("credentials_saved")
		}),
	}
	const controller = {
		stateManager,
		postStateToWebview: sinon.stub().callsFake(async () => {
			events.push("state_published")
		}),
	} as unknown as Controller
	const responses: UnbiasedAuthEvent[] = []
	const stream = sinon.stub().callsFake(async (event: UnbiasedAuthEvent) => {
		responses.push(event)
		if (event.completed) events.push("completed")
	})
	return { controller, stateManager, stream, responses, events, key: () => key }
}

describe("Unbiased sign-in local completion", () => {
	let apply: sinon.SinonStub
	beforeEach(() => {
		sinon.stub(deviceAuth, "startUnbiasedDeviceAuth").resolves({
			deviceCode: "private-code",
			userCode: "ABCD-EFGH",
			verificationUri: "https://example.com/activate",
			verificationUriComplete: "https://example.com/activate?user_code=ABCD-EFGH",
			expiresIn: 900,
			interval: 1,
		})
		sinon.stub(deviceAuth, "pollUnbiasedDeviceAuth").resolves(token)
		apply = sinon.stub(transaction, "applyApiConfigurationTransaction").resolves()
	})
	afterEach(() => sinon.restore())

	it("replaces an existing key and publishes completion only after applying configuration", async () => {
		const harness = createHarness()
		apply.callsFake(async () => {
			harness.events.push("configuration_applied")
		})
		await authenticateUnbiased(harness.controller, EmptyRequest.create({}), harness.stream)
		assert.equal(harness.key(), token.accessToken)
		assert.equal(getUnbiasedOAuthWorkloadName(harness.controller.stateManager), token.workloadName)
		assert.deepEqual(harness.events, ["credentials_saved", "configuration_applied", "state_published", "completed"])
		assert.equal(harness.responses.at(-1)?.completed, true)
	})

	it("preserves the issued key and account when applying local configuration fails", async () => {
		const harness = createHarness()
		apply.rejects(new Error("configuration rejected"))
		await assert.rejects(
			authenticateUnbiased(harness.controller, EmptyRequest.create({}), harness.stream),
			/configuration rejected/,
		)
		assert.equal(harness.key(), token.accessToken)
		assert.equal(getUnbiasedOAuthWorkloadName(harness.controller.stateManager), token.workloadName)
		assert.deepEqual(harness.events, ["credentials_saved", "state_published"])
		assert.equal(
			harness.responses.some((event) => event.completed),
			false,
		)
	})

	it("does not publish completion while the local configuration update is pending", async () => {
		const harness = createHarness()
		let finish!: () => void
		apply.callsFake(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const signIn = authenticateUnbiased(harness.controller, EmptyRequest.create({}), harness.stream)
		await new Promise<void>((resolve) => setImmediate(resolve))
		assert.equal(harness.key(), token.accessToken)
		assert.equal(
			harness.responses.some((event) => event.completed),
			false,
		)
		finish()
		await signIn
		assert.equal(harness.responses.at(-1)?.completed, true)
	})
})
