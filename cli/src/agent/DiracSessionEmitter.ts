/**
 * Typed EventEmitter for per-session ACP events.
 *
 * This class provides a type-safe wrapper around Node's EventEmitter
 * for emitting and subscribing to session-specific ACP events.
 *
 * Includes replay-on-subscribe: if a payload has already been emitted
 * for an event, new subscribers immediately receive the latest payload.
 * This solves the race condition where bootstrap emits config_option_update
 * before React components mount and subscribe.
 *
 * @module acp
 */

import { EventEmitter } from "events"
import type { DiracSessionEvents } from "./public-types.js"

/**
 * Type-safe EventEmitter for DiracAgent session events.
 *
 * Each session has its own emitter instance, allowing consumers to
 * subscribe to events for specific sessions without filtering.
 *
 * @example
 * ```typescript
 * const agent = new DiracAgent({ version: "1.0.0" })
 * const session = await agent.newSession({ cwd: "/path/to/project" })
 *
 * // Subscribe to session events
 * agent.session(session.sessionId).on("agent_message_chunk", (content) => {
 *   console.log("Agent says:", content.text)
 * })
 *
 * agent.session(session.sessionId).on("tool_call", (toolCall) => {
 *   console.log("Tool called:", toolCall.toolName)
 * })
 * ```
 */
export class DiracSessionEmitter {
	private readonly emitter: EventEmitter
	/**
	 * Last emitted payload per event, used to replay to late-joining subscribers.
	 * This solves the race condition where bootstrap emits config_option_update
	 * before React components mount and subscribe.
	 */
	private readonly lastPayload = new Map<string, unknown[]>()

	constructor() {
		this.emitter = new EventEmitter()
		// Increase max listeners since we may have many event types
		this.emitter.setMaxListeners(20)
	}

	/**
	 * Subscribe to a session event.
	 *
	 * If a payload has already been emitted for this event, the listener is
	 * immediately called with that payload (replay-on-subscribe).
	 *
	 * @param event - The event name to subscribe to
	 * @param listener - The callback function to invoke when the event is emitted
	 * @returns This emitter instance for chaining
	 */
	on<K extends keyof DiracSessionEvents>(event: K, listener: DiracSessionEvents[K]): this {
		this.emitter.on(event, listener as (...args: unknown[]) => void)

		// Replay last emitted payload so late subscribers get the latest state
		const last = this.lastPayload.get(event as string)
		if (last) {
			;((listener as (...args: unknown[]) => void).bind(null) as (...args: unknown[]) => void)(...last)
		}

		return this
	}

	once<K extends keyof DiracSessionEvents>(event: K, listener: DiracSessionEvents[K]): this {
		// For once: if we have a last payload, fire immediately and don't register
		const last = this.lastPayload.get(event as string)
		if (last) {
			;((listener as (...args: unknown[]) => void).bind(null) as (...args: unknown[]) => void)(...last)
		} else {
			this.emitter.once(event, listener as (...args: unknown[]) => void)
		}
		return this
	}

	/**
	 * Unsubscribe from a session event.
	 *
	 * @param event - The event name to unsubscribe from
	 * @param listener - The callback function to remove
	 * @returns This emitter instance for chaining
	 */
	off<K extends keyof DiracSessionEvents>(event: K, listener: DiracSessionEvents[K]): this {
		this.emitter.off(event, listener as (...args: unknown[]) => void)
		return this
	}

	/**
	 * Emit a session event and cache the payload for replay.
	 *
	 * @param event - The event name to emit
	 * @param args - The arguments to pass to the event listeners
	 * @returns True if the event had listeners, false otherwise
	 */
	emit<K extends keyof DiracSessionEvents>(event: K, ...args: Parameters<DiracSessionEvents[K]>): boolean {
		// Cache last payload for replay-on-subscribe
		this.lastPayload.set(event as string, args)
		return this.emitter.emit(event, ...args)
	}

	/**
	 * Remove all listeners for a specific event or all events.
	 *
	 * Does NOT clear the replay cache so that new subscribers still get the
	 * latest payload even after previous subscribers have been removed.
	 *
	 * @param event - Optional event name to remove listeners for
	 * @returns This emitter instance for chaining
	 */
	removeAllListeners<K extends keyof DiracSessionEvents>(event?: K): this {
		if (event) {
			this.emitter.removeAllListeners(event)
		} else {
			this.emitter.removeAllListeners()
		}
		return this
	}

	/**
	 * Get the number of listeners for a specific event.
	 *
	 * @param event - The event name to count listeners for
	 * @returns The number of listeners
	 */
	listenerCount<K extends keyof DiracSessionEvents>(event: K): number {
		return this.emitter.listenerCount(event)
	}
}
