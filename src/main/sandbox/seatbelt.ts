import { dirname } from 'node:path'
import type { ServiceLaunch } from '../process/managedService'
import type { SandboxPolicy } from './policy'

export function seatbeltLaunch(launch: ServiceLaunch, policy: SandboxPolicy): ServiceLaunch {
  // JSON string escaping also quotes literal Seatbelt strings; paths are never Scheme code.
  const literal = (path: string): string => `(literal ${JSON.stringify(path)})`
  const subtree = (path: string): string => `(subpath ${JSON.stringify(path)})`
  const readable = [
    '/System/Library',
    '/usr/lib',
    '/usr/share',
    '/usr/bin',
    '/bin',
    '/sbin',
    '/Library/Apple',
    policy.runtimePath
  ]
  const writable = [policy.workspacePath, policy.sessionPath, dirname(policy.socketPath)]
  const profile = [
    '(version 1)',
    '(deny default file-link)',
    '(import "dyld-support.sb")',
    '(allow syscall*)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target self))',
    '(allow sysctl-read)',
    `(allow file-read* file-map-executable ${[...readable, ...writable].map(subtree).join(' ')})`,
    `(allow file-write* ${writable.map(subtree).join(' ')})`,
    '(allow file-read-metadata)',
    '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (literal "/dev/zero") (literal "/private/etc/localtime"))',
    '(allow file-write-data (literal "/dev/null"))',
    '(allow pseudo-tty)',
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx") (regex #"^/dev/ttys[0-9]+$"))',
    `(allow network-bind network-inbound network-outbound (local unix-socket (literal ${JSON.stringify(policy.socketPath)})))`,
    ...(policy.networkAccess
      ? [
          '(allow network-outbound (remote ip "*:*"))',
          '(allow network-outbound (control-name "com.apple.netsrc"))',
          '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
          '(allow mach-lookup (global-name "com.apple.mDNSResponder") (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent"))',
          '(allow file-read* (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf") (literal "/private/var/run/resolv.conf") (literal "/private/etc/ssl/cert.pem"))'
        ]
      : []),
    `(allow file-read* ${literal('/private/etc/paths')})`
  ].join('\n')
  return {
    ...launch,
    file: '/usr/bin/sandbox-exec',
    args: ['-p', profile, launch.file, ...launch.args]
  }
}
