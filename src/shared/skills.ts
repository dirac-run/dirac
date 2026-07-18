/**
 * Skill metadata loaded at startup for discovery.
 * Only name and description are parsed from frontmatter initially.
 */
export interface SkillMetadata {
	name: string
	description: string
	path: string
	source: "builtin" | "global" | "project"
	interactiveOnly?: boolean
	/** Built-in-only dependencies injected while this skill is active. */
	toolDependencies?: readonly string[]
}

/**
 * Full skill content loaded on-demand when skill is activated.
 */
export interface SkillContent extends SkillMetadata {
	instructions: string
}
