import path from "node:path"
import { pathToFileURL } from "node:url"
import { EmptyRequest, StringRequest } from "@shared/proto/dirac/common"
import { HostProvider } from "@/hosts/host-provider"
import { getErrorMessage } from "@/shared/errors"
import { Logger } from "@/shared/services/Logger"
import { openBrowser } from "./open-browser"

/**
 * Writes text to the system clipboard
 * @param text The text to write to the clipboard
 * @returns Promise that resolves when the operation is complete
 * @throws Error if the operation fails
 */
export async function writeTextToClipboard(text: string): Promise<void> {
	try {
		await HostProvider.env.clipboardWriteText(StringRequest.create({ value: text }))
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		throw new Error(`Failed to write to clipboard: ${errorMessage}`)
	}
}

/**
 * Reads text from the system clipboard
 * @returns Promise that resolves to the clipboard text
 * @throws Error if the operation fails
 */
export async function readTextFromClipboard(): Promise<string> {
	try {
		const response = await HostProvider.env.clipboardReadText(EmptyRequest.create({}))
		return response.value
	} catch (error) {
		const errorMessage = getErrorMessage(error)
		throw new Error(`Failed to read from clipboard: ${errorMessage}`)
	}
}

/**
 * Opens an external URL or local file in the default handler or browser.
 * Uses the host bridge RPC first (VS Code's openExternal which handles remote environments).
 * Falls back to the `open` npm package if the host doesn't implement the RPC (e.g., JetBrains).
 * @param url The URL or file path to open
 * @returns Promise that resolves when the operation is complete
 */
const ALLOWED_OPEN_SCHEMES = ["https:", "http:", "file:"]

export function normalizeOpenTarget(target: string): string {
	if (path.isAbsolute(target) || /^[a-zA-Z]:[/\\]/.test(target) || target.startsWith("\\\\")) {
		return pathToFileURL(target).href
	}
	return target
}

export async function openExternal(url: string): Promise<void> {
	const targetUrl = normalizeOpenTarget(url)
	let parsed: URL
	try {
		parsed = new URL(targetUrl)
	} catch {
		throw new Error(`Invalid URL: ${url}`)
	}
	if (!ALLOWED_OPEN_SCHEMES.includes(parsed.protocol)) {
		throw new Error(`Blocked URL with disallowed scheme '${parsed.protocol}'`)
	}

	Logger.log("Opening browser:", targetUrl)
	try {
		await HostProvider.env.openExternal(StringRequest.create({ value: targetUrl }))
		return
	} catch (error) {
		// Fallback for hosts that don't implement openExternal (e.g., JetBrains plugin).
		Logger.warn(`Host openExternal RPC failed, falling back to 'open' package: ${error}`)
	}

	await openBrowser(targetUrl)
}
