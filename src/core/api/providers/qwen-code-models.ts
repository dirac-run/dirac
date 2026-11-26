import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs"
import { z } from "zod"
import { type ModelInfo, qwenCodeModels } from "@shared/api"
import { getQwenCachedCredentialPath } from "@/utils/qwenCodeCredentialPath"

const MAX_CATALOG_FILE_BYTES = 1024 * 1024
const modelIdSchema = z.string().trim().min(1).max(256).regex(/^[^,\p{C}\p{Zl}\p{Zp}]+$/u)
	.refine((id) => !["__proto__", "constructor", "prototype"].includes(id))
const metadataSchema = z.object({
	id: modelIdSchema,
	modalities: z.object({ image: z.boolean().optional() }).optional().catch(undefined),
	contextWindowSize: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
})
const catalogSchema = z.object({
	baseUrl: z.literal("https://auth.qwen.ai"),
	clientId: z.literal("qwen-code-cli"),
	models: z.array(modelIdSchema).min(1).optional(),
	modelMetadata: z.array(metadataSchema).optional().catch(undefined),
})

/** Extract only validated public catalog fields; never return credentials or parser diagnostics. */
export function parseQwenCodeModels(value: unknown): Record<string, ModelInfo> {
	const catalog = catalogSchema.safeParse(value)
	if (!catalog.success) throw new Error("Qwen Subscription cached model catalog is invalid. Sign in again with Qwen Code.")
	// Older valid caches may not contain discovery yet; a custom account ID remains selectable.
	if (!catalog.data.models) return { ...qwenCodeModels }
	const metadata = new Map(catalog.data.modelMetadata?.map((entry) => [entry.id, entry]))
	return Object.fromEntries(catalog.data.models.map((id) => {
		const entry = metadata.get(id)
		const info: ModelInfo = {
			supportsPromptCache: false,
			description: "Model from the cached Qwen Subscription account catalog. Subscription limits apply.",
		}
		if (entry?.contextWindowSize !== undefined) info.contextWindow = entry.contextWindowSize
		if (entry?.modalities?.image !== undefined) info.supportsImages = entry.modalities.image
		return [id, info]
	}))
}

/** Read Qwen Code's account catalog locally, without refreshing or exposing any credentials. */
export function getCachedQwenCodeModels(credentialPath?: string): Record<string, ModelInfo> {
	let fd: number
	try {
		fd = openSync(getQwenCachedCredentialPath(credentialPath), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...qwenCodeModels }
		throw new Error("Unable to read the Qwen Subscription model catalog. Check the credentials file.")
	}
	try {
		const stat = fstatSync(fd)
		if (!stat.isFile() || stat.size > MAX_CATALOG_FILE_BYTES) throw new Error("Invalid catalog file")
		const buffer = Buffer.alloc(stat.size + 1)
		let bytesRead = 0
		while (bytesRead < buffer.length) {
			const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null)
			if (!count) break
			bytesRead += count
		}
		if (bytesRead > stat.size) throw new Error("Catalog changed during read")
		const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))
		return parseQwenCodeModels(value)
	} catch {
		throw new Error("Qwen Subscription cached model catalog is invalid or unreadable. Sign in again with Qwen Code.")
	} finally {
		closeSync(fd)
	}
}
