import { afterEach, describe, it } from "mocha";
import "should";
import sinon from "sinon";
import { SymbolIndexUpdateScheduler } from "../SymbolIndexUpdateScheduler";

describe("SymbolIndexUpdateScheduler", () => {
	let clock: sinon.SinonFakeTimers | undefined;
	let scheduler: SymbolIndexUpdateScheduler | undefined;

	afterEach(() => {
		scheduler?.dispose();
		clock?.restore();
		scheduler = undefined;
		clock = undefined;
	});

	it("rejects excluded paths before creating debounce work", () => {
		const updateFile = sinon.stub().resolves();
		scheduler = new SymbolIndexUpdateScheduler({
			shouldIndexPath: sinon.stub().returns(false),
			updateFile,
			removeFile: sinon.stub().resolves(),
			requestFullRescan: sinon.stub(),
		});

		scheduler.scheduleUpdate("/workspace/node_modules/a.ts");
		updateFile.notCalled.should.be.true();
	});

	it("coalesces duplicate paths into one update", async () => {
		clock = sinon.useFakeTimers();
		const updateFile = sinon.stub().resolves();
		scheduler = new SymbolIndexUpdateScheduler({
			shouldIndexPath: sinon.stub().returns(true),
			updateFile,
			removeFile: sinon.stub().resolves(),
			requestFullRescan: sinon.stub(),
		});

		scheduler.scheduleUpdate("/workspace/src/a.ts");
		scheduler.scheduleUpdate("/workspace/src/a.ts");
		await clock.tickAsync(1_000);
		sinon.assert.calledOnceWithExactly(updateFile, "/workspace/src/a.ts");
	});

	it("runs no more than two updates concurrently", async () => {
		clock = sinon.useFakeTimers();
		let active = 0;
		let maxActive = 0;
		const updateFile = sinon.stub().callsFake(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			active--;
		});
		scheduler = new SymbolIndexUpdateScheduler({
			shouldIndexPath: sinon.stub().returns(true),
			updateFile,
			removeFile: sinon.stub().resolves(),
			requestFullRescan: sinon.stub(),
		});

		for (let index = 0; index < 6; index++)
			scheduler.scheduleUpdate(`/workspace/src/${index}.ts`);
		await clock.tickAsync(1_000);
		await clock.tickAsync(30);
		maxActive.should.equal(2);
		updateFile.callCount.should.equal(6);
	});

	it("requests a full rescan after dirty-set overflow", () => {
		clock = sinon.useFakeTimers();
		const requestFullRescan = sinon.stub();
		scheduler = new SymbolIndexUpdateScheduler({
			shouldIndexPath: sinon.stub().returns(true),
			updateFile: sinon.stub().resolves(),
			removeFile: sinon.stub().resolves(),
			requestFullRescan,
		});

		for (let index = 0; index < 501; index++)
			scheduler.scheduleUpdate(`/workspace/src/${index}.ts`);
		sinon.assert.calledOnce(requestFullRescan);
	});
});
