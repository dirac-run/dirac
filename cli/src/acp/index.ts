/**
 * Entry point for ACP (Agent Client Protocol) mode.
 *
 * When the CLI is invoked with `--acp`, this module sets up the ACP connection
 * and runs Dirac as an ACP-compliant agent communicating over stdio.
 *
 * This module exports:
 * - `DiracAgent` - Decoupled agent for programmatic use (no stdio dependency)
 * - `AcpAgent` - Thin wrapper that bridges stdio connection to DiracAgent
 * - `DiracSessionEmitter` - Typed EventEmitter for per-session events
 * - `runAcpMode` - Function to run Dirac in stdio-based ACP mode
 *
 * @module acp
 */

import { AgentSideConnection } from "@agentclientprotocol/sdk";
import { Logger } from "@/shared/services/Logger";
import { initAcpFileLogger } from "../utils/acp-file-logger.js";
import { AcpAgent } from "./AcpAgent.js";
import { listenForDetachedAcp } from "./detachedServer.js";
import {
  createResilientNdJsonStream,
  nodeToWebReadable,
  nodeToWebWritable,
} from "./streamUtils.js";

// Re-export classes for programmatic use
export { DiracAgent } from "../agent/DiracAgent.js";
export { DiracSessionEmitter } from "../agent/DiracSessionEmitter.js";
export type {
  AcpAgentOptions,
  AcpSessionState,
  DiracAgentOptions,
  DiracSessionEvents,
  PermissionHandler,
} from "../agent/types.js";
export { AcpAgent } from "./AcpAgent.js";

/** Original console methods for restoration if needed */
const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  debug: console.debug,
  error: console.error,
};

/**
 * Redirect all console output to stderr.
 *
 * In ACP mode, stdout is reserved exclusively for JSON-RPC communication.
 * All logging must go to stderr to avoid corrupting the protocol stream.
 */
function redirectConsoleToStderr(): void {
  console.log = (...args) => console.error(...args);
  console.info = (...args) => console.error(...args);
  console.warn = (...args) => console.error(...args);
  console.debug = (...args) => console.error(...args);
  // console.error already goes to stderr
}

/**
 * Restore console methods to their original behavior.
 */
export function restoreConsole(): void {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.debug = originalConsole.debug;
  console.error = originalConsole.error;
}

export interface AcpModeOptions {
  /** Path to Dirac configuration directory */
  config?: string;
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** API provider explicitly selected at process startup */
  provider?: string;
  /** Model explicitly selected at process startup */
  model?: string;
  /** Additional runtime hooks directory */
  hooksDir?: string;
  /** Enable verbose/debug logging to stderr */
  verbose?: boolean;
  /** Unix socket path for reconnectable detached ACP mode. */
  listen?: string;
}

/**
 * Run Dirac in ACP mode.
 *
 * This function:
 * 1. Redirects console output to stderr (stdout reserved for JSON-RPC)
 * 2. Sets up the ndJsonStream for stdio communication
 * 3. Creates the AgentSideConnection with our AcpAgent factory
 * 4. Initializes the CLI infrastructure (StateManager, Controller, etc.)
 * 5. Keeps the process alive until the connection closes
 *
 * @param options - Configuration options for ACP mode
 */
export async function runAcpMode(options: AcpModeOptions = {}): Promise<void> {
  redirectConsoleToStderr();
  initAcpFileLogger();

  // Opt-in debug tap: mirror all Logger output to stderr when DIRAC_ACP_DEBUG is set.
  // In ACP mode stdout is reserved for JSON-RPC, so internal logs otherwise go to an
  // in-memory output channel and are invisible. This makes them visible on stderr
  // (captured by the probe's stderr log) for diagnosing the ACP integration.
  if (process.env.DIRAC_ACP_DEBUG) {
    Logger.subscribe((msg) => originalConsole.error(`[LOG] ${msg}`));
  }

  if (options.listen) {
    await runDetachedAcpMode(options);
    return;
  }

  const outputStream = nodeToWebWritable(process.stdout);
  const inputStream = nodeToWebReadable(process.stdin);
  const stream = createResilientNdJsonStream(outputStream, inputStream);
  let agent: AcpAgent | null = null;

  new AgentSideConnection((conn) => {
    agent = new AcpAgent(conn, {
      debug: Boolean(options.verbose),
      diracDir: options.config,
      cwd: options.cwd,
      provider: options.provider,
      model: options.model,
      hooksDir: options.hooksDir,
    });
    return agent;
  }, stream);

  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) {
      // Force exit on second signal
      process.exit(1);
    }
    isShuttingDown = true;
    try {
      await agent?.shutdown();
      restoreConsole();
    } catch (error) {
      Logger.error("[ACP] Error during shutdown:", error);
    }

    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process alive
  // The ndJsonStream will handle stdin events automatically.
  // We need to ensure the process doesn't exit while waiting for input.
  process.stdin.resume();

  // Handle stdin end (client disconnected)
  process.stdin.on("end", shutdown);

  // Handle stdin errors
  process.stdin.on("error", async (error) => {
    Logger.error("[ACP] stdin error:", error);
    await shutdown();
  });

  Logger.info("[ACP] Process is now listening for ACP requests on stdin");
}

async function runDetachedAcpMode(options: AcpModeOptions): Promise<void> {
  const server = await listenForDetachedAcp({
    debug: Boolean(options.verbose),
    diracDir: options.config,
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
    hooksDir: options.hooksDir,
    socketPath: options.listen!,
  });
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) {
      process.exit(1);
    }
    isShuttingDown = true;
    try {
      await server.close();
      restoreConsole();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  Logger.info(`[ACP] Detached process is listening on ${options.listen}`);
}
