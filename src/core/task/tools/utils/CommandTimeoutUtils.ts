const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30
const LONG_RUNNING_COMMAND_TIMEOUT_SECONDS = 300

const LONG_RUNNING_COMMAND_PATTERNS: RegExp[] = [
	/\b(npm|pnpm|yarn|bun)\s+(install|ci|build|test)\b/i,
	/\b(npm|pnpm|yarn|bun)\s+run\s+(build|test|lint|typecheck|check)\b/i,
	/\b(pip|pip3|uv)\s+install\b/i,
	/\b(poetry|pipenv)\s+install\b/i,
	/\b(cargo|go|mvn|gradle|gradlew)\s+(build|test|check|install)\b/i,
	/\b(make|cmake|ctest)\b/i,
	/\b(pytest|tox|nox|jest|vitest|mocha)\b/i,
	/\b(docker|podman)\s+build\b/i,
	/\b(torchrun|deepspeed|accelerate\s+launch)\b/i,
	/\b(sleep|wait|watch)\b/i,
	/\b(rails|rake|bundle\s+exec\s+rake)\s+db:(migrate|setup|seed)\b/i,
	/\b(alembic|flask\s+db)\s+(upgrade|downgrade)\b/i,
	/\b(extraction|npx\s+prisma)\s+(migrate|db\s+push)\b/i,
	/\b(sequelize|npx\s+sequelize)\s+db:migrate\b/i,
	/\b(django-admin|python\s+manage\.py)\s+migrate\b/i,
	/\bffmpeg\b/i,
	/\bpython(?:\d+(?:\.\d+)?)?\s+.*\b(train|finetune)\b/i,
]

export function isLikelyLongRunningCommand(command: string): boolean {
	const normalized = command.trim().replace(/\s+/g, " ")
	return LONG_RUNNING_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized))
}

export function resolveCommandTimeoutSeconds(command: string, useManagedTimeout: boolean): number | undefined {
	if (!useManagedTimeout) {
		return undefined
	}

	return isLikelyLongRunningCommand(command) ? LONG_RUNNING_COMMAND_TIMEOUT_SECONDS : DEFAULT_COMMAND_TIMEOUT_SECONDS
}
