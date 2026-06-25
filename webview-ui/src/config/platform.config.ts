import platformConfigs from "./platform-configs.json"

export interface PlatformConfig {
	type: PlatformType
	messageEncoding: MessageEncoding
	showNavbar: boolean
	postMessage: PostMessageFunction
	encodeMessage: MessageEncoder
	decodeMessage: MessageDecoder
	togglePlanActKeys: string
	supportsTerminalMentions: boolean
}

export enum PlatformType {
	VSCODE = 0,
	STANDALONE = 1,
}

function stringToPlatformType(name: string): PlatformType {
	const mapping: Record<string, PlatformType> = {
		vscode: PlatformType.VSCODE,
		standalone: PlatformType.STANDALONE,
	}
	if (name in mapping) {
		return mapping[name]
	}
	console.error("Unknown platform:", name)
	// Default to VSCode for unknown types
	return PlatformType.VSCODE
}

// Internal type for JSON structure (not exported)
type PlatformConfigJson = {
	messageEncoding: "none" | "json"
	showNavbar: boolean
	postMessageHandler: "vscode" | "standalone"
	togglePlanActKeys: string
	supportsTerminalMentions: boolean
}

type PlatformConfigs = Record<string, PlatformConfigJson>

// Runtime configuration injected into the webview HTML by the host (see
// DiracWebviewProvider.getHtmlContent). This lets host-specific user settings
// (e.g. a custom Plan/Act toggle shortcut from VSCode `dirac.*` settings)
// override the compile-time defaults baked into platform-configs.json without
// going through the gRPC state pipeline.
export interface DiracRuntimeConfig {
	planActToggleShortcut?: string
}

// Global type declarations for postMessage and vscode API
declare global {
	interface Window {
		// This is the post message handler injected by JetBrains.
		// !! Do not change the name of the handler without updating it on
		// the JetBrains side as well. !!
		standalonePostMessage?: (message: string) => void
		// Host-injected runtime config. Optional: absent in builds/hosts that
		// do not inject it, in which case compile-time defaults are used.
		__DIRAC_CONFIG__?: DiracRuntimeConfig
	}
	function acquireVsCodeApi(): any
}

/**
 * Resolve the effective Plan/Act toggle shortcut.
 *
 * Pure function so the resolution rule (user override wins, otherwise the
 * platform default) is independently testable. A blank/whitespace-only or
 * non-string override is treated as "unset" and falls back to the default.
 *
 * @param override - The user-provided shortcut (e.g. from a VSCode setting), if any.
 * @param fallback - The platform default shortcut.
 */
export function resolveTogglePlanActKeys(override: string | undefined, fallback: string): string {
	if (typeof override === "string" && override.trim().length > 0) {
		return override.trim()
	}
	return fallback
}

/**
 * Reads the host-injected runtime override for the Plan/Act toggle shortcut, if present.
 */
function getInjectedTogglePlanActKeys(): string | undefined {
	return typeof window !== "undefined" ? window.__DIRAC_CONFIG__?.planActToggleShortcut : undefined
}

// Initialize the vscode API if available
const vsCodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null

// Implementations for post message handling
const postMessageStrategies: Record<string, PostMessageFunction> = {
	vscode: (message: any) => {
		if (vsCodeApi) {
			vsCodeApi.postMessage(message)
		} else {
			console.log("postMessage fallback: ", message)
		}
	},
	standalone: (message: any) => {
		if (!window.standalonePostMessage) {
			console.error("Standalone postMessage not found.")
			return
		}
		const json = JSON.stringify(message)
		console.log("Standalone postMessage: " + json.slice(0, 200))
		window.standalonePostMessage(json)
	},
}

// Implementations for message encoding
const messageEncoders: Record<string, MessageEncoder> = {
	none: <T>(message: T, _encoder: (_: T) => unknown) => message,
	json: <T>(message: T, encoder: (_: T) => unknown) => encoder(message),
}

// Implementations for message decoding
const messageDecoders: Record<string, MessageDecoder> = {
	none: <T>(message: any, _decoder: (_: { [key: string]: any }) => T) => message,
	json: <T>(message: any, decoder: (_: { [key: string]: any }) => T) => decoder(message),
}

// Local declaration of the platform compile-time constant
declare const __PLATFORM__: string

// Get the specific platform config at compile time
const configs = platformConfigs as PlatformConfigs
const selectedConfig = configs[__PLATFORM__]
console.log("[PLATFORM_CONFIG] Build platform:", __PLATFORM__)

// Build the platform config with injected functions
// Callers should use this in the situations where the react component is not available.
export const PLATFORM_CONFIG: PlatformConfig = {
	type: stringToPlatformType(__PLATFORM__),
	messageEncoding: selectedConfig.messageEncoding,
	showNavbar: selectedConfig.showNavbar,
	postMessage: postMessageStrategies[selectedConfig.postMessageHandler],
	encodeMessage: messageEncoders[selectedConfig.messageEncoding],
	decodeMessage: messageDecoders[selectedConfig.messageEncoding],
	// User override (host-injected) wins over the platform default. The default
	// itself lives in platform-configs.json and is chosen to avoid clashing with
	// VSCode's Cmd/Ctrl+Shift+A "Agents" command (see issue #100).
	togglePlanActKeys: resolveTogglePlanActKeys(getInjectedTogglePlanActKeys(), selectedConfig.togglePlanActKeys),
	supportsTerminalMentions: selectedConfig.supportsTerminalMentions,
}

type MessageEncoding = "none" | "json"

// Function types for platform-specific behaviors
type PostMessageFunction = (message: any) => void
type MessageEncoder = <T>(message: T, encoder: (_: T) => unknown) => any
type MessageDecoder = <T>(message: any, decoder: (_: { [key: string]: any }) => T) => T
