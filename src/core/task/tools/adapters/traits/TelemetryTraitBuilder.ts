import { telemetryService } from "@services/telemetry"
import type { ITelemetryTrait, TelemetryMetadata } from "../../interfaces/IToolEnvironment"
import type { TaskConfig } from "../../types/TaskConfig"
import { getTaskCompletionTelemetry } from "../../utils"

export function buildTelemetryTrait(
	metadataHolder: { customMetadata: TelemetryMetadata },
	config: TaskConfig,
): ITelemetryTrait {
	return {
		captureCustomMetadata: (metadata) => {
			metadataHolder.customMetadata = { ...metadataHolder.customMetadata, ...metadata }
		},
		captureTaskCompleted: () => telemetryService.captureTaskCompleted(config.ulid, getTaskCompletionTelemetry(config)),
		captureOptionSelected: (optionCount, mode) =>
			telemetryService.captureOptionSelected(config.ulid, optionCount, mode),
		captureOptionsIgnored: (optionCount, mode) =>
			telemetryService.captureOptionsIgnored(config.ulid, optionCount, mode),
	}
}
