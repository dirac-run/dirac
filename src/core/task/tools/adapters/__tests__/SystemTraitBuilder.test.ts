import assert from "node:assert/strict"
import { describe, it } from "mocha"
import proxyquire from "proxyquire"
import sinon from "sinon"
import type { TaskConfig } from "../../types/TaskConfig"

describe("SystemTraitBuilder notification routing", () => {
	it("keeps tasklet notifications private and preserves foreground notifications", () => {
		const showSystemNotification = sinon.stub().resolves()
		const { buildSystemTrait } = proxyquire("../traits/SystemTraitBuilder", {
			"@integrations/notifications": { showSystemNotification },
		}) as typeof import("../traits/SystemTraitBuilder")
		const options = { message: "Need input" }
		const execute = sinon.stub().resolves()
		buildSystemTrait({ executionProfile: "tasklet" } as TaskConfig, execute).showNotification(options)
		sinon.assert.notCalled(showSystemNotification)
		buildSystemTrait({ executionProfile: "standalone" } as TaskConfig, execute).showNotification(options)
		sinon.assert.calledOnceWithExactly(showSystemNotification, options)
		assert.equal(execute.callCount, 0)
	})
})
