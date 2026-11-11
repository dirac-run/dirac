import { resolveSandboxProfile, validateSandboxSettings, type SandboxSettings, type CustomSandboxProfile, type SandboxProfileHost } from "./SandboxSettings";
import type { SandboxTaskPolicySnapshot } from "./SandboxTaskPolicy";

type SandboxProfileSnapshot = CustomSandboxProfile | { readonly id: "default"; readonly name: string; readonly description: string; readonly revision: 1 }

function freezeProfile<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freezeProfile(child)
		Object.freeze(value)
	}
	return value
}

/** Immutable authority context captured before command approval; never supplied by model arguments. */
export interface SandboxExecutionContext {
	readonly role: "main" | "subagent"
	readonly enabled: boolean
	readonly profileId: string
	readonly profile: SandboxProfileSnapshot
	readonly allowUnsandboxedFallback: boolean
	/** Explicit task-local policies always require native execution, with no fallback. */
	readonly taskPolicy?: SandboxTaskPolicySnapshot
}

export interface SandboxExecutionStatus {
	requested: SandboxExecutionContext
	effective: "off" | "native" | "unsandboxed-fallback"
	backend?: string
	reason?: string
}

export function captureSandboxExecution(settings: SandboxSettings, subagent: boolean, host?: SandboxProfileHost): SandboxExecutionContext {
	const valid = validateSandboxSettings(settings)
	const profile = resolveSandboxProfile(valid, subagent ? valid.subagentProfileId : valid.mainAgentProfileId, host)
	const snapshot: SandboxProfileSnapshot = "kind" in profile ? profile : { ...profile, id: "default", revision: 1 }
	return Object.freeze({
		role: subagent ? "subagent" : "main",
		enabled: valid.enabled,
		profileId: subagent ? valid.subagentProfileId : valid.mainAgentProfileId,
		profile: freezeProfile(snapshot),
		allowUnsandboxedFallback: valid.allowUnsandboxedFallback,
	})
}

export function sandboxExecutionKey(context: SandboxExecutionContext | undefined): string {
	return context ? JSON.stringify([context.role, context.enabled, context.profileId, context.profile, context.allowUnsandboxedFallback, context.taskPolicy]) : "legacy"
}

export function assertSandboxExecutionCurrent(expected: SandboxExecutionContext, current: SandboxExecutionContext): void {
	if (sandboxExecutionKey(expected) !== sandboxExecutionKey(current)) {
		throw new Error("Sandbox settings changed after command approval; request execution again under the current settings.")
	}
}

export function describeSandboxExecution(context: SandboxExecutionContext): string {
	if (!context.enabled) return "Sandbox: Off (normal unsandboxed execution)."
	const profile = `${context.profile.name} (revision ${context.profile.revision})`
	const protection = context.profileId === "default" ? "permissive; no meaningful isolation" : "command approval authorizes execution within these profile restrictions"
	return `Sandbox: ${profile} (${protection}).${context.taskPolicy ? " Immutable task-local policy; bounded by saved and current user ceiling." : ""} Unsandboxed fallback: ${context.allowUnsandboxedFallback ? "authorized" : "not authorized"}.`
}
