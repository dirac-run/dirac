import * as crypto from "node:crypto"
import * as fs from "fs/promises"
import * as path from "path"

export interface ToolPromotion {
	finalDir: string
	backupDir?: string
}

export async function createToolStagingDirectory(finalDir: string): Promise<string> {
	const buildsDir = path.join(path.dirname(path.dirname(finalDir)), "tool-builds")
	await fs.mkdir(buildsDir, { recursive: true })
	return fs.mkdtemp(path.join(buildsDir, `${path.basename(finalDir)}-`))
}

export async function discardStagedTool(stagingDir: string): Promise<void> {
	await fs.rm(stagingDir, { recursive: true, force: true })
}

export async function promoteStagedTool(stagingDir: string, finalDir: string): Promise<ToolPromotion> {
	const buildsDir = path.join(path.dirname(path.dirname(finalDir)), "tool-builds")
	await fs.mkdir(buildsDir, { recursive: true })
	const backupDir = await pathExists(finalDir)
		? path.join(buildsDir, `${path.basename(finalDir)}-backup-${crypto.randomUUID()}`)
		: undefined

	if (backupDir) {
		await fs.rename(finalDir, backupDir)
	}

	try {
		await fs.rename(stagingDir, finalDir)
		return { finalDir, backupDir }
	} catch (error) {
		if (backupDir) {
			await fs.rename(backupDir, finalDir)
		}
		throw error
	}
}

export async function rollbackToolPromotion(promotion: ToolPromotion): Promise<void> {
	await fs.rm(promotion.finalDir, { recursive: true, force: true })
	if (promotion.backupDir) {
		await fs.rename(promotion.backupDir, promotion.finalDir)
	}
}

export async function commitToolPromotion(promotion: ToolPromotion): Promise<void> {
	if (promotion.backupDir) {
		await fs.rm(promotion.backupDir, { recursive: true, force: true })
	}
}

async function pathExists(targetPath: string): Promise<boolean> {
	try {
		await fs.access(targetPath)
		return true
	} catch {
		return false
	}
}
