import type { DiracDefaultTool, DiracToolSpec } from "@shared/tools"
import { telemetryService } from "@/services/telemetry"
import type { ToolParamName, ToolUse } from "../../../assistant-message"
import { showNotificationForApproval } from "../../utils"
import { removeClosingTag } from "../utils/ToolConstants"
import type { TaskConfig } from "./TaskConfig"

/**
 * Strongly-typed UI helper functions for tool handlers
 */
export interface StronglyTypedUIHelpers {
    // Utility methods
    removeClosingTag: (block: ToolUse, tag: ToolParamName, text?: any) => string

    // Approval methods
    shouldAutoApproveTool: (toolName: DiracDefaultTool) => boolean | [boolean, boolean]
    shouldAutoApproveToolWithPath: (toolName: DiracToolSpec["id"], path?: string) => Promise<boolean>

    // Telemetry and notifications
    captureTelemetry: (toolName: DiracDefaultTool, autoApproved: boolean, approved: boolean, isNativeToolCall?: boolean) => void
    showNotificationIfEnabled: (message: string) => void

    // Config access - returns the proper typed config
    getConfig: () => TaskConfig
}

/**
 * Creates strongly-typed UI helpers from a TaskConfig
 */
export function createUIHelpers(config: TaskConfig): StronglyTypedUIHelpers {
    return {
        removeClosingTag: (block: ToolUse, tag: ToolParamName, text?: any) => removeClosingTag(block, tag, text),
        shouldAutoApproveTool: (toolName: DiracDefaultTool) => config.autoApprover.shouldAutoApproveTool(toolName),
        shouldAutoApproveToolWithPath: config.callbacks.shouldAutoApproveToolWithPath,
        captureTelemetry: (toolName: DiracDefaultTool, autoApproved: boolean, approved: boolean, isNativeToolCall?: boolean) => {
            // Extract provider information for telemetry
            const apiConfig = config.services.stateManager.getApiConfiguration()
            const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
            const provider = (currentMode === "plan" ? apiConfig.planModeApiProvider : apiConfig.actModeApiProvider) as string

            telemetryService.captureToolUsage(
                config.ulid,
                toolName,
                config.api.getModel().id,
                provider,
                autoApproved,
                approved,
                undefined,
                isNativeToolCall,
            )
        },
        showNotificationIfEnabled: (message: string) => {
            showNotificationForApproval(message, config.autoApprovalSettings.enableNotifications)
        },
        getConfig: () => config,
    }
}
