import { LoggerProvider } from "@opentelemetry/sdk-logs"
import { describe, it } from "mocha"
import sinon from "sinon"
import "should"
import type { OpenTelemetryClientValidConfig } from "@/shared/services/config/otel-config"
import * as exporterFactory from "./OpenTelemetryExporterFactory"
import { OpenTelemetryClientProvider } from "./OpenTelemetryClientProvider"

/**
 * The provider applies `config.X ?? <default>` when wiring the OTel SDK; these
 * tests capture what the SDK layer actually receives for a config whose
 * numeric fields are all undefined (as a malformed env value now produces).
 */
describe("OpenTelemetryClientProvider numeric defaults", () => {
	const baseConfig = {
		enabled: true,
		metricsExporter: "console",
		logsExporter: "console",
	} as OpenTelemetryClientValidConfig

	afterEach(() => {
		sinon.restore()
	})

	it("uses the 60000ms metric interval when metricExportInterval is undefined", async () => {
		const createReader = sinon
			.stub(exporterFactory, "createConsoleMetricReader")
			.returns({
				setMetricProducer: () => {},
				onShutdown: async () => {},
				shutdown: async () => {},
				forceFlush: async () => {},
				selectAggregationTemporality: () => 0,
			} as any)
		const provider = new OpenTelemetryClientProvider(baseConfig)
		await provider.dispose()
		createReader.firstCall.args[0].should.equal(60_000)
	})

	// `|| 60000` matches master's behaviour: an explicit 0 counts as "not provided"
	it("uses the 60000ms metric interval when metricExportInterval is 0", async () => {
		const createReader = sinon
			.stub(exporterFactory, "createConsoleMetricReader")
			.returns({
				setMetricProducer: () => {},
				onShutdown: async () => {},
				shutdown: async () => {},
				forceFlush: async () => {},
				selectAggregationTemporality: () => 0,
			} as any)
		const provider = new OpenTelemetryClientProvider({ ...baseConfig, metricExportInterval: 0 })
		await provider.dispose()
		createReader.firstCall.args[0].should.equal(60_000)
	})

	it("uses 2048/512/5000 batch defaults when the log settings are undefined", async () => {
		const addProcessor = sinon.spy(LoggerProvider.prototype, "addLogRecordProcessor")
		const provider = new OpenTelemetryClientProvider(baseConfig)
		await provider.dispose()
		addProcessor.callCount.should.equal(1)
		const processor = addProcessor.firstCall.args[0] as any
		processor._maxQueueSize.should.equal(2048)
		processor._maxExportBatchSize.should.equal(512)
		processor._scheduledDelayMillis.should.equal(5000)
	})
})
