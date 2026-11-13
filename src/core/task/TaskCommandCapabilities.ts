import type { CommandApprovalChoice } from "@shared/ExtensionMessage"
import type { TaskCommandCapabilitiesCapability, TaskCommandCapabilityApproval } from "./tools/interfaces/TaskCommandCapabilities"
import {
	COMMAND_CAPABILITY_CATEGORIES,
	DEFAULT_COMMAND_CAPABILITIES,
	getMissingCommandCapabilities,
	mergeCommandCapabilities,
} from "./tools/utils/CommandSafetyChecker"

export interface TaskCommandCapabilitySnapshot {
	version: 1
	capabilities: number
}

export function isTaskCommandCapabilitySnapshot(value: unknown): value is TaskCommandCapabilitySnapshot {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const snapshot = value as Record<string, unknown>
	if (Object.keys(snapshot).length !== 2 || snapshot.version !== 1 || !Number.isInteger(snapshot.capabilities)) return false
	const capabilities = snapshot.capabilities as number
	return capabilities >= 0 && capabilities < 2 ** 30 && COMMAND_CAPABILITY_CATEGORIES.every((_, index) =>
		[0, 1, 3, 7].includes((capabilities >>> (index * 3)) & 7),
	)
}

/** Only durable, explicitly selected category grants become reusable authority. */
export class TaskCommandCapabilities implements TaskCommandCapabilitiesCapability {
	private capabilities = DEFAULT_COMMAND_CAPABILITIES
	private initialization?: Promise<void>
	private pendingCommit: Promise<void> = Promise.resolve()
	private persistenceRetired = false

	constructor(
		private readonly load: () => Promise<unknown>,
		private readonly persist: (snapshot: TaskCommandCapabilitySnapshot) => Promise<void>,
	) { }

	ready(): Promise<void> {
		this.initialization ??= this.restore()
		return this.initialization
	}

	current(): number {
		return this.capabilities
	}

	/** Only the owning Task retires this writer, before releasing its root storage lock. */
	retirePersistence(): Promise<void> {
		this.persistenceRetired = true
		return this.pendingCommit
	}

	async offerApproval(required: number): Promise<TaskCommandCapabilityApproval> {
		await this.ready()
		if (this.persistenceRetired) throw new Error("Task command capability persistence is retired")
		const deficits = getMissingCommandCapabilities(required, this.capabilities)
		const offered = [...(deficits ?? [])].sort((left, right) => right.access - left.access || left.index - right.index).slice(0, 2)
		const grants = new Map(offered.map((deficit) => [`allow-${deficit.category}-${deficit.access}`, deficit.access << (deficit.index * 3)]))
		const accessLabels = { 1: "use", 3: "read", 7: "mutate" } as const
		const choices: CommandApprovalChoice[] = [
			{ id: "approve", label: "Approve this command" },
			...offered.map((deficit) => ({
				id: `allow-${deficit.category}-${deficit.access}`,
				label: `Approve + allow ${deficit.category}/${accessLabels[deficit.access]} for this task`,
				category: deficit.category,
				access: accessLabels[deficit.access],
			})),
			{ id: "reject", label: "Reject" },
		]
		let resolved = false
		return {
			choices,
			approve: async (choiceId) => {
				if (resolved) throw new Error("Command approval choice was already resolved")
				if (choiceId !== "approve" && choiceId !== "reject" && !grants.has(choiceId)) {
					throw new Error("Command approval choice was not offered by the host")
				}
				resolved = true
				if (choiceId === "reject") return false
				const grant = grants.get(choiceId)
				if (grant !== undefined) await this.commit(grant)
				return true
			},
		}
	}

	private async restore(): Promise<void> {
		const snapshot = await this.load()
		if (snapshot === undefined) return
		if (!isTaskCommandCapabilitySnapshot(snapshot)) throw new Error("Invalid task command capability snapshot")
		this.capabilities = mergeCommandCapabilities(DEFAULT_COMMAND_CAPABILITIES, snapshot.capabilities)
	}

	private commit(grant: number): Promise<void> {
		if (this.persistenceRetired) throw new Error("Task command capability persistence is retired")
		const commit = async () => {
			const capabilities = mergeCommandCapabilities(this.capabilities, grant)
			await this.persist({ version: 1, capabilities })
			this.capabilities = capabilities
		}
		const result = this.pendingCommit.then(commit, commit)
		this.pendingCommit = result
		return result
	}
}
