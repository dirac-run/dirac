import type { ApiProvider, ModelInfo } from "@shared/api"
import { TaskStatus, type ExtensionState } from "@shared/ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { getProviderDefaultModelId, getProviderModelIdKey } from "@shared/storage"
import type { Mode } from "@shared/storage/types"
import { StateManager } from "@/core/storage/StateManager"
import { useEffect, useMemo, useState } from "react"
import { providerModels } from "../utils/model-metadata"
import { getGitBranch, getGitDiffStats, type GitDiffStats } from "../utils/git"

const DEFAULT_CONTEXT_WINDOW = 200000

interface UseChatFooterStatusProps {
    ctrl: any
    mode: Mode
    taskState: Partial<ExtensionState>
}

interface ChatFooterStatus {
    provider: string
    modelId: string
    lastApiReqTotalTokens: number
    contextWindowSize: number
    totalCost: number
    cacheHitRate: number
    workspacePath: string
    gitBranch: string | null
    gitDiffStats: GitDiffStats | null
    taskStatus: ExtensionState["taskStatus"]
}

export function useChatFooterStatus({ ctrl, mode, taskState }: UseChatFooterStatusProps): ChatFooterStatus {
    const provider = useMemo(() => {
        const providerKey = mode === "act" ? "actModeApiProvider" : "planModeApiProvider"
        const stateManagerValue = StateManager.get().getGlobalSettingsKey(providerKey) as string
        if (stateManagerValue) {
            return stateManagerValue
        }
        const configValue = (taskState.apiConfiguration as any)?.[providerKey] as string | undefined
        if (configValue !== undefined) {
            return configValue
        }
        return (StateManager.get().getGlobalSettingsKey(providerKey) as string) || ""
    }, [mode, taskState.apiConfiguration])

    const modelId = useMemo(() => {
        if (!provider) return ""
        const modelKey = getProviderModelIdKey(provider as ApiProvider, mode)
        const stateManagerValue = StateManager.get().getGlobalSettingsKey(modelKey) as string
        if (stateManagerValue) {
            return stateManagerValue
        }
        const configValue = (taskState.apiConfiguration as any)?.[modelKey] as string | undefined
        if (configValue !== undefined) {
            return configValue
        }
        return (
            (StateManager.get().getGlobalSettingsKey(modelKey) as string) ||
            getProviderDefaultModelId(provider as ApiProvider) ||
            ""
        )
    }, [mode, provider, taskState.apiConfiguration])

    const workspacePath = useMemo(() => {
        const root = ctrl?.getWorkspaceManagerSync?.()?.getPrimaryRoot?.()
        return root?.path ?? process.cwd()
    }, [ctrl])

    const [gitBranch, setGitBranch] = useState<string | null>(null)
    const [gitDiffStats, setGitDiffStats] = useState<GitDiffStats | null>(null)

    useEffect(() => {
        setGitBranch(getGitBranch(workspacePath))
        setGitDiffStats(getGitDiffStats(workspacePath))
    }, [workspacePath])

    const lastMsg = (taskState.diracMessages || [])[(taskState.diracMessages || []).length - 1]
    useEffect(() => {
        setGitDiffStats(getGitDiffStats(workspacePath))
    }, [taskState.diracMessages?.length, taskState.activeVoiceStreamId, lastMsg?.id, workspacePath])

    const metrics = getApiMetrics(taskState.diracMessages || [])
    const lastApiReqTotalTokens = useMemo(
        () => getLastApiReqTotalTokens(taskState.diracMessages || []),
        [taskState.diracMessages],
    )
    const contextWindowSize = useMemo(() => {
        const providerData = providerModels[provider]
        if (providerData && modelId in providerData.models) {
            const modelInfo = providerData.models[modelId] as ModelInfo
            if (modelInfo?.contextWindow) return modelInfo.contextWindow
        }
        return DEFAULT_CONTEXT_WINDOW
    }, [provider, modelId])

    return {
        provider,
        modelId,
        lastApiReqTotalTokens,
        contextWindowSize,
        totalCost: metrics.totalCost,
        cacheHitRate: metrics.cacheHitRate,
        workspacePath,
        gitBranch,
        gitDiffStats,
        taskStatus: taskState.taskStatus ?? TaskStatus.IDLE,
    }
}
