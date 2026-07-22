import { ApiConfiguration } from "@shared/api"
import { Mode } from "@shared/ExtensionMessage"
import { UpdateApiConfigurationPartialRequest, UpdateApiConfigurationRequest } from "@shared/proto/dirac/models"
import { convertApiConfigurationToProto } from "@shared/proto-conversions/models/api-configuration-conversion"
import { useCallback } from "react"
import { useSettingsStore } from "@/features/settings/store/settingsStore"
import { ModelsServiceClient } from "@/shared/api/grpc-client"

let apiConfigurationPersistenceQueue: Promise<void> = Promise.resolve()
let persistedApiConfiguration: ApiConfiguration | undefined
let pendingPersistenceOperations = 0
let nextApiConfigurationRevision = 0
const apiConfigurationFieldRevisions = new Map<keyof ApiConfiguration, number>()

export const useApiConfigurationHandlers = () => {
	const planActSeparateModelsSetting = useSettingsStore((state) => state.planActSeparateModelsSetting)

	const handleFieldsChange = useCallback(async (updates: Partial<ApiConfiguration>): Promise<boolean> => {
		const fields = Object.keys(updates) as (keyof ApiConfiguration)[]
		if (fields.length === 0) return true

		const store = useSettingsStore.getState()
		const previousConfig = store.apiConfiguration as ApiConfiguration
		const updatedConfig = { ...previousConfig, ...updates }
		const revision = ++nextApiConfigurationRevision

		if (pendingPersistenceOperations === 0) persistedApiConfiguration = previousConfig
		pendingPersistenceOperations++

		for (const field of fields) {
			apiConfigurationFieldRevisions.set(field, revision)
		}

		store.setSettings({
			apiConfiguration: updatedConfig,
			apiConfigurationError: undefined,
			pendingApiConfigurationUpdates: {
				...store.pendingApiConfigurationUpdates,
				...updates,
			},
		})

		const operation = apiConfigurationPersistenceQueue.then(async (): Promise<boolean> => {
			const persistedBase = persistedApiConfiguration ?? previousConfig
			const configurationToPersist = { ...persistedBase, ...updates }

			try {
				if (fields.includes("openAiCompatibleProfiles")) {
					await ModelsServiceClient.updateApiConfigurationProto(
						UpdateApiConfigurationRequest.create({
							apiConfiguration: convertApiConfigurationToProto(configurationToPersist),
						}),
					)
				} else {
					await ModelsServiceClient.updateApiConfigurationPartial(
						UpdateApiConfigurationPartialRequest.create({
							apiConfiguration: convertApiConfigurationToProto(configurationToPersist),
							updateMask: fields as string[],
						}),
					)
				}

				persistedApiConfiguration = configurationToPersist
				const currentStore = useSettingsStore.getState()
				const pending = { ...currentStore.pendingApiConfigurationUpdates }
				for (const field of fields) {
					if (apiConfigurationFieldRevisions.get(field) === revision) delete pending[field]
				}
				currentStore.setSettings({ pendingApiConfigurationUpdates: pending })
				return true
			} catch (error) {
				const currentStore = useSettingsStore.getState()
				const currentConfig = currentStore.apiConfiguration as ApiConfiguration
				const rollback: Partial<ApiConfiguration> = {}

				for (const field of fields) {
					if (
						apiConfigurationFieldRevisions.get(field) === revision &&
						Object.is(currentConfig[field], updates[field])
					) {
						;(rollback as Record<keyof ApiConfiguration, unknown>)[field] = previousConfig[field]
					}
				}

				const pending = { ...currentStore.pendingApiConfigurationUpdates }
				for (const field of fields) {
					if (apiConfigurationFieldRevisions.get(field) === revision) delete pending[field]
				}
				const message = error instanceof Error ? error.message : "Failed to save API configuration"
				currentStore.setSettings({
					apiConfiguration: { ...currentConfig, ...rollback },
					apiConfigurationError: message,
					pendingApiConfigurationUpdates: pending,
				})
				console.error("Failed to update API configuration:", error)
				return false
			} finally {
				pendingPersistenceOperations--
			}
		})

		apiConfigurationPersistenceQueue = operation.then(() => undefined)
		return operation
	}, [])

	const handleFieldChange = useCallback(
		async <K extends keyof ApiConfiguration>(field: K, value: ApiConfiguration[K]): Promise<boolean> =>
			handleFieldsChange({ [field]: value } as Partial<ApiConfiguration>),
		[handleFieldsChange],
	)

	const handleModeFieldChange = useCallback(
		async <PlanK extends keyof ApiConfiguration, ActK extends keyof ApiConfiguration>(
			fieldPair: { plan: PlanK; act: ActK },
			value: ApiConfiguration[PlanK] & ApiConfiguration[ActK],
			currentMode: Mode,
		): Promise<boolean> => {
			if (planActSeparateModelsSetting) {
				return handleFieldChange(fieldPair[currentMode], value)
			}
			return handleFieldsChange({
				[fieldPair.plan]: value,
				[fieldPair.act]: value,
			} as Partial<ApiConfiguration>)
		},
		[handleFieldChange, handleFieldsChange, planActSeparateModelsSetting],
	)

	const handleModeFieldsChange = useCallback(
		async <T extends Record<string, any>>(
			fieldPairs: { [K in keyof T]: { plan: keyof ApiConfiguration; act: keyof ApiConfiguration } },
			values: T,
			currentMode: Mode,
		): Promise<boolean> => {
			const updates: Partial<ApiConfiguration> = {}
			Object.entries(fieldPairs).forEach(([key, { plan, act }]) => {
				if (planActSeparateModelsSetting) {
					updates[currentMode === "plan" ? plan : act] = values[key]
				} else {
					updates[plan] = values[key]
					updates[act] = values[key]
				}
			})
			return handleFieldsChange(updates)
		},
		[handleFieldsChange, planActSeparateModelsSetting],
	)

	return { handleFieldChange, handleFieldsChange, handleModeFieldChange, handleModeFieldsChange }
}
