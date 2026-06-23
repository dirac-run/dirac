import * as fs from "fs/promises"
import * as iconv from "iconv-lite"
import { createDirectoriesForFile } from "@utils/fs"
import { detectEncoding } from "../misc/extract-text"
import { sanitizeNotebookForLLM } from "../misc/notebook-utils"

export class FileOperationManager {
	private createdDirs: string[] = []
	originalContent: string | undefined
	fileEncoding: string

	constructor(
		private absolutePath: string,
		private editType: "create" | "modify" | "delete",
	) {
		this.fileEncoding = "utf8"
	}

	async setup(): Promise<void> {
		if (this.editType === "modify") {
			const fileBuffer = await fs.readFile(this.absolutePath)
			this.fileEncoding = await detectEncoding(fileBuffer)
			this.originalContent = iconv.decode(fileBuffer, this.fileEncoding)
		} else {
			this.originalContent = ""
			this.fileEncoding = "utf8"
		}

		this.createdDirs = await createDirectoriesForFile(this.absolutePath)

		if (this.editType !== "modify") {
			await fs.writeFile(this.absolutePath, "")
		}
	}

	async ensureFileExists(): Promise<void> {
		if (this.editType !== "modify") {
			const exists = await fs.stat(this.absolutePath).then(() => true).catch(() => false)
			if (!exists) {
				await fs.writeFile(this.absolutePath, "")
			}
		}
	}

	async writeFile(content: string): Promise<void> {
		const buffer = Buffer.from(content, this.fileEncoding as BufferEncoding)
		await fs.writeFile(this.absolutePath, buffer)
	}

	async readFile(): Promise<string> {
		const fileBuffer = await fs.readFile(this.absolutePath)
		return iconv.decode(fileBuffer, this.fileEncoding as BufferEncoding)
	}

	async deleteFile(): Promise<void> {
		await fs.rm(this.absolutePath, { force: true })
	}

	async deleteCreatedDirs(): Promise<string[]> {
		const deleted: string[] = []
		for (let i = this.createdDirs.length - 1; i >= 0; i--) {
			try {
				await fs.rmdir(this.createdDirs[i])
				deleted.push(this.createdDirs[i])
			} catch {
				// Directory may not exist or be non-empty, skip
			}
		}
		this.createdDirs = []
		return deleted
	}

	getCreatedDirs(): string[] {
		return [...this.createdDirs]
	}

	getOriginalContentForLLM(isNotebookFile: boolean): string | undefined {
		if (this.originalContent === undefined) return undefined
		return isNotebookFile ? sanitizeNotebookForLLM(this.originalContent, true) : this.originalContent
	}

	reset(): void {
		this.createdDirs = []
		this.originalContent = undefined
		this.fileEncoding = "utf8"
	}
}
