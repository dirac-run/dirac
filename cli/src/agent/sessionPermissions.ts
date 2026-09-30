import type * as acp from "@agentclientprotocol/sdk"
import type { Controller } from "@/core/controller"
import { CommandPermissionController } from "@/core/permissions/CommandPermissionController.js"
import type { ToolPermissionRule } from "@/core/permissions/types.js"
import type { DiracAcpSession, ElicitationHandler, PermissionHandler } from "./public-types.js"

interface SessionPermissionDeps {
	sessions: Map<string, DiracAcpSession>
	getController(session: DiracAcpSession): Controller | undefined
}

/**
 * Owns the client-interaction surfaces for permissions and elicitation:
 * handler registration, in-flight request resolvers that `session/cancel`
 * must abort, and project permission-rule persistence.
 */
export class SessionPermissionManager {
	/** Permission handler callback for requesting user permission */
	private permissionHandler?: PermissionHandler

	/** Elicitation handler supplied by the ACP transport. */
	private elicitationHandler?: ElicitationHandler

	/** Pending permission requests, so session/cancel can abort the client interaction. */
	private readonly pendingPermissionResolvers: Map<string, (response: acp.RequestPermissionResponse) => void> = new Map()

	/** Pending elicitation requests, so session/cancel can abort the client interaction. */
	private readonly pendingElicitationResolvers: Map<string, (response: acp.CreateElicitationResponse) => void> = new Map()

	constructor(private readonly deps: SessionPermissionDeps) {}

	/**
	 * Set the permission handler callback.
	 *
	 * This handler is called when the agent needs permission for a tool call.
	 * The handler should present the request to the user and call the resolve
	 * callback with their response.
	 *
	 * @param handler - The permission handler callback
	 */
	setPermissionHandler(handler: PermissionHandler): void {
		this.permissionHandler = handler
	}

	/** Set the transport callback used for ACP elicitation. */
	setElicitationHandler(handler: ElicitationHandler): void {
		this.elicitationHandler = handler
	}

	/** Abort a permission request currently waiting on the client. */
	cancelPendingPermission(sessionId: string): void {
		this.pendingPermissionResolvers.get(sessionId)?.({
			outcome: { outcome: "cancelled" },
		})
	}

	/** Abort an elicitation request currently waiting on the client. */
	cancelPendingElicitation(sessionId: string): void {
		this.pendingElicitationResolvers.get(sessionId)?.({
			action: "cancel",
		})
	}

	async requestElicitation(request: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
		if (!this.elicitationHandler) {
			return { action: "cancel" }
		}

		const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined
		return await new Promise((resolve) => {
			let settled = false
			const settle = (response: acp.CreateElicitationResponse) => {
				if (settled) return
				settled = true
				if (sessionId && this.pendingElicitationResolvers.get(sessionId) === settle) {
					this.pendingElicitationResolvers.delete(sessionId)
				}
				resolve(response)
			}
			if (sessionId) {
				this.pendingElicitationResolvers.get(sessionId)?.({ action: "cancel" })
				this.pendingElicitationResolvers.set(sessionId, settle)
			}
			this.elicitationHandler!(request, settle)
		})
	}

	/**
	 * Stores ACP “always” decisions in the project's `.dirac/permissions.json`.
	 * The rule applies to the matching tool across every session opened for this workspace.
	 */
	async persistPermissionRule(
		sessionId: string,
		toolCall: acp.ToolCall | acp.ToolCallUpdate,
		action: "allow" | "deny",
	): Promise<void> {
		const task = this.permissionTaskForSession(sessionId)

		const rawInput = toolCall.rawInput as Record<string, unknown> | undefined
		const commands = rawInput?.commands
		const command =
			Array.isArray(commands) && commands.length === 1 && typeof commands[0] === "object" && commands[0] !== null
				? (commands[0] as Record<string, unknown>).command
				: undefined

		const rule: ToolPermissionRule =
			typeof command === "string"
				? { tool: "execute_command", pattern: command, action }
				: { tool: this.permissionRuleToolName(toolCall), action }

		await task.addPermissionRule(rule)
	}

	/** List persisted project permission rules for an ACP session. */
	async listPermissionRules(sessionId: string): Promise<ToolPermissionRule[]> {
		const task = this.activePermissionTaskForSession(sessionId)
		if (task) {
			return await task.listPermissionRules()
		}

		return await this.withSessionPermissionController(sessionId, (controller) => controller.listRules())
	}

	/** Delete one persisted project permission rule for an ACP session. */
	async deletePermissionRule(sessionId: string, rule: ToolPermissionRule): Promise<void> {
		const task = this.activePermissionTaskForSession(sessionId)
		if (task) {
			await task.deletePermissionRule(rule)
			return
		}

		await this.withSessionPermissionController(sessionId, (controller) => controller.deleteRule(rule))
	}

	async requestPermission(
		sessionId: string,
		toolCall: any,
		options?: acp.PermissionOption[],
	): Promise<acp.RequestPermissionResponse> {
		if (!this.permissionHandler) {
			throw new Error("Permission handler not set")
		}
		return new Promise((resolve) => {
			const settle = (response: acp.RequestPermissionResponse) => {
				if (this.pendingPermissionResolvers.get(sessionId) === settle) {
					this.pendingPermissionResolvers.delete(sessionId)
				}
				resolve(response)
			}
			this.pendingPermissionResolvers.set(sessionId, settle)
			this.permissionHandler!({ sessionId, toolCall, options: options || [] }, settle)
		})
	}

	private activePermissionTaskForSession(sessionId: string) {
		const session = this.deps.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`)
		}
		return this.deps.getController(session)?.task
	}

	private async withSessionPermissionController<T>(
		sessionId: string,
		operation: (controller: CommandPermissionController) => Promise<T>,
	): Promise<T> {
		const session = this.deps.sessions.get(sessionId)
		if (!session) {
			throw new Error(`Unknown session: ${sessionId}`)
		}

		const controller = new CommandPermissionController()
		await controller.initialize(session.cwd)
		try {
			return await operation(controller)
		} finally {
			await controller.dispose()
		}
	}

	private permissionTaskForSession(sessionId: string) {
		const task = this.activePermissionTaskForSession(sessionId)
		if (!task) {
			throw new Error("Cannot persist a permission rule without an active session task")
		}
		return task
	}

	private permissionRuleToolName(toolCall: acp.ToolCall | acp.ToolCallUpdate): string {
		if (!toolCall.title) {
			throw new Error("Cannot persist a permission rule without a tool title")
		}
		return toolCall.title
	}
}
