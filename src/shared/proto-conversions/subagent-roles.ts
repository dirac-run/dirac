import type { SubagentRoles as ProtoSubagentRoles } from "@shared/proto/dirac/state"
import { type SubagentRole, validateSubagentRoles } from "@shared/subagentRoles"
import { convertModelProviderSelectionToProto, convertProtoToModelProviderSelection } from "./models/api-configuration-conversion"

export function convertSubagentRolesToProto(roles: SubagentRole[]): ProtoSubagentRoles {
	return {
		roles: validateSubagentRoles(roles).map((role) => ({
			...role,
			modelSelection: role.modelSelection ? convertModelProviderSelectionToProto(role.modelSelection) : undefined,
		})),
	}
}

export function convertProtoToSubagentRoles(value: ProtoSubagentRoles): SubagentRole[] {
	return validateSubagentRoles(value.roles.map((role) => ({
		name: role.name,
		description: role.description,
		enabled: role.enabled,
		...(role.modelSelection ? { modelSelection: convertProtoToModelProviderSelection(role.modelSelection) } : {}),
	})))
}
