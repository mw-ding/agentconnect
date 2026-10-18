// Live GitHub e2e for Lane 3b: comment commands and PR completion contracts; opt-in via KANBAN_E2E=1 and GITHUB_TOKEN.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RcGithubGraph } from '@agentconnect.md/protocol'
import { githubCommentDoorbell, githubPullRequestDoorbell } from '../../../relay/src/hooks/github-ingress.js'
import { GithubRepoPermission } from '../../src/github/repo-permission.js'
import { GithubCardStore } from '../../src/kanban/card-store.js'
import { KanbanCommentCommands } from '../../src/kanban/comment-command.js'
import { KanbanGraphDoorbell } from '../../src/kanban/graph-doorbell.js'
import { checksVerdict } from '../../src/kanban/contracts.js'
import { KanbanPrContracts } from '../../src/kanban/pr-contracts.js'
import { GithubPrReader } from '../../src/kanban/pr-reader.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo, PgKanbanDispatchRepo } from '../../src/persistence/index.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'
import { prisma } from '../setup.db.js'
import {
  closeIssues,
  createIssue,
  enabled,
  ensureLabels,
  FULL,
  gh,
  installation,
  REPO_ID,
  repoRef,
  TOKEN
} from '../fixtures/kanban-live.js'

type Status = 'triage' | 'todo' | 'ready' | 'running' | 'blocked' | 'review' | 'done' | 'archived'
interface GhIssue {
  id: number
  number: number
  state: string
  state_reason: string | null
  labels: Array<{ name: string }>
}
interface GhComment {
  id: number
  body: string
  user: { login: string; id: number; type: string }
}
interface GhPull {
  number: number
  state: string
  merged: boolean
  head: { sha: string; ref: string }
}

const results: Array<{ scenario: string; result: string; issue: string; ms: number; asserted: string }> = []
const tokenSource = { mintKanbanCard: async () => ({ token: TOKEN! }), mintKanbanPr: async () => ({ token: TOKEN! }) }
let e2eBinding: { authorLogin: string; authorType: string; defaultBranch: string }
const log = { debug: vi.fn(), info: vi.fn(), warn: (o: unknown, m?: string) => console.log('warn', m, o) }

function harness() {
  // Label sync re-checks the actor's live write grant, so the store needs the permission reader even in E2E.
  const store = new GithubCardStore({
    tokens: tokenSource as never,
    permissions: new GithubRepoPermission({ tokens: tokenSource as never, ttlMs: 0 })
  })
  const commands = new KanbanCommentCommands({
    cards: new PgKanbanCardRepo(prisma),
    store,
    permissions: new GithubRepoPermission({ tokens: tokenSource as never, ttlMs: 0 }),
    appSlug: undefined,
    log
  })
  const contracts = new KanbanPrContracts({
    bindingOverrideForTests: e2eBinding,
    repo: new PgKanbanDispatchRepo(prisma),
    prs: new GithubPrReader({ tokens: tokenSource as never }),
    store,
    repoRef: async () => repoRef,
    log
  })
  const doorbell = new KanbanGraphDoorbell({
    boards: new PgKanbanBoardRepo(prisma),
    installations: { getByInstallationId: async () => installation },
    store,
    onCommand: async (board, repo, n, command) => {
      await commands.handle(board, repo, n, command)
    },
    onPullRequest: (board, repo, pr) => contracts.onPullRequest(board, repo, pr),
    onCheckSuite: (board, repo, suite) => contracts.onCheckSuite(board, repo, suite),
    log
  })
  return { doorbell, contracts }
}

async function ring(doorbell: KanbanGraphDoorbell, poke: RcGithubGraph | undefined) {
  expect(poke).toBeDefined()
  doorbell.poke(poke!)
  await doorbell.settle()
  return doorbell.landedDeliveryKeys([poke!.deliveryKey]).has(poke!.deliveryKey)
}

async function seed(issue: { id: number; number: number }, status: Status, extra: Record<string, unknown> = {}) {
  const board = await prisma.kanbanBoard.create({
    data: { orgId: DEFAULT_ORG_ID, name: `lane3b-${Date.now()}`, repoId: REPO_ID, repoFullName: FULL, ...extra }
  })
  const card = await prisma.kanbanCard.create({
    data: { boardId: board.id, issueId: BigInt(issue.id), issueNumber: issue.number, status }
  })
  return { board, card }
}

const repository = async () => gh<{ id: number; full_name: string; url: string }>('GET', `/repos/${FULL}`)
const readIssue = (n: number) => gh<GhIssue>('GET', `/repos/${FULL}/issues/${n}`)
const labelsOf = async (n: number) => (await readIssue(n)).labels.map((l) => l.name)
const kanbanComments = async (n: number) =>
  (await gh<GhComment[]>('GET', `/repos/${FULL}/issues/${n}/comments?per_page=100`)).filter((c) =>
    c.body.startsWith('AgentConnect Kanban:')
  )

// The payload GitHub sends for `issue_comment.created`, assembled from the real objects; `sender` defaults to the author.
async function commentPayload(n: number, comment: GhComment, sender: Record<string, unknown> = comment.user) {
  const repo = await repository()
  return {
    action: 'created',
    issue: await readIssue(n),
    comment,
    repository: { id: repo.id, full_name: repo.full_name, url: repo.url },
    installation: { id: 1 },
    sender
  }
}

async function postComment(n: number, body: string) {
  return gh<GhComment>('POST', `/repos/${FULL}/issues/${n}/comments`, { body })
}

const BRANCH_PREFIX = 'kanban-e2e/lane3b'

// Scratch git objects: a base branch from main, and one head branch per PR carrying a single new `.kanban-e2e/` file.
async function createBranch(name: string, sha: string) {
  await gh('POST', `/repos/${FULL}/git/refs`, { ref: `refs/heads/${name}`, sha })
}
async function headOf(branch: string) {
  return (await gh<{ object: { sha: string } }>('GET', `/repos/${FULL}/git/ref/heads/${branch}`)).object.sha
}
async function openScratchPr(base: string, head: string, title: string) {
  await createBranch(head, await headOf(base))
  await gh('PUT', `/repos/${FULL}/contents/.kanban-e2e/${head.replace(/\//g, '-')}.md`, {
    message: 'test: kanban e2e scratch file',
    content: Buffer.from(`${title}\n`).toString('base64'),
    branch: head
  })
  return gh<GhPull>('POST', `/repos/${FULL}/pulls`, { title, head, base, body: 'Scratch PR for the Lane 3b e2e.' })
}
async function pullPayload(n: number) {
  const repo = await repository()
  const pull = await gh<GhPull>('GET', `/repos/${FULL}/pulls/${n}`)
  return {
    action: 'closed',
    number: n,
    pull_request: pull,
    repository: { id: repo.id, full_name: repo.full_name, url: repo.url },
    installation: { id: 1 },
    sender: { login: 'mw-ding', type: 'User' }
  }
}
async function poll<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs: number,
  stepMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

function pass(scenario: string, issue: number | string, started: number, asserted: string) {
  results.push({ scenario, result: 'PASS', issue: String(issue), ms: Date.now() - started, asserted })
  console.log('KANBAN_SCENARIO', JSON.stringify(results.at(-1)))
}

describe.skipIf(!enabled)('kanban M4 contracts e2e (live GitHub)', () => {
  const issues: number[] = []
  const pulls: number[] = []
  const branches: string[] = []
  const ts = Date.now()
  const base = `${BRANCH_PREFIX}-base-${ts}`

  beforeAll(async () => {
    const user = await gh<{ login: string; type: string }>('GET', '/user')
    e2eBinding = { authorLogin: user.login, authorType: user.type, defaultBranch: base }
    await ensureLabels()
    await createBranch(base, await headOf('main'))
    branches.push(base)
  })

  afterAll(async () => {
    const errors: unknown[] = []
    const attempt = async (fn: () => Promise<unknown>) => fn().catch((err: unknown) => errors.push(err))
    for (const n of pulls) {
      await attempt(async () => {
        const pull = await gh<GhPull>('GET', `/repos/${FULL}/pulls/${n}`)
        if (pull.state === 'open') await gh('PATCH', `/repos/${FULL}/pulls/${n}`, { state: 'closed' })
      })
    }
    // Heads first, the base last; a merged head is deleted too.
    for (const branch of branches.reverse()) {
      await attempt(() => gh('DELETE', `/repos/${FULL}/git/refs/heads/${branch}`))
    }
    await attempt(() => closeIssues(issues))
    for (const n of issues) expect((await readIssue(n)).state).toBe('closed')
    for (const n of pulls) expect((await gh<GhPull>('GET', `/repos/${FULL}/pulls/${n}`)).state).toBe('closed')
    for (const branch of branches) {
      const res = await fetch(`https://api.github.com/repos/${FULL}/git/ref/heads/${branch}`, {
        headers: { authorization: `Bearer ${TOKEN}` }
      })
      expect(res.status).toBe(404)
    }
    console.log('KANBAN_RESULTS', JSON.stringify(results))
    if (errors.length > 0) throw errors[0]
  })

  it('c1: /kanban unblock by the admin moves a blocked card to ready and relabels the issue', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'lane3b c1 unblock', ['ac/status:blocked'])
    const { board, card } = await seed(issue, 'blocked')
    await prisma.kanbanCard.update({ where: { id: card.id }, data: { blockKind: 'needs_input' } })
    const comment = await postComment(issue.number, '/kanban unblock')
    const poke = githubCommentDoorbell(
      'issue_comment',
      (await commentPayload(issue.number, comment)) as never,
      `c1-${ts}`
    )
    expect(poke?.command).toMatchObject({ name: 'unblock', sender: { login: 'mw-ding', type: 'User' } })
    expect(JSON.stringify(poke)).not.toContain('/kanban')
    expect(await ring(harness().doorbell, poke)).toBe(true)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      status: 'ready',
      blockKind: null
    })
    const labels = await labelsOf(issue.number)
    expect(labels).toContain('ac/status:ready')
    expect(labels).not.toContain('ac/status:blocked')
    expect(await prisma.kanbanCommand.findMany({ where: { boardId: board.id } })).toEqual([
      expect.objectContaining({ outcome: 'applied', actorLogin: 'mw-ding', settledAt: expect.any(Date) })
    ])
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { kind: 'kanban_card_change' } })
    expect(audit.details).toMatchObject({ humanAuthority: { login: 'mw-ding', permission: 'admin' } })
    expect(await kanbanComments(issue.number)).toEqual([])
    pass('c1', issue.number, started, 'blocked→ready, ac/status:ready live, ledger applied, audit admin, no CP comment')
  })

  it('c2: /kanban reopen reopens a done issue and moves the card to ready', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'lane3b c2 reopen', ['ac/status:done'])
    await gh('PATCH', `/repos/${FULL}/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' })
    const { card } = await seed(issue, 'done')
    const comment = await postComment(issue.number, '/kanban reopen')
    const poke = githubCommentDoorbell(
      'issue_comment',
      (await commentPayload(issue.number, comment)) as never,
      `c2-${ts}`
    )
    expect(await ring(harness().doorbell, poke)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('ready')
    const live = await readIssue(issue.number)
    expect(live.state).toBe('open')
    expect(live.labels.map((l) => l.name)).toContain('ac/status:ready')
    expect(live.labels.map((l) => l.name)).not.toContain('ac/status:done')
    pass('c2', issue.number, started, 'done→ready, issue reopened, ac/status:ready live')
  })

  it('c3: a non-collaborator command is silently recorded once, even when redelivered', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'lane3b c3 refused', ['ac/status:blocked'])
    const { card } = await seed(issue, 'blocked')
    const comment = await postComment(issue.number, '/kanban unblock')
    const payload = await commentPayload(issue.number, comment, { login: 'octocat', id: 583231, type: 'User' })
    const { doorbell } = harness()
    expect(await ring(doorbell, githubCommentDoorbell('issue_comment', payload as never, `c3-${ts}`))).toBe(true)
    // A redelivery under a new GUID (a fresh CP process would not remember the first) changes nothing.
    expect(await ring(harness().doorbell, githubCommentDoorbell('issue_comment', payload as never, `c3b-${ts}`))).toBe(
      true
    )
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('blocked')
    expect(await labelsOf(issue.number)).toContain('ac/status:blocked')
    const refusals = await kanbanComments(issue.number)
    expect(refusals).toHaveLength(0)
    expect(await prisma.kanbanCommand.findMany({ where: { cardId: card.id } })).toEqual([
      expect.objectContaining({ outcome: 'no_write', settledAt: expect.any(Date) })
    ])
    pass(
      'c3',
      issue.number,
      started,
      'octocat (live permission none): no move, no CP reply, one no_write ledger row across 2 deliveries'
    )
  })

  it('c4: a bot sender is dropped at the relay and never moves the card', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'lane3b c4 bot', ['ac/status:blocked'])
    const { board, card } = await seed(issue, 'blocked')
    const comment = await postComment(issue.number, '/kanban unblock')
    const payload = await commentPayload(issue.number, comment, {
      login: 'github-actions[bot]',
      id: 41898282,
      type: 'Bot'
    })
    const poke = githubCommentDoorbell('issue_comment', payload as never, `c4-${ts}`)
    expect(poke).toMatchObject({ numbers: [], ids: [] })
    expect(poke?.command).toBeUndefined()
    expect(await ring(harness().doorbell, poke)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('blocked')
    expect(await prisma.kanbanCommand.count({ where: { boardId: board.id } })).toBe(0)
    expect(await kanbanComments(issue.number)).toEqual([])
    pass('c4', issue.number, started, 'Bot sender → seen-only marker, no command, no move, no comment')
  })

  it('k1: pr_merged — merging the linked scratch PR completes the review card and closes its issue as completed', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'lane3b k1 pr_merged', ['ac/status:review'])
    const head = `ac/card-${issue.number}`
    branches.push(head)
    const pr = await openScratchPr(base, head, `[kanban-e2e] lane3b k1 ${ts}`)
    pulls.push(pr.number)
    const { card } = await seed(issue, 'review', { completionContract: 'pr_merged' })
    await prisma.kanbanCard.update({
      where: { id: card.id },
      data: { linkedPrNumber: pr.number, linkedPrWorkStartedAt: new Date(started) }
    })
    // Mergeability is computed asynchronously; retry the merge briefly.
    await poll(
      () =>
        gh('PUT', `/repos/${FULL}/pulls/${pr.number}/merge`, { merge_method: 'squash' }).then(
          () => true,
          () => false
        ),
      (ok) => ok,
      60_000,
      3000
    )
    const payload = await pullPayload(pr.number)
    expect(payload.pull_request.merged).toBe(true)
    const poke = githubPullRequestDoorbell('pull_request', payload as never, `k1-${ts}`)
    expect(poke?.pullRequest).toEqual({ number: pr.number, merged: true, headSha: payload.pull_request.head.sha })
    expect(await ring(harness().doorbell, poke)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('done')
    const live = await readIssue(issue.number)
    expect([live.state, live.state_reason]).toEqual(['closed', 'completed'])
    expect(live.labels.map((l) => l.name)).toContain('ac/status:done')
    pass(
      'k1',
      `${issue.number} / PR ${pr.number}`,
      started,
      'scratch PR merged into scratch base → review→done, issue closed completed, ac/status:done'
    )
  })

  it('k2: a linked PR closed unmerged sends the card to triage with one attention comment', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'lane3b k2 pr_closed_unmerged', ['ac/status:review'])
    const head = `ac/card-${issue.number}`
    branches.push(head)
    const pr = await openScratchPr(base, head, `[kanban-e2e] lane3b k2 ${ts}`)
    pulls.push(pr.number)
    const { card } = await seed(issue, 'review', { completionContract: 'pr_merged' })
    await prisma.kanbanCard.update({
      where: { id: card.id },
      data: { linkedPrNumber: pr.number, linkedPrWorkStartedAt: new Date(started) }
    })
    await gh('PATCH', `/repos/${FULL}/pulls/${pr.number}`, { state: 'closed' })
    const poke = githubPullRequestDoorbell('pull_request', (await pullPayload(pr.number)) as never, `k2-${ts}`)
    expect(poke?.pullRequest?.merged).toBe(false)
    const { doorbell } = harness()
    expect(await ring(doorbell, poke)).toBe(true)
    expect(await ring(harness().doorbell, { ...poke!, deliveryKey: `k2b-${ts}` })).toBe(true)
    expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({
      status: 'triage',
      needsAttention: true,
      attentionReason: 'pr_closed_unmerged'
    })
    expect(await labelsOf(issue.number)).toContain('ac/status:triage')
    const notes = await kanbanComments(issue.number)
    expect(notes).toHaveLength(1)
    expect(notes[0]!.body).toContain(`#${pr.number} was closed without merging`)
    pass(
      'k2',
      `${issue.number} / PR ${pr.number}`,
      started,
      'closed unmerged → triage, needsAttention pr_closed_unmerged, one comment across 2 deliveries'
    )
  })

  it('k3: pr_checks_green — a failing check keeps the card in review; a green re-run on the same head completes it', async () => {
    const started = Date.now()
    const issue = await createIssue(issues, 'lane3b k3 pr_checks_green', ['ac/status:review'])
    const head = `ac/card-${issue.number}`
    branches.push(head)
    // Not a conventional title, so the repository's `Conventional PR` check fails on this head.
    const pr = await openScratchPr(base, head, `[kanban-e2e] lane3b k3 ${ts}`)
    pulls.push(pr.number)
    const sha = (await gh<GhPull>('GET', `/repos/${FULL}/pulls/${pr.number}`)).head.sha
    const { card } = await seed(issue, 'review', { completionContract: 'pr_checks_green' })
    await prisma.kanbanCard.update({
      where: { id: card.id },
      data: { linkedPrNumber: pr.number, linkedPrWorkStartedAt: new Date(started) }
    })
    interface Suites {
      check_suites: Array<{
        id: number
        status: string
        conclusion: string | null
        head_sha: string
        pull_requests: Array<{ number: number }>
        latest_check_runs_count: number
      }>
    }
    const suites = () => gh<Suites>('GET', `/repos/${FULL}/commits/${sha}/check-suites`)
    // A title edit re-runs the check in a new suite; judge the newest run per check, as the CP does.
    const runs = async () => {
      const result = await new GithubPrReader({ tokens: tokenSource as never }).readCheckRuns(repoRef, sha)
      return { check_runs: result.runs, complete: result.complete }
    }
    const failed = await poll(
      runs,
      (r) => r.check_runs.length > 0 && r.check_runs.every((x) => x.status === 'completed'),
      240_000
    )
    if (failed.check_runs.length === 0) {
      results.push({
        scenario: 'k3',
        result: 'SKIP (no checks ran)',
        issue: String(issue.number),
        ms: Date.now() - started,
        asserted: 'covered by PG tests'
      })
      return
    }
    expect(failed.check_runs.some((r) => r.conclusion === 'failure')).toBe(true)
    const suitePayload = async () => {
      const repo = await repository()
      const suite = (await suites()).check_suites
        .filter((x) => x.status === 'completed' && x.latest_check_runs_count > 0)
        .sort((a, b) => b.id - a.id)[0]!
      return {
        action: 'completed',
        check_suite: suite,
        repository: { id: repo.id, full_name: repo.full_name, url: repo.url },
        installation: { id: 1 },
        sender: { login: 'github-actions[bot]', type: 'Bot' }
      }
    }
    const red = githubPullRequestDoorbell('check_suite', (await suitePayload()) as never, `k3a-${ts}`)
    expect(red?.checkSuite).toMatchObject({ headSha: sha, prNumbers: [pr.number] })
    expect(await ring(harness().doorbell, red)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('review')
    // A conventional title re-runs the check on the same head; the latest run is now green.
    await gh('PATCH', `/repos/${FULL}/pulls/${pr.number}`, { title: `test: [kanban-e2e] lane3b k3 ${ts}` })
    const green = await poll(runs, (r) => r.complete && checksVerdict(r.check_runs) === 'green', 300_000)
    expect(checksVerdict(green.check_runs)).toBe('green')
    // A suite naming an older head is ignored even when the head is now green.
    const stale = { ...red!, deliveryKey: `k3s-${ts}`, checkSuite: { ...red!.checkSuite!, headSha: 'e'.repeat(40) } }
    expect(await ring(harness().doorbell, stale)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('review')
    const ok = githubPullRequestDoorbell('check_suite', (await suitePayload()) as never, `k3b-${ts}`)
    expect(await ring(harness().doorbell, ok)).toBe(true)
    expect((await prisma.kanbanCard.findUniqueOrThrow({ where: { id: card.id } })).status).toBe('done')
    const live = await readIssue(issue.number)
    expect([live.state, live.state_reason]).toEqual(['closed', 'completed'])
    pass(
      'k3',
      `${issue.number} / PR ${pr.number}`,
      started,
      'real Conventional PR check: failure → stays review; stale sha ignored; green re-run on same head → done'
    )
  }, 900_000)
})
