import { type ChannelCredentials, credentials as grpcCredentials } from "@grpc/grpc-js"
import { OTLPLogExporter as OTLPLogExporterGRPC } from "@opentelemetry/exporter-logs-otlp-grpc"
import { OTLPLogExporter as OTLPLogExporterHTTP } from "@opentelemetry/exporter-logs-otlp-http"
import { OTLPLogExporter as OTLPLogExporterProto } from "@opentelemetry/exporter-logs-otlp-proto"
import { OTLPMetricExporter as OTLPMetricExporterGRPC } from "@opentelemetry/exporter-metrics-otlp-grpc"
import { OTLPMetricExporter as OTLPMetricExporterHTTP } from "@opentelemetry/exporter-metrics-otlp-http"
import { OTLPMetricExporter as OTLPMetricExporterProto } from "@opentelemetry/exporter-metrics-otlp-proto"
import { ConsoleLogRecordExporter, LogRecordExporter } from "@opentelemetry/sdk-logs"
import { ConsoleMetricExporter, MetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics"
import { Logger } from "@/shared/services/Logger"
import { isLoopbackHost, isTrustedOtlpEndpoint } from "@/shared/services/config/otel-config"
import { wrapLogsExporterWithDiagnostics, wrapMetricsExporterWithDiagnostics } from "./otel-exporter-diagnostics"
import { isDev } from "@shared/config/environment"

/**
 * Check if debug diagnostics are enabled
 */
function isDebugEnabled(): boolean {
	return process.env.TEL_DEBUG_DIAGNOSTICS === "true" || isDev()
}

/**
 * Create a console log exporter
 */
export function createConsoleLogExporter(): ConsoleLogRecordExporter {
	return new ConsoleLogRecordExporter()
}

export function ensurePathSuffix(url: URL, suffix: string): void {
	const pathname = url.pathname
	const normalizedPathname = pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
	url.pathname = normalizedPathname
	if (!normalizedPathname.endsWith(suffix)) {
		url.pathname = `${normalizedPathname}${suffix}`
	}
}

function sanitizeEndpointForLogging(endpoint: string): string {
	try {
		const url = new URL(endpoint)
		return `${url.protocol}//${url.host}${url.pathname}`
	} catch {
		return "[invalid-url]"
	}
}

/**
 * Resolves gRPC credentials according to transport security policy.
 * Only loopback endpoints (localhost, 127.0.0.1, [::1]) may use insecure credentials.
 * Remote endpoints and HTTPS endpoints must always use SSL credentials.
 */
export function resolveGrpcCredentials(url: URL, insecure: boolean): ChannelCredentials {
	if (url.protocol === "https:" || !isLoopbackHost(url.hostname)) {
		if (insecure) {
			Logger.warn(`[OTEL] Insecure transport requested for remote/HTTPS endpoint '${url.host}', enforcing SSL`)
		}
		return grpcCredentials.createSsl()
	}

	return grpcCredentials.createInsecure()
}

/**
 * Create an OTLP log exporter based on protocol
 */
export function createOTLPLogExporter(
	protocol: string,
	endpoint: string,
	insecure: boolean,
	headers?: Record<string, string>,
): LogRecordExporter | null {
	try {
		if (!isTrustedOtlpEndpoint(endpoint)) {
			Logger.warn(`[OTEL] Untrusted OTLP logs endpoint rejected: ${sanitizeEndpointForLogging(endpoint)}`)
			return null
		}

		let exporter: any = null
		const url = new URL(endpoint)

		switch (protocol) {
			case "grpc": {
				exporter = new OTLPLogExporterGRPC({
					url: url.host,
					credentials: resolveGrpcCredentials(url, insecure),
					headers,
				})
				break
			}
			case "http/json": {
				ensurePathSuffix(url, "/v1/logs")
				exporter = new OTLPLogExporterHTTP({ url: url.toString(), headers })
				break
			}
			case "http/protobuf": {
				ensurePathSuffix(url, "/v1/logs")
				exporter = new OTLPLogExporterProto({ url: url.toString(), headers })
				break
			}
			default:
				Logger.warn(`[OTEL] Unknown OTLP protocol for logs: ${protocol}`)
				return null
		}

		// Wrap with diagnostics if debug is enabled
		if (isDebugEnabled()) {
			wrapLogsExporterWithDiagnostics(exporter, protocol, url.toString())
		}

		return exporter
	} catch (error) {
		Logger.error("[OTEL] Error creating OTLP log exporter:", error)
		return null
	}
}

/**
 * Create a console metric reader with exporter
 */
export function createConsoleMetricReader(intervalMs: number, timeoutMs: number): MetricReader {
	const exporter = new ConsoleMetricExporter()
	return new PeriodicExportingMetricReader({
		exporter,
		exportIntervalMillis: intervalMs,
		exportTimeoutMillis: timeoutMs,
	})
}

/**
 * Create an OTLP metric reader with exporter based on protocol
 */
export function createOTLPMetricReader(
	protocol: string,
	endpoint: string,
	insecure: boolean,
	intervalMs: number,
	timeoutMs: number,
	headers?: Record<string, string>,
): MetricReader | null {
	try {
		if (!isTrustedOtlpEndpoint(endpoint)) {
			Logger.warn(`[OTEL] Untrusted OTLP metrics endpoint rejected: ${sanitizeEndpointForLogging(endpoint)}`)
			return null
		}

		let exporter: any = null
		const url = new URL(endpoint)

		switch (protocol) {
			case "grpc": {
				exporter = new OTLPMetricExporterGRPC({
					url: url.host,
					credentials: resolveGrpcCredentials(url, insecure),
					headers,
				})
				break
			}
			case "http/json": {
				ensurePathSuffix(url, "/v1/metrics")
				exporter = new OTLPMetricExporterHTTP({ url: url.toString(), headers })
				break
			}
			case "http/protobuf": {
				ensurePathSuffix(url, "/v1/metrics")
				exporter = new OTLPMetricExporterProto({ url: url.toString(), headers })
				break
			}
			default:
				Logger.warn(`[OTEL] Unknown OTLP protocol for metrics: ${protocol}`)
				return null
		}

		// Wrap with diagnostics if debug is enabled
		if (isDebugEnabled()) {
			wrapMetricsExporterWithDiagnostics(exporter, protocol, url.toString())
		}

		return new PeriodicExportingMetricReader({
			exporter,
			exportIntervalMillis: intervalMs,
			exportTimeoutMillis: timeoutMs,
		})
	} catch (error) {
		Logger.error("[OTEL] Error creating OTLP metric reader:", error)
		return null
	}
}
