import { endianness } from "node:os"
import { type AvailableNativeSandbox, NativeSandboxError, type NativeSandboxRequest } from "./types"

export const BUBBLEWRAP_VERSION = "0.12.0"
export const DEFAULT_SEATBELT_POLICY = "(version 1) (allow default)"

/** Linux UAPI: BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW).
 * This intentionally denies NO syscalls; it exercises filter installation, not isolation.
 * Native-endian struct sock_filter is u16 code, u8 jt, u8 jf, u32 k.
 */
export function permissiveSeccompFilter(): Buffer {
	const filter = Buffer.alloc(8)
	if (endianness() === "LE") {
		filter.writeUInt16LE(0x06, 0)
		filter.writeUInt32LE(0x7fff0000, 4)
	} else {
		filter.writeUInt16BE(0x06, 0)
		filter.writeUInt32BE(0x7fff0000, 4)
	}
	return filter
}

/** Structured argv only: command text, when present, remains an argument to its original shell. */
export function defaultNativeArguments(capability: AvailableNativeSandbox, request: NativeSandboxRequest): string[] {
	if (capability.backend === "seatbelt") {
		return ["-p", DEFAULT_SEATBELT_POLICY, request.executable, ...request.args]
	}
	if (capability.backend !== "bubblewrap")
		throw new NativeSandboxError(
			"This backend cannot represent permissive Default execution.",
			"invalid-policy",
			"before-launch",
		)
	return [
		"--dev-bind",
		"/",
		"/",
		"--unshare-pid",
		"--die-with-parent",
		"--seccomp",
		"3",
		"--chdir",
		request.cwd,
		"--",
		request.executable,
		...request.args,
	]
}
