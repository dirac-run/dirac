import { EmptyRequest, String as StringMessage } from "@shared/proto/dirac/common"
import { getErrorMessage } from "@/shared/errors"
import { BrowserSession } from "../../../services/browser/BrowserSession"
import { Controller } from "../index"

/**
 * Relaunch Chrome in debug mode
 * @param controller The controller instance
 * @param request The empty request message
 * @returns The browser relaunch result as a string message
 */
export async function relaunchChromeDebugMode(controller: Controller, _: EmptyRequest): Promise<StringMessage> {
	try {
		const browserSession = new BrowserSession(controller.stateManager)

		// Relaunch Chrome in debug mode
		await browserSession.relaunchChromeDebugMode()

		// The actual result will be sent via the ProtoBus in the BrowserSession.relaunchChromeDebugMode method
		// Here we just return a message as a placeholder
		return { value: "Chrome relaunch initiated" }
	} catch (error) {
		throw new Error(`Error relaunching Chrome: ${getErrorMessage(error)}`)
	}
}
