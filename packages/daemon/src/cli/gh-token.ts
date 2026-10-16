// `agentconnect gh-token <agentId> [repo]`: a fresh token on stdout (exit 0); exit 1 refused, exit 2 non-github.com — the wrapper fails closed on both.
import { createConnection } from 'node:net'
import { gitRepoLabel } from '@agentconnect.md/protocol'
import { resolveRoot } from '../paths.js'
import { GITCRED_CAPABILITY_ENV, gitcredSocketFrom } from '../cp/gitcred-server.js'

export async function runGhToken(agentId: string, repoRaw?: string): Promise<void> {
  const target = normalizeRepoArg(repoRaw)
  if (target.defer) {
    process.exitCode = 2
    return
  }

  const res = await ipc({
    op: 'get',
    agentId,
    capability: process.env[GITCRED_CAPABILITY_ENV],
    plane: 'gh',
    repoFullName: target.repo
  })
  if (!res.ok || !res.password) {
    process.stderr.write(
      `agentconnect: no gh credentials for agent ${agentId}${target.repo ? ` on ${target.repo}` : ''}: ${res.error ?? 'unknown error'}\n`
    )
    process.exitCode = 1
    return
  }
  process.stdout.write(res.password)
}

// Parse gh's OWNER/REPO, HOST/OWNER/REPO, URL, or scp repo forms; unparseable ⇒ workspace token, non-github.com ⇒ defer (refused).
export function normalizeRepoArg(raw?: string): { repo?: string; defer?: boolean } {
  const s = raw?.trim()
  if (!s) return {}
  // Bare OWNER/REPO (no host, no scheme).
  if (/^[^/\s:@]+\/[^/\s:@]+$/.test(s)) return { repo: s.replace(/\.git$/i, '') }
  // Full URL (https://git.example.com/…) or scp form (git@git.example.com:…).
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/@]+@)?([^/:]+)/i.exec(s)?.[1] ?? /^[\w.-]+@([\w.-]+):/.exec(s)?.[1]
  if (host) {
    if (host.toLowerCase() !== 'github.com') return { defer: true }
    const segs = gitRepoLabel(s).split('/')
    return segs.length >= 2 && segs[0] && segs[1] ? { repo: `${segs[0]}/${segs[1]}` } : {}
  }
  // HOST/OWNER/REPO plain form (gh's own shape).
  const segs = s.split('/')
  if (segs.length === 3 && segs[0]!.includes('.')) {
    if (segs[0]!.toLowerCase() !== 'github.com') return { defer: true }
    return { repo: `${segs[1]}/${segs[2]!.replace(/\.git$/i, '')}` }
  }
  return {}
}

interface IpcReply {
  ok: boolean
  password?: string
  error?: string
}

function ipc(msg: unknown): Promise<IpcReply> {
  const path = gitcredSocketFrom(process.env, resolveRoot())
  return new Promise((resolve) => {
    const sock = createConnection(path)
    let buf = ''
    const fail = (error: string) => resolve({ ok: false, error })
    sock.setTimeout(15_000, () => {
      sock.destroy()
      fail('daemon did not answer in time')
    })
    sock.on('connect', () => sock.write(JSON.stringify(msg) + '\n'))
    sock.on('data', (c) => {
      buf += c.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl === -1) return
      sock.destroy()
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as IpcReply)
      } catch {
        fail('malformed daemon reply')
      }
    })
    sock.on('error', (e) => fail(`cannot reach the daemon socket at ${path}: ${e.message}`))
  })
}
