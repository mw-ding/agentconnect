/**
 * `agentconnect dispatch --dry-run` — "why isn't this card running?". It calls the Control Plane's
 * read-only Kanban explain routes and prints each gate; nothing is dispatched or written. Card
 * titles never cross this path, so the output is ids, issue numbers, statuses and gate codes.
 *
 * Auth is the stored personal API key (the one `login` saved), which the viewer-readable explain
 * routes accept; the REST base is derived from the stored daemon WebSocket URL.
 */
import { existsSync, readFileSync } from 'node:fs'
import { configPath } from './paths.js'

export interface DryRunOpts {
  apiUrl: string
  apiKey: string
  /** Organization id or slug; optional when the key's user belongs to exactly one organization. */
  org?: string
  board: string
  card?: string
  issue?: number
  json?: boolean
}

export interface DryRunDeps {
  fetch: typeof fetch
  out: (line: string) => void
}

/** A refusal the command reports as `agentconnect dispatch: <message>` with a non-zero exit. */
export class DispatchDryRunError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
    this.name = 'DispatchDryRunError'
  }
}

interface ExplainEntry {
  cardId: string
  issueNumber: number
  status: string
  verdict: { eligible: boolean; role?: string; agentId?: string; gate?: string }
  hint: string
  claimOrder?: number
  capBound?: string
}

interface BoardExplain {
  cards: ExplainEntry[]
  wouldClaimNextIssueNumbers: number[]
}

const REQUEST_TIMEOUT_MS = 15_000
const WS_PATH_SUFFIX = /\/daemon\/ws\/?$/

/** The REST root (`…/api/v1`) behind a daemon control-plane URL: ws→http, wss→https, the daemon path dropped. */
export function restBaseFor(apiUrl: string): string {
  let url: URL
  try {
    url = new URL(apiUrl)
  } catch {
    throw new DispatchDryRunError(`invalid API URL '${apiUrl}'`)
  }
  const protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol
  if (protocol !== 'http:' && protocol !== 'https:')
    throw new DispatchDryRunError(`unsupported API URL scheme '${url.protocol}'`)
  const path = url.pathname.replace(WS_PATH_SUFFIX, '').replace(/\/+$/, '')
  return `${protocol}//${url.host}${path}/api/v1`
}

/** The control-plane URL and key `login` saved, for a flag the operator did not pass. */
export function readStoredCredentials(root: string, file?: string): { apiUrl?: string; apiKey?: string } {
  const path = file ?? configPath(root)
  if (!existsSync(path)) return {}
  try {
    const cp = (JSON.parse(readFileSync(path, 'utf8')) as { controlPlane?: { url?: unknown; key?: unknown } })
      .controlPlane
    return {
      ...(typeof cp?.url === 'string' && cp.url ? { apiUrl: cp.url } : {}),
      ...(typeof cp?.key === 'string' && cp.key ? { apiKey: cp.key } : {})
    }
  } catch {
    return {}
  }
}

async function getJson<T>(deps: DryRunDeps, opts: DryRunOpts, path: string): Promise<T> {
  let res: Response
  try {
    res = await deps.fetch(`${restBaseFor(opts.apiUrl)}${path}`, {
      headers: { authorization: `Bearer ${opts.apiKey}`, accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    if (err instanceof DispatchDryRunError) throw err
    throw new DispatchDryRunError(`cannot reach the control plane: ${(err as Error).message}`)
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: unknown; message?: unknown }
    const code = typeof body.code === 'string' ? body.code : undefined
    const message = typeof body.message === 'string' ? body.message : res.statusText
    throw new DispatchDryRunError(`${res.status}${code ? ` ${code}` : ''}: ${message}`, code)
  }
  return (await res.json()) as T
}

/** The organization to address: the flag, else the caller's only one. */
async function resolveOrg(deps: DryRunDeps, opts: DryRunOpts): Promise<string> {
  if (opts.org) return opts.org
  const orgs = await getJson<Array<{ id: string }>>(deps, opts, '/orgs')
  if (orgs.length === 1) return orgs[0]!.id
  if (orgs.length === 0) throw new DispatchDryRunError('this key belongs to no organization')
  throw new DispatchDryRunError(`this key belongs to ${orgs.length} organizations; pass --org <id|slug>`)
}

/** One card line: `#12 ready → ELIGIBLE (work → agent <id>)` or `#12 ready → blocked by <gate>: <hint>`. */
export function formatEntry(entry: ExplainEntry): string {
  const head = `#${entry.issueNumber} ${entry.status} →`
  if (entry.verdict.eligible) {
    if (entry.capBound) return `${head} ELIGIBLE but deferred by ${entry.capBound}: ${entry.hint}`
    return `${head} ELIGIBLE (${entry.verdict.role ?? 'work'} → agent ${entry.verdict.agentId})`
  }
  return `${head} blocked by ${entry.verdict.gate}: ${entry.hint}`
}

/** Explain one card or a whole board. Exit code 0 means the explanation was produced, whatever it says. */
export async function runDispatchDryRun(opts: DryRunOpts, deps: DryRunDeps): Promise<void> {
  if (opts.card !== undefined && opts.issue !== undefined)
    throw new DispatchDryRunError('pass either --card or --issue, not both')
  const org = encodeURIComponent(await resolveOrg(deps, opts))
  const board = `/orgs/${org}/kanban/boards/${encodeURIComponent(opts.board)}`

  if (opts.card === undefined && opts.issue === undefined) {
    const explained = await getJson<BoardExplain>(deps, opts, `${board}/explain`)
    if (opts.json) return deps.out(JSON.stringify(explained, null, 2))
    for (const entry of explained.cards) deps.out(formatEntry(entry))
    const next = explained.wouldClaimNextIssueNumbers.map((n) => `#${n}`).join(', ')
    deps.out(`would claim next: ${next || '(none)'}`)
    return
  }

  let cardId = opts.card
  if (cardId === undefined) {
    const listed = await getJson<{ cards: Array<{ id: string; issueNumber: number }> }>(deps, opts, `${board}/cards`)
    cardId = listed.cards.find((c) => c.issueNumber === opts.issue)?.id
    if (cardId === undefined) throw new DispatchDryRunError(`no card #${opts.issue} on this board`, 'not_found')
  }
  const entry = await getJson<ExplainEntry>(deps, opts, `${board}/cards/${encodeURIComponent(cardId)}/explain`)
  deps.out(opts.json ? JSON.stringify(entry, null, 2) : formatEntry(entry))
}

export interface DispatchCommandFlags {
  root: string
  dryRun?: boolean
  config?: string
  apiUrl?: string
  apiKey?: string
  board?: string
  card?: string
  issue?: string
  org?: string
  json?: boolean
}

/** The `dispatch` command body: validate flags and fall back to the stored login before calling the explain routes. */
export async function runDispatchCommand(flags: DispatchCommandFlags, deps: DryRunDeps): Promise<void> {
  if (!flags.dryRun) throw new DispatchDryRunError('only --dry-run is supported; dispatch runs in the control plane')
  if (!flags.board) throw new DispatchDryRunError('--board <id> is required')
  const stored = readStoredCredentials(flags.root, flags.config)
  const apiUrl = flags.apiUrl ?? stored.apiUrl
  const apiKey = flags.apiKey ?? stored.apiKey
  if (!apiUrl || !apiKey) {
    throw new DispatchDryRunError(
      'no control plane credentials; run `agentconnect login` or pass --api-url and --api-key'
    )
  }
  const issue = flags.issue === undefined ? undefined : Number(flags.issue)
  if (issue !== undefined && (!Number.isInteger(issue) || issue < 1)) {
    throw new DispatchDryRunError(`invalid --issue '${flags.issue}' (use a positive issue number)`)
  }
  await runDispatchDryRun(
    {
      apiUrl,
      apiKey,
      board: flags.board,
      ...(flags.card !== undefined ? { card: flags.card } : {}),
      ...(issue !== undefined ? { issue } : {}),
      ...(flags.org !== undefined ? { org: flags.org } : {}),
      ...(flags.json ? { json: true } : {})
    },
    deps
  )
}
