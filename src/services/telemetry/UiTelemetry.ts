/**
 * Captures UI interaction telemetry: model selection, favorites, button clicks, and menu opens.
 * Extracted from TelemetryService to enforce SRP — UI-domain events are isolated from task/tool events.
 */
import { TELEMETRY_EVENTS } from "./TelemetryEvents"
import type { TelemetryEventEmitter } from "./TelemetryEventEmitter"

export class UiTelemetry {
	private static readonly EVENTS = TELEMETRY_EVENTS.UI

	constructor(private readonly emitter: TelemetryEventEmitter) {}

	captureModelSelected(model: string, provider: string, ulid?: string): void {
		this.emitter.capture({ event: UiTelemetry.EVENTS.MODEL_SELECTED, properties: { model, provider, ulid } })
	}

	captureModelFavoritesUsage(model: string, isFavorited: boolean): void {
		this.emitter.capture({
			event: UiTelemetry.EVENTS.MODEL_FAVORITE_TOGGLED,
			properties: { model, isFavorited },
		})
	}

	captureButtonClick(button: string, ulid?: string): void {
		this.emitter.capture({ event: UiTelemetry.EVENTS.BUTTON_CLICKED, properties: { button, ulid } })
	}

	captureRulesMenuOpened(): void {
		this.emitter.capture({ event: UiTelemetry.EVENTS.RULES_MENU_OPENED, properties: {} })
	}
}
