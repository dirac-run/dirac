import type { IDiracContext } from "../interfaces/IDiracContext"

/** Keeps a subagent's tool-read history local while sharing workspace state and source anchors. */
export class SubagentToolContext implements IDiracContext {
	private readonly taskData = new Map<string, unknown>()

	constructor(private readonly parent: IDiracContext) {}

	public readonly task: IDiracContext["task"] = {
		get: async <T>(key: string): Promise<T | undefined> =>
			structuredClone(this.taskData.get(key)) as T | undefined,
		getEntry: async <T>(key: string, entryKey: string): Promise<T | undefined> => {
			const entries = this.taskData.get(key) as Record<string, T> | undefined
			return structuredClone(entries?.[entryKey])
		},
		getEntries: async <T>(key: string, entryKeys: readonly string[]): Promise<Record<string, T>> => {
			const entries = (this.taskData.get(key) ?? {}) as Record<string, T>
			const selected: Record<string, T> = {}
			for (const entryKey of entryKeys) {
				if (entries[entryKey] !== undefined) selected[entryKey] = structuredClone(entries[entryKey])
			}
			return selected
		},
		set: async <T>(key: string, value: T): Promise<void> => {
			this.taskData.set(key, structuredClone(value))
		},
		update: async <T>(key: string, updater: (value: T | undefined) => T): Promise<void> => {
			const current = structuredClone(this.taskData.get(key)) as T | undefined
			this.taskData.set(key, structuredClone(updater(current)))
		},
		updateEntries: async <T>(key: string, updates: Record<string, T>, deletions: readonly string[] = []): Promise<void> => {
			const entries = (this.taskData.get(key) ?? {}) as Record<string, T>
			Object.assign(entries, structuredClone(updates))
			for (const entryKey of deletions) delete entries[entryKey]
			this.taskData.set(key, entries)
		},
	}

	public get workspace(): IDiracContext["workspace"] {
		return this.parent.workspace
	}

	public get global(): IDiracContext["global"] {
		return this.parent.global
	}

	public async resetTaskContext(): Promise<void> {
		this.taskData.clear()
	}

	public load(): Promise<void> {
		return this.parent.load()
	}

	public ensureAnchorState(): Promise<void> {
		return this.parent.ensureAnchorState()
	}

	public markAnchorStateDirty(absolutePath?: string): void {
		this.parent.markAnchorStateDirty(absolutePath)
	}

	public save(): Promise<void> {
		return this.parent.save()
	}
}
