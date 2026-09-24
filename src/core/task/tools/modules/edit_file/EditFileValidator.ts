import { z } from "zod"
import { getErrorMessage } from "@/shared/errors"
import { safeParseJson } from "@/shared/safe-json-parse"
import type { IToolEnvironment } from "../../interfaces/IToolEnvironment"
import type { Edit, FileEdit } from "./types"

// Elements stay unvalidated here: EditExecutor.validateEdit checks each edit separately so
// one malformed edit fails alone instead of rejecting the whole batch.
const editsSchema = z.array(z.unknown()).nonempty()

// On the wire `edits` may be a JSON string or an already-parsed array.
const fileEditsSchema = z
	.array(
		z.object({
			path: z.string().refine((s) => s.trim().length > 0, { message: "must be a non-empty string" }),
			edits: z.union([z.string(), editsSchema]),
		}),
	)
	.nonempty()

/** Validates and normalizes the file-level shape while preserving per-edit partial success. */
export class EditFileValidator {
	validateFiles(args: { files: string | FileEdit[] }, env: IToolEnvironment): FileEdit[] | string {
		let files: unknown = args?.files
		if (typeof files === "string") {
			try {
				files = safeParseJson(z.unknown(), files, "edit_file 'files' parameter")
			} catch (error) {
				return this.fail(env, `The 'files' parameter contains invalid JSON: ${getErrorMessage(error)}`)
			}
		}

		const parsed = fileEditsSchema.safeParse(files)
		if (!parsed.success) {
			const issue = parsed.error.issues[0]
			const at = issue && issue.path.length > 0 ? `files[${issue.path.join(".")}]` : "The 'files' parameter"
			return this.fail(env, `${at} ${issue?.message ?? "is invalid"}.`)
		}

		const normalized: FileEdit[] = []
		for (const [fileIndex, file] of parsed.data.entries()) {
			let edits = file.edits
			if (typeof edits === "string") {
				try {
					edits = safeParseJson(editsSchema, edits, `files[${fileIndex}].edits`)
				} catch (error) {
					return this.fail(env, `files[${fileIndex}].edits must be a valid JSON array of edit objects. ${getErrorMessage(error)}`)
				}
			}
			normalized.push({ path: file.path, edits: edits as Edit[] })
		}
		return normalized
	}

	private fail(env: IToolEnvironment, message: string): string {
		env.orchestration.setTaskState("consecutiveMistakeCount", env.config.taskState.consecutiveMistakeCount + 1)
		return message
	}
}
