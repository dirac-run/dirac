/**
 * Manages telemetry context state: user identity, organization, and standard attributes.
 * Extracted from TelemetryService to enforce SRP — context management is separate from event capture.
 */
import type { TelemetryMetadata } from "./TelemetryService"
import type { TelemetryProperties } from "./providers/ITelemetryProvider"

export interface UserInfo {
	id: string
	organizationId: string
	organizationName: string
	memberId: string
}

export class TelemetryContextManager {
	private userId?: string
	private activeOrg: {
		organization_id: string
		organization_name: string
		member_id: string
	} | null = null

	constructor(private readonly telemetryMetadata: TelemetryMetadata) {}

	/** Sets user identity and org info from account info. */
	setUserInfo(userInfo: UserInfo): void {
		this.userId = userInfo.id
		this.activeOrg = {
			organization_id: userInfo.organizationId,
			organization_name: userInfo.organizationName,
			member_id: userInfo.memberId,
		}
	}

	/** Returns the current user ID, or undefined if not identified. */
	getUserId(): string | undefined {
		return this.userId
	}

	/** Returns the current org info, or null if not identified. */
	getActiveOrg(): { organization_id: string; organization_name: string; member_id: string } | null {
		return this.activeOrg
	}

	/** Merges telemetry metadata, user identity, org info, and extra attributes into one object. */
	getStandardAttributes(extra?: TelemetryProperties): TelemetryProperties {
		return {
			...this.telemetryMetadata,
			...(this.userId ? { userId: this.userId } : {}),
			...this.activeOrg,
			...(extra ?? {}),
		}
	}
}
