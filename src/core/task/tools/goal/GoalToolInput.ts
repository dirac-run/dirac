import type { IGoalTrait, IToolEnvironment } from "../interfaces/IToolEnvironment"

export type GoalToolArguments = Record<string, unknown>

export function requireGoalTrait(environment: IToolEnvironment): IGoalTrait {
	if (!environment.goal) throw new Error("Goal tool requires a Goal coordinator environment.")
	return environment.goal
}

export function requireArguments(value: unknown): GoalToolArguments {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Goal tool arguments must be an object.")
	}
	return value as GoalToolArguments
}

export function requireNonEmptyString(argumentsValue: GoalToolArguments, name: string): string {
	const value = argumentsValue[name]
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Parameter '${name}' must be a non-empty string.`)
	}
	return value
}



export function goalToolJson(value: unknown): string {
	return JSON.stringify(value, null, 2)
}
