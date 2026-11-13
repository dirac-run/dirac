import type { CommandApprovalChoice } from "@shared/ExtensionMessage"

/** A host-bound offer: callers can select an offered ID, never supply a capability mask. */
export interface TaskCommandCapabilityApproval {
	readonly choices: readonly CommandApprovalChoice[]
	approve(choiceId: string): Promise<boolean>
}

/** Live root-owned authority shared by the root and all of its existing and future children. */
export interface TaskCommandCapabilitiesCapability {
	ready(): Promise<void>
	current(): number
	offerApproval(required: number): Promise<TaskCommandCapabilityApproval>
}
