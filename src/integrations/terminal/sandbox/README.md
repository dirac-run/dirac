# Native command sandbox: supported policy and host limits

Default remains permissive and provides **no meaningful isolation**. Sandbox is **Off by default**; Off uses ordinary command execution for role-assigned commands, while an explicitly saved task-local restriction blocks when Off. A configured profile is enforceable only if the command-executing host's native backend probe and profile validation both succeed. Unsupported policies are rejected, never translated to Default. This covers command execution and descendants only—not direct host tools, custom tools, services, or code those trusted components execute.

## Execution-host support matrix

The UI machine is not authoritative: helper and feature probes run on the host that executes commands. “Supported” means a policy can be compiled for the listed mechanism, not that every machine/profile has passed native enforcement verification. macOS restrictions are advertised only after the bounded on-host conformance probe succeeds. Windows requires a matching packaged MXC helper and successful native PSEC/feature probe.

| Execution host | Native mechanism | Restrictive profile subset | Rejected / conditional policies | Temporary storage | Explicit task-local policy |
| --- | --- | --- | --- | --- | --- |
| Linux x86-64 | Bubblewrap 0.12.0 + generated seccomp | `selected` and `broad-read`; workspace RO/RW; explicit RO/RW/cache and blocked paths; network allow/deny | Other architectures and invalid/unrepresentable path or policy rules | Fresh per-launch private tmpfs | Supported on Linux x86-64 |
| macOS x64/arm64 | OS `/usr/bin/sandbox-exec` (Seatbelt) | `selected` and `broad-read`; workspace RO/RW; explicit RO/RW/cache and blocked paths; IP network allow/deny | Dynamic-loader env variables; local IPC/Mach access; unsafe symlink/path cases; explicit model-authored task-local narrowing is not supported (volume case/alias equivalence is not validated) | Unique per-launch host-backed directory, no quota | Unsupported; configured inherited main/subagent profiles remain usable |
| Windows x64/arm64 | Packaged native MXC ProcessContainer/PSEC helper | `selected` only; workspace RO/RW; explicit RO/RW/cache and blocked paths; network deny, or allow only if native ingress probe succeeds | `Default`, `broad-read`, root mappings, RO grants nested under RW, UNC/device/ADS/DOS-alias/non-ASCII paths, reparse points and case-sensitive directories | Unique per-launch host-backed directory, no quota | Selected-location narrowing only, with host path identity revalidated |

Windows does not emulate unsupported policy via AppContainer, DACL/ACL mutation, a sandbox account, Windows Sandbox, WSL, or a VM. Current MXC mapping cannot represent Default's permissive host-wide intent; use Off for ordinary unsandboxed execution or select a representable restrictive profile. Unsupported-policy errors are not fallback-eligible.

## Profiles and capability editor

CLI and VS Code expose the same capability choices with per-row radio options, not a shared read/write scale. Disabled settings hide inactive controls; enabled settings expose assignments and profiles. Routine diagnostics and fallback remain behind disclosure controls; current failures remain visible. `SandboxCapabilities.ts` maps the editor to the underlying policy without dropping advanced fields.

| Built-in ID | Name | Workspace | Network |
| --- | --- | --- | --- |
| `default` | Default | Unrestricted | Allowed |
| `builtin-workspace` | Workspace | Read/write | Allowed |
| `builtin-offline-workspace` | Offline workspace | Read/write | Blocked |
| `builtin-read-only` | Read-only | Read-only | Blocked |


The built-in names describe requested intent; runtime paths and enforcement differ by host. Windows adapts genuine built-ins to the execution host's trusted temp parent, but does not rewrite saved custom paths for another OS. The Windows backend explicitly rejects Default, broad-read/root mappings and RO carveouts nested within RW access rather than weakening them.

Restrictive built-ins use each backend's explicit selected runtime baseline, workspace grants and PATH/HOME/LANG passthrough; no home-directory, cache or credential grant is implicit. Linux uses fresh `/tmp` tmpfs; macOS and Windows use unique host-backed temporary directories with no quota. Workspaces and grants overlapping the temporary parent are rejected. Existing profiles and assignments are not silently migrated; built-in customization creates a saved copy.

## Task-local subagent policies

The root model can discover the profile catalog through `subagents` list and attach an optional `sandbox` object to a creation assignment, for example:

```json
{
  "type": "default",
  "task_header": "Review changes",
  "task_description": "Review the patch without modifying the workspace.",
  "sandbox": {
    "profileId": "builtin-read-only",
    "restrictions": { "network": "blocked" }
  }
}
```

The profile ID is optional when restrictions are supplied. Omitted fields retain the selected profile's values; `readablePaths`, `writablePaths`, and `cachePaths` replace those explicit grant lists. The host rejects access exceeding the user-selected subagent profile. Canonical filesystem grant/block boundaries, network, environment, and private temp are checked—not merely string prefixes or the model's stated intent.

The resolved policy, host policy identity and original path identities are durable tasklet configuration, not mutable global settings. Reopen/launch revalidates them against current user authority and the execution host. Explicit policies require enabled native sandboxing and never authorize unsandboxed fallback. Changes to settings or host semantics may block an incompatible task but cannot silently broaden its saved policy. macOS does not support explicit model-authored delegated narrowing because volume-dependent case/alias equivalence is not proven; configured inherited main/subagent restrictive profiles remain usable. Windows task policies are limited to validated selected-location path semantics. Existing command approvals still apply.

## Contract and ownership

`prepareNativeSandbox({ executable, args, cwd, env, policy, context })` takes either `{id:'default'}` or a validated custom profile. Custom requests require trusted `context.workspaceRoots` and nonempty `context.protectedPaths`, resolved by the host, not the command. Pass the actual storage authority directories (including configurable data/workspace storage), not assumed `~/.dirac` strings. Preparation snapshots policy/argv/env and pins filesystem sources.

The returned `{ backend, policy, spawn(), dispose(), terminate(child) }` keeps existing terminal supervision. After preparation the caller performs final cancellation/configuration/command-authority checks immediately before synchronous, single-use `spawn()`. Call idempotent synchronous `dispose()` on **every** prelaunch guard/cancellation failure; spawn also releases preparation descriptors after inheriting them. Disposed/consumed launches cannot replay. No wrapper shell command is built.

Cancellation is backend-owned and does not assume every descendant stopped merely because the leader exited. Linux's private PID namespace plus Bubblewrap monitor/init and `--die-with-parent` own descendants beyond the original process group. Seatbelt restrictions inherit across fork/exec, but macOS cleanup can kill only the original process group; escaped-session descendants may survive. Leader exit with undrained pipes or cancellation reports uncertain cleanup and can stop output draining; it must not claim complete cleanup. Windows MXC reports success only after its helper's settlement proof; helper failure or timeout remains uncertain. No persistent workers or silent replay.

Capability discovery is cached per host process. Restart after replacing helpers/changing host configuration. The Default benign probe does not certify that every custom namespace/layout can launch. Recognized missing-helper/prelaunch setup errors can carry `fallbackEligible`, which is not authorization: the caller must require the user's explicit fallback setting. Invalid policy/path/control/ABI, uncertain FD delivery, runtime failures and policy denials are never fallback reasons. No fallback occurs inside this launcher; never replay after spawn.

## Custom filesystem semantics

- `base:'broad-read'` exposes host filesystem read-only, then explicit writable grants. This is **not broad host-write**. `base:'selected'` starts empty, adds the visible runtime baseline below, then workspace/extra grants. Existing directory/file sources only; missing user sources are configuration errors, not ignored rules.
- All trusted workspace roots receive the chosen read-only/read-write mode. Extra `readable`, `writable`, and `caches` grants are explicit (caches are existing RW directories; no automatic package-cache discovery). No private workspace copies.
- Path syntax is host-sensitive: Linux/macOS accept POSIX absolute and `~/` paths; Windows accepts ASCII drive-absolute paths only. UNC/device paths, alternate streams, DOS aliases, reparse points and case-sensitive directories are rejected on Windows; macOS rejects unsafe mutable symlink roots and does not assume volume case/alias equivalence. No workspace placeholders, relative paths, shell expansion, globs or inferred grants. Canonical identity and grant conflicts are checked by each host backend; Linux additionally pins mount sources with `O_PATH`/Bubblewrap bind-FD. Preparation races fail closed.
- Positive grants and blocked/protected precedence are backend-specific. Linux supports nested RO/RW overrides. Seatbelt supports explicit nested RO exceptions with ancestor unlink guards, but its native probe gates restrictive availability. MXC deny precedence cannot represent an RO carveout under a writable grant; such Windows profiles are rejected, not flattened.
- Trusted configuration authority paths must remain denied; writable overlaps are rejected. Linux masks protected paths last; macOS uses exclusions and rename guards; Windows passes explicit deny paths to PSEC and pins/revalidates identities. These are command-policy boundaries, not inode-wide host confidentiality guarantees.
- Temporary storage differs by backend: Linux mounts a fresh private tmpfs at existing `temporaryDirectory`; macOS and Windows create unique host-backed directories under the configured temp parent and set temp environment variables. Host-backed temp has no quota; cleanup is required and failures are surfaced.
- Linux-specific: `/proc` is a fresh private-PID procfs, `/dev` minimal native devices, and `/sys` inaccessible read-only empty storage. Custom Linux launches use private user/PID/IPC namespaces, prevent further user namespaces, drop capabilities, establish no-new-privileges, and start a detached/new session. These namespace/device semantics do not describe Seatbelt or MXC.

### Visible selected-mode readable baseline

Exported `LINUX_SELECTED_READABLE_BASELINE`:

```
/usr /bin /sbin /lib /lib64
/etc/ld.so.cache /etc/hosts /etc/resolv.conf /etc/nsswitch.conf
/etc/ssl/certs /etc/pki
```

Only existing baseline entries are added. Canonical symlink targets are mounted and baseline aliases reconstructed; no blanket `/etc`, home, `/run`, host `/tmp`, or hidden automatic toolchain grants. User toolchains outside the baseline (for example a Node installation in home) require an explicit readable location. Baseline-block conflicts may reject the profile or make the chosen executable unavailable, never reopen paths silently. Distro/toolchain compatibility beyond focused tests is not established.


macOS selected mode grants only existing entries from `MACOS_SELECTED_READABLE_BASELINE`: `/System`, `/usr`, `/bin`, `/sbin`, `/Library/Apple`, and selected concrete `/private/etc` network/certificate files; it does not grant home, SSH credentials, all of `/etc`, or all of `/Library`. Windows selected mode derives its runtime baseline from the executing host's `SystemRoot`, `ProgramFiles`, and `ProgramFiles(x86)` paths when present. The Windows environment starts from explicit system runtime variables, then selected passthrough and overrides; it does not inherit the full host environment.

## Environment, networking, and native filter

Workload environment starts from selected passthrough names and explicit overrides plus each platform's required runtime baseline; it is not a wholesale copy of the host environment. Linux gives Bubblewrap a clean trusted bootstrap environment and sends workload variables over a private FD. macOS uses a fixed shell bootstrap inside Seatbelt and a private FD; dynamic-loader and reserved bootstrap-shell variables are rejected. Windows supplies the explicit Windows runtime baseline and rejects case-insensitive environment collisions or runtime-variable overrides. Secret values should not be stored in plaintext profile overrides; launcher diagnostics must not expose values.

Network semantics are native and not identical. Linux `deny` uses a private network namespace; `allow` retains host networking. It does not block AF_UNIX sockets exposed through filesystem grants. macOS `deny` is the default; `allow` grants IP networking only, while Mach lookup and local socket use remain denied. Windows uses PSEC network deny or allow, and allow is rejected unless the host probe reports required ingress/loopback support. These controls do not promise that every platform-specific IPC/local-service channel is blocked. No destination filtering, resource limits, or optional network presets are implied.

Custom seccomp is an architecture-aware generated 328-byte filter (x86-64 only), not Phase1's allow-all filter. It rejects other ABIs, denies namespace/mount changes, ptrace/process-memory/FD-import operations and terminal-injection ioctls; clone3 and modern mount APIs return ENOSYS, ordinary fork/threads still work. It is a bounded escape-hardening policy, **not a universal syscall allowlist or complete kernel attack-surface sandbox**. The runtime does not compile filters or depend on libseccomp/native helpers beyond installed Bubblewrap. Default still uses its original single unconditional allow instruction and retains host `/proc`, devices/filesystem and networking.

### Filter provenance and reproduction

- Namespace/mount/clone/ioctl rule design references [Flatpak **1.16.1** `setup_seccomp`](https://github.com/flatpak/flatpak/blob/1.16.1/common/flatpak-run.c). This is a selected Dirac policy, not a copy or claim to implement Flatpak's full policy. Additional process-memory/FD import restrictions preserve the host-process boundary. Syscall numbers and ABI checks are generated by libseccomp, not handwritten TS tables.
- [`libseccomp 2.6.0 seccomp_export_bpf`](https://github.com/seccomp/libseccomp/blob/v2.6.0/doc/man/man3/seccomp_export_bpf.3) generates kernel-loadable BPF. `seccomp-export.c` checks version/native architecture and treats unknown rules/export failures as fatal. No libseccomp source/header is redistributed here; build uses the system LGPL library.
- Build used Debian amd64 `libseccomp-dev=2.6.0-2` extracted to `/tmp`, **not installed**. Downloaded Debian package SHA-256: `12326d36a510cafeda0f33d0a97439f7812e1e56128c4b79091142ce5cf07766`.
- Exported BPF SHA-256: `1c0712a0720f752c8a79bf70bfc5c90e449bff91597f92528e20ecadb6e6ce18`. Embedded base64 lives in `linuxSeccomp.generated.ts`, bundled with CLI/extension JS. No external BPF packaging path is needed.

Rebuild on Linux x86-64 with libseccomp 2.6.0 development headers/library:

```sh
cc -Wall -Wextra -Werror seccomp-export.c -lseccomp -o /tmp/dirac-seccomp-export
/tmp/dirac-seccomp-export > /tmp/linux-x64.bpf
sha256sum /tmp/linux-x64.bpf
base64 -w0 /tmp/linux-x64.bpf
```

Review generator changes, replace generated base64/hash, and rerun ABI/escape/compatibility tests together. Do not claim arm64/32-bit support from these bytes.

## Remaining platform/fidelity limits

**Bubblewrap workload signal fidelity remains incomplete:** workload signal `n` appears as exit code `128+n`; the returned ChildProcess signal describes Bubblewrap, not necessarily its workload. No signal is guessed from numeric exit status. Broader compatibility/performance/shutdown measurements and a signed/distributed helper strategy remain open.

macOS uses OS-provided `/usr/bin/sandbox-exec` with deny-default Seatbelt rules for restrictive profiles. Its runtime capability probe runs a bounded native fixture for filesystem, protected/blocked paths, rename/hardlink/symlink behavior, environment bootstrap, IP networking and local socket denial; if any check fails, restrictive profiles stay unavailable while permissive Default may remain available. The probe is a host readiness gate, not proof for every workspace layout or a substitute for native conformance tests. Current Linux-host tests exercise compiler/preparation and lifecycle fakes—not macOS enforcement. No native macOS enforcement run is claimed. Seatbelt policy applies to escaped descendants, but cleanup cannot guarantee their termination; cancellation reports uncertainty rather than a stopped claim.

Windows uses the pinned native MXC ProcessContainer/PSEC helper only. Its probe validates artifact hash/manifest, protocol/revision, native PSEC startup/close, FS_DENY and feature support. If the packaged helper or required native features are missing, Windows policies are unavailable; there is no legacy fallback. Linux-host translation/protocol tests are not Windows enforcement verification, and no native Windows enforcement run is claimed.

Windows helper build/package setup (Windows MSVC host): run `node scripts/build-windows-mxc.mjs x64` or `node scripts/build-windows-mxc.mjs arm64`. The script uses locked Cargo dependencies and writes the helper, manifest and notices under `native/windows-mxc/artifacts/<arch>/`; packaging copies validated available architecture artifacts into `<bundle>/native/windows-mxc/<arch>/`. Release packaging can require both architectures with `DIRAC_REQUIRE_WINDOWS_MXC=1`. Helper builds require a matching Windows MSVC developer host; this Linux workspace cannot build or verify the native backend. `scripts/windows-mxc-artifacts.mjs` checks helper identity/integrity before packaging. No VM, WSL or legacy account/ACL fallback is used.

The build targets are `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`. The extension and CLI esbuild asset hooks copy verified artifacts; existing npm/standalone packaging retains that bundle directory. Each artifact includes the executable, SHA-256/version/protocol/MXC-revision manifest, original MXC/Apache notices, and a generated locked-dependency license bundle. A missing original dependency notice fails the helper release build for review. Compiler identity and source hashes are recorded, but bit-for-bit reproducibility and code signing are not claimed. A Linux cross-check was attempted with `cargo check --locked --manifest-path native/windows-mxc/Cargo.toml --target x86_64-pc-windows-gnu`; it stopped with E0463 because that Rust standard-library target is not installed (only the Linux target is available, and no MinGW compiler is installed). Consequently the Windows-only Rust module is source-reviewed, not Windows-target compilation-verified here.

Primary references: Bubblewrap [v0.12.0 `bwrap.xml`](https://github.com/containers/bubblewrap/blob/v0.12.0/bwrap.xml), [`bubblewrap.c`](https://github.com/containers/bubblewrap/blob/v0.12.0/bubblewrap.c), [README](https://github.com/containers/bubblewrap/blob/v0.12.0/README.md); Linux [v6.12 seccomp/filter UAPI](https://github.com/torvalds/linux/tree/v6.12/include/uapi/linux); Seatbelt launch reference [sandbox-runtime f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889](https://github.com/anthropic-experimental/sandbox-runtime/blob/f7a0f19fd3b4437bcf808f9c18c1f73e9f1a9889/src/sandbox/macos-sandbox-utils.ts); Windows uses the pinned [Microsoft MXC source revision](https://github.com/microsoft/mxc/tree/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2) through the Rust helper, not a Node SDK.

## Focused verification

Verified on a Linux x86-64 host (kernel 6.12.107, Bubblewrap 0.12.0): Default/custom launches, output, cwd/env/argv/status, signal ambiguity, descendant cleanup, sibling-safe cancellation, multi-root RO/RW, explicit grants/blocks, protected paths, tmpfs, env filtering, network allow/deny, private proc, syscall restrictions, fork/threads, validation and descriptor disposal. This verification does not establish macOS or Windows enforcement.

macOS test coverage authored in this tree includes pure Seatbelt compiler/path/environment tests (`macosPolicy.test.ts`, `macosEnvironment.test.ts`), fake-process lifecycle tests (`processLifecycle.test.ts`), and native-host tests (`macosNative.test.ts`) for restricted launch, protected/RO/temp behavior, escaped descendants and sibling-safe cancellation. `macosProbe.ts` performs a bounded native conformance check on the executing Mac before enabling restrictive profiles. The native-host tests explicitly skip as UNVERIFIED off macOS. No native macOS execution was available/verified in this investigation; supported Macs still require probe success, and broader host/filesystem/toolchain coverage remains outstanding.

Windows coverage includes artifact integrity/copy tests (`scripts/windows-mxc-artifacts.test.mjs`), portable policy/protocol tests (`windowsSandbox.test.ts`), and Rust helper protocol tests. These do not establish Windows enforcement. The Windows executable has not been built or run on a Windows host here. The current tree has no built helper artifact; runtime Windows capability remains unavailable until a matching artifact is produced, packaged, hash-verified and its native PSEC/feature probe succeeds. Windows host enforcement, process containment, cancellation/cleanup and both architectures still require native Windows validation. A successful syntax/translation/protocol test is not enforcement evidence.

Eight native Windows cases are authored in `src/integrations/terminal/sandbox/windowsSandbox.native.test.ts`: command/output/workload exit, protected configuration and read-only denial, explicit environment, loopback network denial, EOF descendant cancellation without killing a host sibling, and helper crashes before the request, immediately after start, and with live descendants. They explicitly skip off Windows or without opt-in/helper prerequisites. On a suitable Windows host, set `DIRAC_WINDOWS_MXC_NATIVE_TESTS=1` and run that focused Mocha file; the default executable is `native/windows-mxc/artifacts/<arch>/dirac-windows-mxc.exe`, overridable for tests only with `DIRAC_WINDOWS_MXC_HELPER`. A host lacking actual PSEC/FS_DENY reports a skip, not a pass. The exact MXC create-suspended/pre-inner-job-assignment crash phase is covered by structural outer-job-before-spawn ordering only, not native fault injection. Junction/case-sensitivity metadata mutation after pinning, broader path alias races, restrictive parent-job compatibility, and both-architecture enforcement remain unverified; these eight authored cases do not constitute complete native conformance.

Native tests skip with a reason when prerequisites are absent; a skip is not verification.

```sh
TS_NODE_PROJECT=./tsconfig.unit-test.json TS_NODE_TRANSPILE_ONLY=1 \
  npx mocha --node-option no-experimental-strip-types \
  --require ts-node/register/transpile-only \
  'src/integrations/terminal/sandbox/*.test.ts' --timeout 15000
```
