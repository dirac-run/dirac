/**
 * Environment check functions.
 * Centralizes the 20+ scattered `process.env.IS_DEV === "true"` etc. patterns.
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
