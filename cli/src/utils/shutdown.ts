/**
 * Process-shutdown event for graceful CLI cleanup.
 * Components subscribe to be notified before the process exits.
 */

class CliEventEmitter<T> {
	private listeners: Array<(e: T) => void> = []

	event = (listener: (e: T) => void) => {
		this.listeners.push(listener)
		return {
			dispose: () => {
				const idx = this.listeners.indexOf(listener)
				if (idx >= 0) this.listeners.splice(idx, 1)
			},
		}
	}

	fire(data: T): void {
		for (const listener of this.listeners) {
			listener(data)
		}
	}

	dispose(): void {
		this.listeners.length = 0
	}
}

export const shutdownEvent = new CliEventEmitter<void>()
