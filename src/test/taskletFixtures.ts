import { randomUUID } from "node:crypto"

/** Independent opaque fixture IDs for tests not exercising the root-owned allocator. */
export function createTaskletFixtureId(): string {
	return `tasklet_${randomUUID()}`
}
