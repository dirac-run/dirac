import { UrlContentFetcher } from "@services/browser/UrlContentFetcher"
import { telemetryService } from "@services/telemetry"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { ShowMessageType } from "@/shared/proto/host/window"

export function findUrlMention(mentions: Iterable<string>): string | undefined {
	return Array.from(mentions).find((m) => m.startsWith("http"))
}

export async function tryLaunchBrowser(url: string, fetcher: UrlContentFetcher): Promise<Error | undefined> {
	try {
		await fetcher.launchBrowser()
		return undefined
	} catch (error) {
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Error fetching content for ${url}: ${error.message}`,
		})
		return error
	}
}

export async function tryCloseBrowser(fetcher: UrlContentFetcher): Promise<void> {
	try {
		await fetcher.closeBrowser()
	} catch (error) {
		Logger.error(`Error closing browser: ${error.message}`)
	}
}

export async function expandUrlMention(
	parsedText: string,
	mention: string,
	fetcher: UrlContentFetcher,
	launchBrowserError?: Error,
): Promise<string> {
	const result = await resolveUrlContent(mention, fetcher, launchBrowserError)
	return `${parsedText}\n\n<url_content url="${mention}">\n${result}\n</url_content>`
}

async function resolveUrlContent(mention: string, fetcher: UrlContentFetcher, launchBrowserError?: Error): Promise<string> {
	if (launchBrowserError) {
		telemetryService.captureMentionFailed("url", "network_error", launchBrowserError.message || "")
		return `Error fetching content: ${launchBrowserError.message}`
	}
	try {
		const markdown = await fetcher.urlToMarkdown(mention)
		telemetryService.captureMentionUsed("url", markdown.length)
		return markdown
	} catch (error) {
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Error fetching content for ${mention}: ${error.message}`,
		})
		telemetryService.captureMentionFailed("url", "network_error", error.message)
		return `Error fetching content: ${error.message}`
	}
}
