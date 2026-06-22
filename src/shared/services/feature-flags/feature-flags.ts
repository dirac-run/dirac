import type { FeatureFlagPayload } from "@/services/feature-flags/providers/IFeatureFlagsProvider"
import { isDev, isE2E } from "@shared/config/environment"

export enum FeatureFlag {
	WEBTOOLS = "webtools",
	WORKTREES = "worktree-exp",
	// Feature flag for showing the new onboarding flow or old welcome view.
	ONBOARDING_MODELS = "onboarding_models",
	// Feature flag for remote banner service
	REMOTE_BANNERS = "remote-banners",
	// Feature flag payload (milliseconds) controlling remote banner cache TTL
	EXTENSION_REMOTE_BANNERS_TTL = "extension_remote_banners_ttl",
	// Feature flag for DB-backed welcome banners (What's New modal)
	// When off, hardcoded welcome items are shown instead
	REMOTE_WELCOME_BANNERS = "remote-welcome-banners",
	// Feature flag for upstream Dirac recommended model cards
	DIRAC_RECOMMENDED_MODELS_UPSTREAM = "dirac-recommended-models-upstream",
	// Rollout flag for Dirac provider model sourcing:
	// off => OpenRouter model list, on => Dirac endpoint model list.
	EXTENSION_DIRAC_MODELS_ENDPOINT = "extension_dirac_models_endpoint",
	// Use the websocket mode for OpenAI native Responses API format
	OPENAI_RESPONSES_WEBSOCKET_MODE = "openai-responses-websocket-mode",
}

export const FeatureFlagDefaultValue: Partial<Record<FeatureFlag, FeatureFlagPayload>> = {
	[FeatureFlag.WEBTOOLS]: false,
	[FeatureFlag.WORKTREES]: false,
	[FeatureFlag.ONBOARDING_MODELS]: isE2E() ? { models: {} } : undefined,
	[FeatureFlag.REMOTE_BANNERS]: isE2E() || isDev(),
	[FeatureFlag.EXTENSION_REMOTE_BANNERS_TTL]: 24 * 60 * 60 * 1000,
	[FeatureFlag.REMOTE_WELCOME_BANNERS]: isE2E() || isDev(),
	[FeatureFlag.DIRAC_RECOMMENDED_MODELS_UPSTREAM]: false,
	[FeatureFlag.EXTENSION_DIRAC_MODELS_ENDPOINT]: false,
	[FeatureFlag.OPENAI_RESPONSES_WEBSOCKET_MODE]: false,
}

export const FEATURE_FLAGS = Object.values(FeatureFlag)
