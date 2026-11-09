# Workspace sandbox

In **Settings → Open Terminal → Sandbox**, turn on **Enable sandbox**, choose an
existing local folder, then select **Apply and restart**. Wait for **Sandbox active**
before giving the agent work. Existing installations start with this option off.

All Open WebUI connections share the selected folder. Open Terminal and commands
it launches can read, change, and delete files there. They also receive private
temporary storage and read access to required program files. Other personal files
are outside the sandbox's allowed paths. This is access control, not a backup or
an undo feature.

Sandboxed commands cannot use the network. Browser automation, desktop control,
and the direct HTTP endpoint are disabled. Tether itself still connects to Open
WebUI and forwards authenticated requests through a local IPC endpoint. Previous
browser, desktop, and HTTP preferences are retained for when sandboxing is off.
The separately labelled **Host shell (unrestricted)** is a user-operated shell and
does not run inside this sandbox.

If the device, filesystem, or launch checks cannot enforce the policy, Open Terminal
stays stopped. Tether never silently starts an unrestricted replacement. The UI
distinguishes an enabled setting from an active, verified process.

## Supported mechanisms

| Platform | Enforcement                                        | Availability                                                                                                      |
| -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| macOS    | Seatbelt applied before Python starts              | Requires a working system `sandbox-exec`; each launch runs containment checks                                     |
| Linux    | Not available                                      | Tether remains available on Linux without workspace sandboxing                                                    |
| Windows  | MXC ProcessContainer with native filesystem denial | Requires the SDK's BaseContainer, filesystem-deny, and UI capabilities; no administrator setup or weaker fallback |

No Docker, Podman, WSL, VM image, or separately installed container engine is
required. Unsupported Windows devices report that sandboxing is unavailable.
Linux does not include a sandbox backend. If an enabled sandbox setting is copied
to Linux, Open Terminal stays stopped until the user explicitly disables it.

Use a dedicated folder on a local APFS/HFS+ or fixed NTFS volume. Home roots, filesystem roots, Tether's own files, network locations,
outward/broken symlinks, hard links, nested mounts, and special files are rejected.
Validation and operating-system enforcement both matter: a directory picker alone
does not provide containment.

## Changes and process lifetime

Applying a changed workspace disconnects the old Open Terminal services, cancels
pending starts, stops their process groups or containers, cleans up temporary
storage, saves the setting, and starts fresh services. A policy revision prevents
a stale service from being exposed after a change. Failed cleanup blocks further
starts instead of reusing uncertain state.

Seatbelt is inherited by descendants but has no container-wide termination handle.
A macOS command that detached from its process group can outlive the Open Terminal
service and retain its **original** workspace access. Restarting Tether alone is
not proof that such a command exited. Stop those commands, or reboot, when complete
revocation of an old workspace is required. Programs launched before sandboxing
was enabled can likewise retain their original access. The settings UI calls this
out before applying changes.

Normal shutdown removes session storage. An application or machine crash can leave
temporary directories behind; there is no automatic crash-recovery garbage
collector. Workspace files persist. A malicious host application or administrator
changing mounts, links, or workspace contents concurrently is outside this threat
model. Sandboxing also does not prevent destructive actions within the workspace
or resource exhaustion.

## Implementation

- `src/shared/sandbox.ts`: persisted settings, support and runtime state.
- `src/main/sandbox/policy.ts`: canonical workspace validation, private directories,
  environment construction, and cleanup.
- `src/main/sandbox/{seatbelt,mxc}.ts`: platform launch policies.
- `src/main/sandbox/probe.ts`: positive private-storage checks and negative
  outside-file/host-network checks before exposing a service.
- `src/main/terminal.ts`: installation, verified launch, IPC readiness and lifetime.
- `src/main/connections.ts`: coordinated restart and relay disconnection.

The managed Python runtime is installed or updated by trusted Tether code before
the sandbox starts. Open Terminal's source is unchanged. It must support `--ipc`;
older versions cannot run in sandbox mode. Python uses isolated mode, and reserved
environment variables cannot override the private home, executable lookup, or
loader configuration. Caller-supplied custom environment values are intentional
inputs; do not place secrets in them unless the agent should receive them.

## Build and verification

Use Node 24.21 or later. macOS uses its system sandbox facility. Windows packages
include the pinned MXC SDK's matching native binaries with their original Microsoft
signatures. Release CI signs the Tether installer. No Linux sandbox binaries or
libraries are bundled.

Run `npm run lint`, `npm run format:check`, `npm run build`, and `npm test`.
For native integration tests, set `TETHER_TEST_PYTHON` to an absolute Python
executable with `open-terminal==0.17.6` installed. macOS tests otherwise use Tether's
existing managed runtime. Native tests cover authenticated IPC, allowed writes,
denied outside reads/writes, blocked networking, capability discovery, and launch
cancellation. The preflight test also deliberately uses an unrestricted launcher
and checks that it is rejected.

`.github/workflows/sandbox.yml` runs native checks on macOS and Windows for
both CPU architectures. A Windows runner without the required OS capabilities
reports its integration test as skipped; a skip is **not** containment validation.
Before release, obtain passing native results on supported Windows devices and
test the signed installers. The local implementation work was
validated on macOS ARM64; Windows behavior is not established by a
successful TypeScript build or by the macOS tests.

The Windows policy uses explicit volume-root denials with narrower grants to
counter implicit application-package access. See Microsoft's
[filesystem policy and overlap rules](https://github.com/microsoft/mxc/blob/main/docs/schema.md#filesystem-policy).
Keep the startup checks and native tests when updating the SDK or OS support.
Windows sandbox endpoints use the `LOCAL` named-pipe namespace because ordinary
names have a [reported ProcessContainer namespace mismatch](https://github.com/microsoft/mxc/issues/1706).
Host-to-container IPC must pass the native readiness test before any service is exposed.
