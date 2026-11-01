import { strict as assert } from "node:assert"
import { describe, it } from "mocha"
import sinon from "sinon"
import { ToolExecutor } from "../ToolExecutor"

function browserSettings(remoteBrowserHost: string) {
	return {
		viewport: { width: 900, height: 700 },
		remoteBrowserEnabled: true,
		remoteBrowserHost,
		disableToolUse: false,
		customArgs: "",
	} as any
}

describe("ToolExecutor browser request runtime", () => {
	it("recreates the browser from request-bound settings rather than newer Task settings", async () => {
		const requestSettings = browserSettings("request.example")
		const newerTaskSettings = browserSettings("newer-task.example")
		const dispose = sinon.stub().resolves()
		const fakeExecutor = {
			taskState: { abort: false },
			installBrowserSession: sinon.stub(),
			browserSession: { dispose },
			ulid: "task-ulid",
			requestRuntime: () => ({
				api: { getModel: () => ({ id: "claude-test", info: {} }) },
				workingConfiguration: { settings: { browserSettings: requestSettings } },
			}),
			getCurrentWorkingConfiguration: () => ({ settings: { browserSettings: newerTaskSettings } }),
		}

		const session = await ToolExecutor.prototype.applyLatestBrowserSettings.call(fakeExecutor as any)
		const connection = (session as any).connection

		sinon.assert.calledOnce(dispose)
		assert.deepEqual(connection.settingsSource, requestSettings)
		assert.notDeepEqual(connection.settingsSource, newerTaskSettings)
		assert.equal((session as any).useWebp, true)
		assert.equal(connection.ulid, "task-ulid")
	})

	it("does not install after abort while old session disposal is pending", async () => {
		let finishDisposal!: () => void
		const dispose = sinon.stub().returns(
			new Promise<void>((resolve) => {
				finishDisposal = resolve
			}),
		)
		const installBrowserSession = sinon.stub()
		const oldSession = { dispose }
		const executor = {
			taskState: { abort: false },
			browserSession: oldSession,
			installBrowserSession,
			requestRuntime: () => ({
				api: { getModel: () => ({ id: "test", info: {} }) },
				workingConfiguration: { settings: { browserSettings: browserSettings("request.example") } },
			}),
		}
		const replacement = ToolExecutor.prototype.applyLatestBrowserSettings.call(executor as any)
		executor.taskState.abort = true
		finishDisposal()
		await assert.rejects(replacement, /after task abort/)
		sinon.assert.notCalled(installBrowserSession)
		assert.equal(executor.browserSession, oldSession)
	})


	it("propagates old-session cleanup failure without installing a replacement", async () => {
		const executor = {
			taskState: { abort: false },
			browserSession: { dispose: sinon.stub().rejects(new Error("cleanup failed")) },
			installBrowserSession: sinon.stub(),
			requestRuntime: () => ({}),
		}
		await assert.rejects(ToolExecutor.prototype.applyLatestBrowserSettings.call(executor as any), /cleanup failed/)
		sinon.assert.notCalled(executor.installBrowserSession)
	})

	it("does not start replacement after abort", async () => {
		const dispose = sinon.stub()
		await assert.rejects(
			ToolExecutor.prototype.applyLatestBrowserSettings.call({
				taskState: { abort: true },
				browserSession: { dispose },
			} as any),
			/after task abort/,
		)
		sinon.assert.notCalled(dispose)
	})

	it("disposes a replacement rejected by the lifecycle barrier after normal completion", async () => {
		let finishDisposal!: () => void
		const oldSession = {
			dispose: sinon.stub().returns(
				new Promise<void>((resolve) => {
					finishDisposal = resolve
				}),
			),
		}
		const barrierError = new Error("Task resources have stopped")
		let stopped = false
		let rejectedSession: any
		const executor = {
			taskState: { abort: false },
			browserSession: oldSession,
			installBrowserSession: (session: any) => {
				assert.equal(stopped, true)
				rejectedSession = session
				throw barrierError
			},
			requestRuntime: () => ({
				api: { getModel: () => ({ id: "test", info: {} }) },
				workingConfiguration: { settings: { browserSettings: browserSettings("request.example") } },
			}),
		}
		const replacement = ToolExecutor.prototype.applyLatestBrowserSettings.call(executor as any)
		stopped = true
		finishDisposal()
		await assert.rejects(replacement, (error) => error === barrierError)
		assert.equal(executor.browserSession, oldSession)
		await assert.rejects(rejectedSession.launchBrowser(), /disposed/)
	})
})
