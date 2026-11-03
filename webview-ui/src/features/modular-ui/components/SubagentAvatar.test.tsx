import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { getSubagentAvatarAccent, getSubagentAvatarInitial, SubagentAvatar } from "./SubagentAvatar"

describe("SubagentAvatar", () => {
	it("uses the first Unicode character of the complete subagent name", () => {
		expect(getSubagentAvatarInitial("Gödel")).toBe("G")
		expect(getSubagentAvatarInitial("Feynman Planck")).toBe("F")
		expect(getSubagentAvatarInitial("von Neumann")).toBe("V")
	})

	it("assigns compound-name subagents distinct stable accents", () => {
		const feynmanPlanckAccent = getSubagentAvatarAccent(34)

		expect(getSubagentAvatarAccent(34)).toBe(feynmanPlanckAccent)
		expect(getSubagentAvatarAccent(35)).not.toBe(feynmanPlanckAccent)
	})

	it.each([
		[1, "hsl(0 48% 46%)"],
		[2, "hsl(138 48% 46%)"],
		[3, "hsl(275 48% 46%)"],
	] as const)("preserves the legacy numeric hue for agent %s", (agentId, accent) => {
		expect(getSubagentAvatarAccent(agentId)).toBe(accent)
	})

	it("hashes stable string identities independently of legacy numeric identities", () => {
		const accent = getSubagentAvatarAccent("tl-stable")
		expect(getSubagentAvatarAccent("tl-sibling")).not.toBe(accent)
		expect(getSubagentAvatarAccent("tl-stable")).toBe(accent)
		expect(getSubagentAvatarAccent("2")).not.toBe(getSubagentAvatarAccent(2))
	})

	it("keeps a tasklet's accent when its title changes", () => {
		const { rerender } = render(<SubagentAvatar agentId="tl-stable" agentName="Inspect implementation" />)
		const avatar = screen.getByTestId("subagent-avatar")
		const accent = avatar.style.getPropertyValue("--subagent-avatar-accent")
		expect(accent).toBe(getSubagentAvatarAccent("tl-stable"))
		expect(avatar).toHaveTextContent("I")

		rerender(<SubagentAvatar agentId="tl-stable" agentName="Review implementation" />)
		expect(avatar.style.getPropertyValue("--subagent-avatar-accent")).toBe(accent)
		expect(avatar).toHaveTextContent("R")
	})

	it("renders a decorative circular initial", () => {
		render(<SubagentAvatar agentId={34} agentName="Feynman Planck" />)

		const avatar = screen.getByTestId("subagent-avatar")
		expect(avatar).toHaveTextContent("F")
		expect(avatar).toHaveAttribute("aria-hidden", "true")
		expect(avatar).toHaveClass("rounded-full")
		expect(avatar.style.getPropertyValue("--subagent-avatar-accent")).toBe(getSubagentAvatarAccent(34))
	})
})
