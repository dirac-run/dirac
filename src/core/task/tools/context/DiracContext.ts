import * as fs from "fs/promises"
import * as path from "path"
import * as os from "os"
import { Logger } from "@shared/services/Logger"

import { IDiracContext } from "../interfaces/IDiracContext"
import { StateManager } from "../../../storage/StateManager"

export class DiracContext implements IDiracContext {
	private taskData: Record<string, any> = {}
	private taskPath: string

	constructor(
		private taskId: string,
		private stateManager: StateManager
	) {
		this.taskPath = path.join(os.homedir(), ".dirac", "data", "tasks", taskId, "tool_context.json")
	}

	public async load(): Promise<void> {
		this.taskData = await this.readJson(this.taskPath)
	}

	public async save(): Promise<void> {
		if (this.taskId.toLowerCase().includes("test")) {
			return
		}
		await this.writeJson(this.taskPath, this.taskData)
		await this.stateManager.flushPendingState()
	}

	private async readJson(filePath: string): Promise<Record<string, any>> {
		try {
			const content = await fs.readFile(filePath, "utf-8")
			return JSON.parse(content)
		} catch (error) {
			return {}
		}
	}

	private async writeJson(filePath: string, data: Record<string, any>): Promise<void> {
		try {
			await fs.mkdir(path.dirname(filePath), { recursive: true })
			await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
		} catch (error) {
			Logger.error(`Failed to write context to ${filePath}:`, error)
		}
	}

	public task = {
		get: <T>(key: string): T | undefined => this.taskData[key],
		set: <T>(key: string, value: T): void => {
			this.taskData[key] = value
		},
	}

	public workspace = {
		get: <T>(key: string): T | undefined => this.stateManager.getWorkspaceStateKey(key as any) as T,
		set: <T>(key: string, value: T): void => {
			this.stateManager.setWorkspaceState(key as any, value as any)
		},
	}

	public async resetTaskContext(): Promise<void> {
		this.taskData = {}
		await this.save()
	}


	public global = {
		get: <T>(key: string): T | undefined => this.stateManager.getGlobalStateKey(key as any) as T,
		set: <T>(key: string, value: T): void => {
			this.stateManager.setGlobalState(key as any, value as any)
		},
	}
}
