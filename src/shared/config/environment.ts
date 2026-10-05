import os from "os"
import path from "path"

/**
 * Environment check functions.
 * Centralizes the scattered `process.env.X` reads — one typed getter per variable.
 * Uses functions (not frozen properties) so tests can mutate process.env between cases.
 */

// IS_DEV is set to "true" by the build system for development builds.
export const isDev = (): boolean => process.env.IS_DEV === "true"

// E2E_TEST or IS_TEST is set by the test runner.
export const isTest = (): boolean => process.env.E2E_TEST === "true" || process.env.IS_TEST === "true"

// E2E_TEST only — narrower than isTest(). Use for flags that must NOT flip under unit-test runs.
export const isE2E = (): boolean => process.env.E2E_TEST === "true"

// DIRAC_ENVIRONMENT is set to "local" for local development.
export const isLocal = (): boolean => process.env.DIRAC_ENVIRONMENT === "local"

// True if running in any development mode (dev build or local env).
export const isDevelopmentMode = (): boolean => isDev() || isLocal()

// MULTI_ROOT_TRACE="true" (or any dev build) traces single-root path operations for migration planning.
export const isMultiRootTraceEnabled = (): boolean =>
	process.env.MULTI_ROOT_TRACE === "true" || process.env.NODE_ENV === "development"

// DIRAC_DIR overrides the dirac home dir; defaults to ~/.dirac. Read dynamically so tests can isolate.
export const diracHomeDir = (): string => process.env.DIRAC_DIR || path.join(os.homedir(), ".dirac")

// User login shell for terminal placeholders (SHELL env var, bash fallback applied by caller if needed).
export const userShell = (): string | undefined => process.env.SHELL

// User home directory (HOME env var).
export const homeEnvDir = (): string | undefined => process.env.HOME

// DEBUG_HOOKS="true" enables hook-discovery debug logging.
export const isHooksDebugEnabled = (): boolean => process.env.DEBUG_HOOKS === "true"

// DEV_WORKSPACE_FOLDER overrides the recorder's workspace folder (dev only).
export const devWorkspaceFolder = (): string => process.env.DEV_WORKSPACE_FOLDER ?? process.cwd()

// GRPC_RECORDER_FILE_NAME overrides the recorded-session file name.
export const grpcRecorderFileName = (): string | undefined => process.env.GRPC_RECORDER_FILE_NAME

// GRPC_RECORDER_ENABLED="true" turns on gRPC session recording.
export const isGrpcRecorderEnabled = (): boolean => process.env.GRPC_RECORDER_ENABLED === "true"

// GRPC_RECORDER_TESTS_FILTERS_ENABLED="true" enables recorder test filters.
export const isGrpcRecorderTestFiltersEnabled = (): boolean => process.env.GRPC_RECORDER_TESTS_FILTERS_ENABLED === "true"

// DIRAC_WRITE_PROMPT_ARTIFACTS=1|true|yes writes the assembled system prompt to disk (or IS_DEV build).
export const isPromptArtifactsEnvEnabled = (): boolean => {
	const flag = process.env.DIRAC_WRITE_PROMPT_ARTIFACTS?.toLowerCase()
	return flag === "1" || flag === "true" || flag === "yes" || isDev()
}

// DIRAC_PROMPT_ARTIFACT_DIR overrides the prompt-artifact output directory.
export const promptArtifactsDir = (): string | undefined => process.env.DIRAC_PROMPT_ARTIFACT_DIR?.trim()

// DIRAC_COMMAND_PERMISSIONS carries the command-permission rule JSON.
export const commandPermissionsEnv = (): string | undefined => process.env.DIRAC_COMMAND_PERMISSIONS

// npm_package_version is injected by npm at script-run time; absent under bundled builds.
export const npmPackageVersion = (): string => process.env.npm_package_version || "1.0.0"
