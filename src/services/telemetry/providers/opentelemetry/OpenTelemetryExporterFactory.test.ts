import * as assert from "assert"
import * as sinon from "sinon"
import { credentials as grpcCredentials } from "@grpc/grpc-js"
import { isLoopbackHost, isTrustedOtlpEndpoint } from "@/shared/services/config/otel-config"
import { createOTLPLogExporter, createOTLPMetricReader, resolveGrpcCredentials } from "./OpenTelemetryExporterFactory"

describe("OpenTelemetry Transport Security & Protocol/Credential Matrix", () => {
	let sandbox: sinon.SinonSandbox

	beforeEach(() => {
		sandbox = sinon.createSandbox()
	})

	afterEach(() => {
		sandbox.restore()
	})

	describe("Loopback and Endpoint Validation", () => {
		it("correctly identifies loopback hostnames", () => {
			assert.strictEqual(isLoopbackHost("localhost"), true)
			assert.strictEqual(isLoopbackHost("127.0.0.1"), true)
			assert.strictEqual(isLoopbackHost("::1"), true)
			assert.strictEqual(isLoopbackHost("[::1]"), true)

			assert.strictEqual(isLoopbackHost("collector.remote.com"), false)
			assert.strictEqual(isLoopbackHost("192.168.1.100"), false)
			assert.strictEqual(isLoopbackHost("10.0.0.1"), false)
			assert.strictEqual(isLoopbackHost("localhost]"), false)
			assert.strictEqual(isLoopbackHost("[localhost"), false)
		})

		it("validates OTLP endpoint schemes per security policy", () => {
			// Remote endpoints require HTTPS
			assert.strictEqual(isTrustedOtlpEndpoint("https://collector.remote.com:4317"), true)
			assert.strictEqual(isTrustedOtlpEndpoint("http://collector.remote.com:4317"), false)
			assert.strictEqual(isTrustedOtlpEndpoint("http://192.168.1.50:4317"), false)

			// Loopback endpoints permit HTTP and HTTPS
			assert.strictEqual(isTrustedOtlpEndpoint("http://localhost:4317"), true)
			assert.strictEqual(isTrustedOtlpEndpoint("http://127.0.0.1:4317"), true)
			assert.strictEqual(isTrustedOtlpEndpoint("http://[::1]:4317"), true)
			assert.strictEqual(isTrustedOtlpEndpoint("https://localhost:4317"), true)

			// Non-HTTP/HTTPS schemes rejected
			assert.strictEqual(isTrustedOtlpEndpoint("ftp://collector.remote.com:4317"), false)
			assert.strictEqual(isTrustedOtlpEndpoint("file:///var/log/otel"), false)
			assert.strictEqual(isTrustedOtlpEndpoint("javascript:void(0)"), false)
			assert.strictEqual(isTrustedOtlpEndpoint("not-a-valid-url"), false)

			// Undefined endpoint is valid (optional endpoint)
			assert.strictEqual(isTrustedOtlpEndpoint(undefined), true)
		})
	})

	describe("resolveGrpcCredentials", () => {
		it("enforces SSL credentials for remote HTTPS endpoint even if insecure is true", () => {
			const sslSpy = sandbox.spy(grpcCredentials, "createSsl")
			const insecureSpy = sandbox.spy(grpcCredentials, "createInsecure")

			const url = new URL("https://collector.remote.com:4317")
			const creds = resolveGrpcCredentials(url, true)

			assert.strictEqual(creds.constructor.name, "SecureChannelCredentialsImpl")
			assert.strictEqual(sslSpy.calledOnce, true)
			assert.strictEqual(insecureSpy.called, false)
		})

		it("selects SSL credentials for remote HTTPS endpoint when insecure is false", () => {
			const sslSpy = sandbox.spy(grpcCredentials, "createSsl")
			const insecureSpy = sandbox.spy(grpcCredentials, "createInsecure")

			const url = new URL("https://collector.remote.com:4317")
			const creds = resolveGrpcCredentials(url, false)

			assert.strictEqual(creds.constructor.name, "SecureChannelCredentialsImpl")
			assert.strictEqual(sslSpy.calledOnce, true)
			assert.strictEqual(insecureSpy.called, false)
		})

		it("enforces SSL credentials for loopback HTTPS endpoint even if insecure is true", () => {
			const sslSpy = sandbox.spy(grpcCredentials, "createSsl")
			const insecureSpy = sandbox.spy(grpcCredentials, "createInsecure")

			const url = new URL("https://localhost:4317")
			const creds = resolveGrpcCredentials(url, true)

			assert.strictEqual(creds.constructor.name, "SecureChannelCredentialsImpl")
			assert.strictEqual(sslSpy.calledOnce, true)
			assert.strictEqual(insecureSpy.called, false)
		})

		it("selects insecure credentials for loopback HTTP endpoint", () => {
			const sslSpy = sandbox.spy(grpcCredentials, "createSsl")
			const insecureSpy = sandbox.spy(grpcCredentials, "createInsecure")

			const url = new URL("http://localhost:4317")
			const creds = resolveGrpcCredentials(url, true)

			assert.strictEqual(creds.constructor.name, "InsecureChannelCredentialsImpl")
			assert.strictEqual(insecureSpy.calledOnce, true)
			assert.strictEqual(sslSpy.called, false)
		})

		it("selects insecure credentials for IPv4 and IPv6 loopback HTTP endpoints", () => {
			const ipv4Url = new URL("http://127.0.0.1:4317")
			const ipv4Creds = resolveGrpcCredentials(ipv4Url, false)
			assert.strictEqual(ipv4Creds.constructor.name, "InsecureChannelCredentialsImpl")

			const ipv6Url = new URL("http://[::1]:4317")
			const ipv6Creds = resolveGrpcCredentials(ipv6Url, false)
			assert.strictEqual(ipv6Creds.constructor.name, "InsecureChannelCredentialsImpl")
		})
	})

	describe("Protocol and Credential Matrix - createOTLPLogExporter", () => {
		const testCases = [
			{
				protocol: "grpc",
				endpoint: "https://collector.remote.com:4317",
				insecure: false,
				expectedSuccess: true,
				expectedCredentialType: "SecureChannelCredentialsImpl",
				desc: "gRPC remote HTTPS with insecure=false uses SSL",
			},
			{
				protocol: "grpc",
				endpoint: "https://collector.remote.com:4317",
				insecure: true,
				expectedSuccess: true,
				expectedCredentialType: "SecureChannelCredentialsImpl",
				desc: "gRPC remote HTTPS with insecure=true enforces SSL",
			},
			{
				protocol: "grpc",
				endpoint: "http://localhost:4317",
				insecure: true,
				expectedSuccess: true,
				expectedCredentialType: "InsecureChannelCredentialsImpl",
				desc: "gRPC loopback HTTP with insecure=true uses insecure credentials",
			},
			{
				protocol: "grpc",
				endpoint: "http://127.0.0.1:4317",
				insecure: false,
				expectedSuccess: true,
				expectedCredentialType: "InsecureChannelCredentialsImpl",
				desc: "gRPC 127.0.0.1 HTTP uses insecure credentials",
			},
			{
				protocol: "grpc",
				endpoint: "https://localhost:4317",
				insecure: false,
				expectedSuccess: true,
				expectedCredentialType: "SecureChannelCredentialsImpl",
				desc: "gRPC localhost HTTPS uses SSL credentials",
			},
			{
				protocol: "grpc",
				endpoint: "http://collector.remote.com:4317",
				insecure: true,
				expectedSuccess: false,
				desc: "gRPC remote HTTP rejected",
			},
			{
				protocol: "grpc",
				endpoint: "ftp://collector.remote.com:4317",
				insecure: false,
				expectedSuccess: false,
				desc: "gRPC untrusted scheme rejected",
			},
			{
				protocol: "http/json",
				endpoint: "https://collector.remote.com:4318",
				insecure: false,
				expectedSuccess: true,
				desc: "http/json remote HTTPS accepted",
			},
			{
				protocol: "http/json",
				endpoint: "http://localhost:4318",
				insecure: true,
				expectedSuccess: true,
				desc: "http/json loopback HTTP accepted",
			},
			{
				protocol: "http/json",
				endpoint: "http://collector.remote.com:4318",
				insecure: false,
				expectedSuccess: false,
				desc: "http/json remote HTTP rejected",
			},
			{
				protocol: "http/protobuf",
				endpoint: "https://collector.remote.com:4318",
				insecure: false,
				expectedSuccess: true,
				desc: "http/protobuf remote HTTPS accepted",
			},
			{
				protocol: "http/protobuf",
				endpoint: "http://localhost:4318",
				insecure: true,
				expectedSuccess: true,
				desc: "http/protobuf loopback HTTP accepted",
			},
			{
				protocol: "http/protobuf",
				endpoint: "http://collector.remote.com:4318",
				insecure: false,
				expectedSuccess: false,
				desc: "http/protobuf remote HTTP rejected",
			},
		]

		for (const tc of testCases) {
			it(tc.desc, () => {
				const sslSpy = sandbox.spy(grpcCredentials, "createSsl")
				const insecureSpy = sandbox.spy(grpcCredentials, "createInsecure")

				const exporter = createOTLPLogExporter(tc.protocol, tc.endpoint, tc.insecure)

				if (!tc.expectedSuccess) {
					assert.strictEqual(exporter, null)
				} else {
					assert.notStrictEqual(exporter, null)
					if (tc.expectedCredentialType === "SecureChannelCredentialsImpl") {
						assert.strictEqual(sslSpy.calledOnce, true)
						assert.strictEqual(insecureSpy.called, false)
					} else if (tc.expectedCredentialType === "InsecureChannelCredentialsImpl") {
						assert.strictEqual(insecureSpy.calledOnce, true)
						assert.strictEqual(sslSpy.called, false)
					}
				}
			})
		}
	})

	describe("Protocol and Credential Matrix - createOTLPMetricReader", () => {
		it("enforces SSL credentials for remote HTTPS endpoint when insecure=true", () => {
			const sslSpy = sandbox.spy(grpcCredentials, "createSsl")
			const insecureSpy = sandbox.spy(grpcCredentials, "createInsecure")

			const reader = createOTLPMetricReader("grpc", "https://collector.remote.com:4317", true, 60000, 30000)

			assert.notStrictEqual(reader, null)
			assert.strictEqual(sslSpy.calledOnce, true)
			assert.strictEqual(insecureSpy.called, false)
		})

		it("selects insecure credentials for loopback HTTP endpoint", () => {
			const sslSpy = sandbox.spy(grpcCredentials, "createSsl")
			const insecureSpy = sandbox.spy(grpcCredentials, "createInsecure")

			const reader = createOTLPMetricReader("grpc", "http://localhost:4317", true, 60000, 30000)

			assert.notStrictEqual(reader, null)
			assert.strictEqual(insecureSpy.calledOnce, true)
			assert.strictEqual(sslSpy.called, false)
		})

		it("rejects remote HTTP metrics endpoint", () => {
			const reader = createOTLPMetricReader("grpc", "http://collector.remote.com:4317", true, 60000, 30000)
			assert.strictEqual(reader, null)
		})

		it("rejects untrusted scheme for metrics endpoint", () => {
			const reader = createOTLPMetricReader("http/json", "ftp://collector.remote.com:4317", false, 60000, 30000)
			assert.strictEqual(reader, null)
		})
	})
})
