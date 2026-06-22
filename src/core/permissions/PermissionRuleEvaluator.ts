import picomatch from "picomatch"
import type { CommandPermissionConfig, PermissionValidationResult, ToolPermissionRule } from "./types"

/**
 * Evaluates permission rules against tools and commands.
 * Handles rule matching logic: deny rules take precedence over allow rules.
 * Supports both the new `rules` array format and legacy `allow`/`deny` arrays.
 */
export class PermissionRuleEvaluator {
	/** Check if a rule matches the given tool and pattern. */
	matchesRule(rule: ToolPermissionRule, tool: string, pattern?: string): boolean {
		if (rule.tool !== "*" && rule.tool !== tool) return false
		if (!rule.pattern) return true
		if (!pattern) return false

		if (tool === "execute_command") {
			return this.matchesPattern(pattern, rule.pattern)
		}
		return picomatch(rule.pattern, { dot: true })(pattern)
	}

	/**
	 * Check if a command matches a wildcard pattern.
	 * `*` matches any characters (including `/` and newlines), `?` matches exactly one character.
	 */
	matchesPattern(command: string, pattern: string): boolean {
		const regex = new RegExp(
			"^" +
				pattern
					.replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape special regex chars
					.replace(/\*/g, ".*") // * becomes .*
					.replace(/\?/g, ".") + // ? becomes .
				"$",
			"s", // s flag enables dotAll (. matches newlines)
		)
		return regex.test(command)
	}

	/** Validate a single command string against the config's rules and legacy allow/deny arrays. */
	validateSingleCommand(command: string, config: CommandPermissionConfig): PermissionValidationResult {
		// Check rules array first (new format)
		if (config.rules) {
			const denyResult = this.checkRules(command, config.rules, "deny")
			if (denyResult) return denyResult

			const allowResult = this.checkRules(command, config.rules, "allow")
			if (allowResult) return allowResult
		}

		// Check legacy deny rules
		if (config.deny) {
			for (const pattern of config.deny) {
				if (this.matchesPattern(command, pattern)) {
					return { allowed: false, matchedPattern: pattern, reason: "denied" }
				}
			}
		}

		// Check legacy allow rules
		if (config.allow && config.allow.length > 0) {
			for (const pattern of config.allow) {
				if (this.matchesPattern(command, pattern)) {
					return { allowed: true, matchedPattern: pattern, reason: "allowed" }
				}
			}
			// Allow rules defined but no match = deny by default
			return { allowed: false, reason: "no_match_deny_default" }
		}

		// No allow rules defined, and no deny matched = allow
		return { allowed: true, reason: "no_config" }
	}

	/** Check rules of a specific action (deny or allow) against a command. */
	private checkRules(
		command: string,
		rules: ToolPermissionRule[],
		action: "allow" | "deny",
	): PermissionValidationResult | null {
		for (const rule of rules) {
			if (rule.tool === "execute_command" || rule.tool === "*") {
				if (rule.action === action && rule.pattern && this.matchesPattern(command, rule.pattern)) {
					return {
						allowed: action === "allow",
						matchedPattern: rule.pattern,
						reason: action === "deny" ? "denied" : "allowed",
					}
				}
			}
		}
		return null
	}
}
