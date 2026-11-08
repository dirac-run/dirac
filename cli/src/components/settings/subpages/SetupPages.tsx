import React from "react"
import { BedrockSetup, type BedrockConfig } from "../../BedrockSetup"
import { BedrockCustomModelFlow } from "../../BedrockCustomModelFlow"
import { StateManager } from "@/core/storage/StateManager"

interface BedrockSetupPageProps {
	isActive: boolean
	onCancel: () => void
	onComplete: (config: BedrockConfig) => void
}

export const BedrockSetupPage: React.FC<BedrockSetupPageProps> = ({ isActive, onCancel, onComplete }) => (
	<BedrockSetup isActive={isActive} initialEndpoint={StateManager.get().getSystemDefaultSettingsKey("awsBedrockEndpoint")} onCancel={onCancel} onComplete={onComplete} />
)

interface BedrockCustomFlowPageProps {
	isActive: boolean
	onCancel: () => void
	onComplete: (arn: string, baseModelId: string) => void
}

export const BedrockCustomFlowPage: React.FC<BedrockCustomFlowPageProps> = ({ isActive, onCancel, onComplete }) => (
	<BedrockCustomModelFlow isActive={isActive} onCancel={onCancel} onComplete={onComplete} />
)
