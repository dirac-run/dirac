import { readRemoteConfigFromCache } from "@core/storage/disk"
import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/dirac/common"
import { REMOTE_URI_SCHEME } from "@shared/remote-config/constants"
import { writeFile } from "@utils/fs"
import * as os from "os"
import * as path from "path"
import { Controller } from ".."

/**
 * Opens a file in the editor
 * @param controller The controller instance
 * @param request The request message containing the file path in the 'value' field.
 *                Supports special URI format for remote rules/workflows:
 *                - remote://rule/{ruleName}
 *                - remote://workflow/{workflowName}
 * @returns Empty response
 */
export async function openFile(controller: Controller, request: StringRequest): Promise<Empty> {
	if (request.value) {
		// Check for remote:// prefix for remote rules/workflows
		if (request.value.startsWith(REMOTE_URI_SCHEME)) {
			await openRemoteFile(controller, request.value)
		} else {
			await openFileIntegration(request.value)
		}
	}
	return Empty.create()
}

/**
 * Opens a remote rule or workflow file by creating a temp file with its contents
 * @param controller The controller instance
 * @param uri The remote URI in format: remote://rule/{name} or remote://workflow/{name}
 */
async function openRemoteFile(controller: Controller, uri: string): Promise<void> {
	// Parse: remote://rule/{name} or remote://workflow/{name}
	const match = uri.match(/^remote:\/\/(rule|workflow)\/(.+)$/)
	if (!match) {
		throw new Error(`Invalid remote file URI: ${uri}`)
	}

	const [, type, name] = match

	// Look up the item from cached remote config via controller's state manager
	const organizationId = controller.stateManager.getSecretKey("dirac:diracAccountId")
	if (!organizationId) {
		throw new Error(`Not signed in to a Dirac organization; cannot open remote ${type}: ${name}`)
	}

	const config = await readRemoteConfigFromCache(organizationId)
	const items = type === "rule" ? config?.globalRules : config?.globalWorkflows
	const item = items?.find((r) => r.name === name)

	if (!item?.contents) {
		throw new Error(`Remote ${type} not found: ${name}`)
	}

	// Create temp file with read-only header comment (only after validation)
	const typeLabel = type === "rule" ? "rule" : "workflow"
	const header = `# ⚠️ READ-ONLY: This ${typeLabel} is managed by your organization.\n# Changes made here will not be saved.\n\n`
	const content = header + item.contents

	// Sanitize the name for use in filename (replace invalid characters)
	const sanitizedName = name.replace(/[<>:"/\\|?*]/g, "_")
	const tempPath = path.join(os.tmpdir(), `dirac-remote-${type}-${sanitizedName}.md`)

	await writeFile(tempPath, content)
	await openFileIntegration(tempPath)
}
