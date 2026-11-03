import type React from "react"

const GOLDEN_ANGLE_DEGREES = 137.508

interface SubagentAvatarProps {
	agentId: string | number
	agentName: string
}

export function getSubagentAvatarInitial(agentName: string): string {
	const [initial = "?"] = Array.from(agentName.trim())
	return initial.toLocaleUpperCase()
}

export function getSubagentAvatarAccent(agentId: string | number): string {
	let identity = typeof agentId === "number" ? agentId : 0
	if (typeof agentId === "string") {
		for (let index = 0; index < agentId.length; index++) {
			identity = (Math.imul(identity, 31) + agentId.charCodeAt(index)) >>> 0
		}
	}
	const hue = Math.round(((identity - 1) * GOLDEN_ANGLE_DEGREES) % 360)
	return `hsl(${hue} 48% 46%)`
}

export const SubagentAvatar: React.FC<SubagentAvatarProps> = ({ agentId, agentName }) => (
	<span
		aria-hidden="true"
		className="subagent-avatar flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold leading-none"
		data-testid="subagent-avatar"
		style={{ "--subagent-avatar-accent": getSubagentAvatarAccent(agentId) } as React.CSSProperties}>
		{getSubagentAvatarInitial(agentName)}
	</span>
)
