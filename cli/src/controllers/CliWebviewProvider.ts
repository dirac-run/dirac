/**
 * CLI-specific WebviewProvider implementation
 * Instead of rendering to a webview, this outputs to the terminal
 */

import { DiracWebviewProvider } from "@/core/webview"
import type { DiracExtensionContext } from "@/shared/dirac"

export class CliWebviewProvider extends DiracWebviewProvider {
	constructor(context: DiracExtensionContext) {
		super(context)
	}

	override getWebviewUrl(path: string): string {
		// CLI doesn't have webview URLs
		return `file://${path}`
	}

	override getCspSource(): string {
		return "'self'"
	}

	override isVisible(): boolean {
		// CLI is always "visible"
		return true
	}
}
