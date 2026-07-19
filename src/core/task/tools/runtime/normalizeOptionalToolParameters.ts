import type { DiracToolSpec, DiracToolSpecParameter } from "@/shared/tools"

function normalizeSchemaValue(value: unknown, schema: any): unknown {
	if (Array.isArray(value) && schema?.type === "array" && schema.items) {
		return value.map((item) => normalizeSchemaValue(item, schema.items))
	}

	if (!value || typeof value !== "object" || Array.isArray(value) || schema?.type !== "object") {
		return value
	}

	const required = new Set<string>(schema.required ?? [])
	const properties = schema.properties ?? {}
	const normalized: Record<string, unknown> = {}

	for (const [key, propertyValue] of Object.entries(value)) {
		const propertySchema = properties[key]
		if (propertyValue === null && propertySchema && !required.has(key)) continue
		normalized[key] = propertySchema ? normalizeSchemaValue(propertyValue, propertySchema) : propertyValue
	}

	return normalized
}

function normalizeParameterValue(value: unknown, parameter: DiracToolSpecParameter): unknown {
	if (parameter.type === "array" && Array.isArray(value) && parameter.items) {
		return value.map((item) => normalizeSchemaValue(item, parameter.items))
	}

	if (parameter.type === "object" && parameter.properties && value && typeof value === "object" && !Array.isArray(value)) {
		return normalizeSchemaValue(value, {
			type: "object",
			properties: parameter.properties,
			required: [],
		})
	}

	return value
}

export function normalizeOptionalToolParameters(params: Record<string, unknown>, spec: DiracToolSpec): Record<string, unknown> {
	const parameters = new Map((spec.parameters ?? []).map((parameter) => [parameter.name, parameter]))
	const normalized: Record<string, unknown> = {}

	for (const [name, value] of Object.entries(params)) {
		const parameter = parameters.get(name)
		if (value === null && parameter && !parameter.required) continue
		normalized[name] = parameter ? normalizeParameterValue(value, parameter) : value
	}

	return normalized
}
