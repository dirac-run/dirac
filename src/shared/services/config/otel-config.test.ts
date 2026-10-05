import { describe, it } from "mocha"
import "should"
import { getValidRuntimeOpenTelemetryConfig } from "./otel-config"

// Exercises the env-parse path through the exported config getter; a valid
// config requires telemetry enabled plus at least one exporter.
describe("getValidRuntimeOpenTelemetryConfig numeric settings", () => {
	const originalEnv = { ...process.env }

	beforeEach(() => {
		process.env.CLINE_OTEL_TELEMETRY_ENABLED = "true"
		process.env.CLINE_OTEL_METRICS_EXPORTER = "console"
	})

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith("CLINE_OTEL_")) delete process.env[key]
		}
		Object.assign(process.env, originalEnv)
	})

	it("returns undefined for absent numeric env values", () => {
		const config = getValidRuntimeOpenTelemetryConfig()
		;(config?.metricExportInterval === undefined).should.be.true()
		;(config?.logBatchSize === undefined).should.be.true()
		;(config?.logBatchTimeout === undefined).should.be.true()
		;(config?.logMaxQueueSize === undefined).should.be.true()
	})

	it("returns undefined instead of NaN for malformed numeric env values", () => {
		process.env.CLINE_OTEL_METRIC_EXPORT_INTERVAL = "abc"
		process.env.CLINE_OTEL_LOG_BATCH_SIZE = "soon"
		process.env.CLINE_OTEL_LOG_BATCH_TIMEOUT = "not-a-number"
		process.env.CLINE_OTEL_LOG_MAX_QUEUE_SIZE = "NaN"
		const config = getValidRuntimeOpenTelemetryConfig()
		;(config?.metricExportInterval === undefined).should.be.true()
		;(config?.logBatchSize === undefined).should.be.true()
		;(config?.logBatchTimeout === undefined).should.be.true()
		;(config?.logMaxQueueSize === undefined).should.be.true()
	})

	it("parses valid numeric env values", () => {
		process.env.CLINE_OTEL_METRIC_EXPORT_INTERVAL = "30000"
		process.env.CLINE_OTEL_LOG_BATCH_SIZE = "256"
		process.env.CLINE_OTEL_LOG_BATCH_TIMEOUT = "2500"
		process.env.CLINE_OTEL_LOG_MAX_QUEUE_SIZE = "1024"
		const config = getValidRuntimeOpenTelemetryConfig()
		config!.metricExportInterval!.should.equal(30_000)
		config!.logBatchSize!.should.equal(256)
		config!.logBatchTimeout!.should.equal(2_500)
		config!.logMaxQueueSize!.should.equal(1_024)
	})

	it("clamps the log batching settings to >= 1", () => {
		process.env.CLINE_OTEL_LOG_BATCH_SIZE = "0"
		process.env.CLINE_OTEL_LOG_BATCH_TIMEOUT = "-5"
		process.env.CLINE_OTEL_LOG_MAX_QUEUE_SIZE = "0"
		const config = getValidRuntimeOpenTelemetryConfig()
		config!.logBatchSize!.should.equal(1)
		config!.logBatchTimeout!.should.equal(1)
		config!.logMaxQueueSize!.should.equal(1)
	})
})
