import { NativeSandboxError } from "./types"

export const MACOS_ENVIRONMENT_MAX_BYTES = 1024 * 1024
export const MACOS_ENVIRONMENT_MAX_ENTRIES = 1024

/** macOS /bin/sh is Bash-compatible; discovery probes this protocol before advertising support.
 * No eval, data interpolation, command substitution or env values in process argv.
 * FD3 is a dedicated private control pipe; workload stdin remains independent.
 */
export const MACOS_ENVIRONMENT_BOOTSTRAP = `
unset PATH PWD OLDPWD SHLVL _
IFS= read -r -d '' __DIRAC_ENV_COUNT <&3 || exit 125
case "$__DIRAC_ENV_COUNT" in ''|*[!0-9]*) exit 125;; esac
[ "$__DIRAC_ENV_COUNT" -le 1024 ] || exit 125
while [ "$__DIRAC_ENV_COUNT" -gt 0 ]; do
  IFS= read -r -d '' __DIRAC_ENV_ENTRY <&3 || exit 125
  __DIRAC_ENV_NAME=\${__DIRAC_ENV_ENTRY%%=*}
  case "$__DIRAC_ENV_NAME" in ''|[0-9]*|*[!A-Za-z0-9_]*|__DIRAC_ENV_*) exit 125;; esac
  unset "$__DIRAC_ENV_NAME" || exit 125
  export "$__DIRAC_ENV_ENTRY" || exit 125
  __DIRAC_ENV_COUNT=$((__DIRAC_ENV_COUNT - 1))
done
unset __DIRAC_ENV_COUNT __DIRAC_ENV_ENTRY __DIRAC_ENV_NAME
exec 3<&-
exec /usr/bin/env -u SHLVL -- "$@"
`

export function macOSEnvironmentPayload(env: NodeJS.ProcessEnv): Buffer {
	const entries: string[] = []
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith("__DIRAC_ENV_") || value.includes("\0")) {
			throw new NativeSandboxError("Invalid workload environment entry.", "invalid-policy", "before-launch")
		}
		// Shell readonly/array variables cannot faithfully represent arbitrary workload data.
		if (
			/^BASH/.test(name) ||
			["SHELLOPTS", "SHLVL", "EUID", "PPID", "UID", "DIRSTACK", "FUNCNAME", "GROUPS", "PIPESTATUS"].includes(name)
		) {
			throw new NativeSandboxError(
				"Workload environment requests a reserved bootstrap-shell variable.",
				"invalid-policy",
				"before-launch",
			)
		}
		entries.push(`${name}=${value}`)
	}
	if (entries.length > MACOS_ENVIRONMENT_MAX_ENTRIES)
		throw new NativeSandboxError("Workload environment exceeds the supported entry count.", "invalid-policy", "before-launch")
	const payload = Buffer.from(`${entries.length}\0${entries.join("\0")}${entries.length ? "\0" : ""}`)
	if (payload.length > MACOS_ENVIRONMENT_MAX_BYTES)
		throw new NativeSandboxError("Workload environment exceeds the supported byte size.", "invalid-policy", "before-launch")
	return payload
}
