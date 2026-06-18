/**
 * Shared initialization for the host-agnostic singletons that the Task code
 * path depends on: DiracEndpoint, StateManager, ErrorService.
 *
 * Both the standalone CLI entrypoint (initializeCli) and the ACP entrypoint
 * (DiracAgent.initialize) must call this; otherwise provider errors deep in
 * the task loop throw "ErrorService not setup" and get silently swallowed,
 * leaving clients to hit the 60s idle watchdog instead of seeing the real
 * failure. Routing both modes through one function prevents that drift.
 *
 * HostProvider is NOT initialized here — its wiring differs per mode (CLI
 * uses local stdio providers; ACP wraps host bridge calls over the
 * connection) and must be set up by the caller before tasks run.
 */

import { DiracEndpoint } from "@/config.js"
import { StateManager } from "@/core/storage/StateManager.js"
import { ErrorService } from "@/services/error/ErrorService.js"
import type { StorageContext } from "@/shared/storage/storage-context"

export interface CoreServicesInitOptions {
	extensionDir: string
	storageContext: StorageContext
}

export async function initCoreServices(opts: CoreServicesInitOptions): Promise<void> {
	await DiracEndpoint.initialize(opts.extensionDir)
	await StateManager.initialize(opts.storageContext)
	await ErrorService.initialize()
}
