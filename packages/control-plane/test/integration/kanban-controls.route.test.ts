// Kanban M4 control routes (issue #2 B5): only an interactive OIDC owner may pause/resume a board or skip/restart a card.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { prisma } from '../setup.db.js'
import { buildHttpApp, TEST_API_KEY_PEPPER } from '../fakes/build-http.js'
import { bearer, memberBearer, ownerBearer, startKanbanOidc, type KanbanOidc } from '../fixtures/kanban-oidc.js'
import { PgKanbanBoardRepo, PgKanbanCardRepo } from '../../src/persistence/repositories/kanban.repo.js'
import { KanbanControls } from '../../src/kanban/controls.js'
import { ApiKeyCodec } from '../../src/registry/apiKey.js'
import type { CardIssue, KanbanRepoRef } from '../../src/kanban/card-store.js'
import type { LabelPlan, ObservedIssue } from '../../src/kanban/card-state.js'
import { OrgId } from '../../src/domain/ids.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const BOARD = 'b0000000-0000-4000-8000-000000000000'
const CARD = 'c0000000-0000-4000-8000-000000000000'

class FakeStore {
  readonly writes: LabelPlan[] = []
  readonly issues = new Map<number, { labels: string[]; state: 'open' | 'closed'; stateReason: string | null }>()
  async readCard(_repo: KanbanRepoRef, n: number): Promise<CardIssue | null> {
    const i = this.issues.get(n)
    return i ? { issueId: BigInt(n), nodeId: `I_${n}`, number: n, ...i, labels: [...i.labels] } : null
  }
  async applyPlan(_repo: KanbanRepoRef, n: number, _observed: ObservedIssue, plan: LabelPlan): Promise<void> {
    this.writes.push(plan)
    const i = this.issues.get(n)!
    i.labels = [...i.labels.filter((l) => !plan.removeLabels.includes(l)), ...plan.addLabels]
    if (plan.issueState) {
      i.state = plan.issueState.state
      i.stateReason = plan.issueState.state === 'closed' ? plan.issueState.reason : null
    }
  }
}

let oidc: KanbanOidc
beforeAll(async () => {
  oidc = await startKanbanOidc('kanban-controls-test')
})
afterAll(() => oidc.close())

const store = new FakeStore()

function controls(poke = vi.fn()) {
  return new KanbanControls({
    boards: new PgKanbanBoardRepo(prisma),
    cards: new PgKanbanCardRepo(prisma),
    installations: {
      liveByOrgAndAccount: async (orgId, login) =>
        orgId === OrgId(DEFAULT_ORG_ID) && login === 'acme'
          ? ({
              id: 'inst',
              orgId,
              installationId: 77n,
              accountLogin: 'acme',
              revokedAt: null,
              suspendedAt: null,
              createdAt: new Date(0)
            } as never)
          : null
    },
    store,
    resolveLogin: async () => 'owner',
    poke,
    log: { warn: vi.fn() }
  })
}

function buildApp(poke = vi.fn()) {
  return buildHttpApp(prisma, { OIDC_ISSUER: oidc.issuer, OIDC_AUDIENCE: oidc.audience }, undefined, undefined, {
    kanbanControls: controls(poke)
  })
}

async function seedBoard() {
  await prisma.kanbanBoard.create({
    data: { id: BOARD, orgId: DEFAULT_ORG_ID, name: 'eng', repoId: 4242n, repoFullName: 'acme/web' }
  })
  store.issues.set(1, { labels: ['ac/status:ready'], state: 'open', stateReason: null })
  await prisma.kanbanCard.create({ data: { id: CARD, boardId: BOARD, issueId: 1n, issueNumber: 1, status: 'ready' } })
}

const boardPause = `${ORG}/kanban/boards/${BOARD}/pause`
const boardResume = `${ORG}/kanban/boards/${BOARD}/resume`
const cardSkip = `${ORG}/kanban/boards/${BOARD}/cards/${CARD}/skip`
const cardRestart = `${ORG}/kanban/boards/${BOARD}/cards/${CARD}/restart`

describe('Kanban control routes — an interactive owner', () => {
  it('pauses and resumes a board idempotently with one audit row each', async () => {
    await seedBoard()
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const pause = await app.inject({ method: 'POST', url: boardPause, headers })
      expect(pause.statusCode).toBe(200)
      expect(pause.json()).toMatchObject({
        paused: true,
        pausedAt: expect.any(String),
        pausedByUserId: expect.any(String)
      })

      const again = await app.inject({ method: 'POST', url: boardPause, headers })
      expect(again.statusCode).toBe(200)
      expect(await prisma.auditEvent.count({ where: { kind: 'board_paused' } })).toBe(1)

      const resume = await app.inject({ method: 'POST', url: boardResume, headers })
      expect(resume.statusCode).toBe(200)
      expect(resume.json()).toMatchObject({ paused: false, pausedAt: null })
      expect(await prisma.auditEvent.count({ where: { kind: 'board_resumed' } })).toBe(1)
    } finally {
      await close()
    }
  })

  it('skips a card and restarts it', async () => {
    await seedBoard()
    const poke = vi.fn()
    const { app, close } = buildApp(poke)
    const headers = await ownerBearer(prisma, oidc)
    try {
      const skip = await app.inject({ method: 'POST', url: cardSkip, headers })
      expect(skip.statusCode).toBe(200)
      expect(skip.json()).toEqual({ boardId: BOARD, cardId: CARD, status: 'archived' })
      expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: CARD } })).toMatchObject({ status: 'archived' })

      const restart = await app.inject({ method: 'POST', url: cardRestart, headers })
      expect(restart.statusCode).toBe(200)
      expect(restart.json()).toEqual({ boardId: BOARD, cardId: CARD, status: 'ready' })
      expect(poke).toHaveBeenCalledWith(BOARD)
    } finally {
      await close()
    }
  })

  it('404s a missing board or card and 409s an illegal transition', async () => {
    await seedBoard()
    const { app, close } = buildApp()
    const headers = await ownerBearer(prisma, oidc)
    try {
      const missing = await app.inject({
        method: 'POST',
        url: `${ORG}/kanban/boards/00000000-0000-4000-8000-000000000000/pause`,
        headers
      })
      expect(missing.statusCode).toBe(404)
      const foreignCard = await app.inject({
        method: 'POST',
        url: `${ORG}/kanban/boards/${BOARD}/cards/00000000-0000-4000-8000-000000000000/skip`,
        headers
      })
      expect(foreignCard.statusCode).toBe(404)
      await prisma.kanbanCard.update({ where: { id: CARD }, data: { status: 'done' } })
      const illegal = await app.inject({ method: 'POST', url: cardSkip, headers })
      expect(illegal.statusCode).toBe(409)
      expect(illegal.json()).toMatchObject({ code: 'illegal_transition' })
    } finally {
      await close()
    }
  })
})

describe('Kanban control routes — every non-interactive or non-owner caller is refused', () => {
  async function expectRefused(status: number, headers: Record<string, string>) {
    await seedBoard()
    const { app, close } = buildApp()
    try {
      const res = [
        await app.inject({ method: 'POST', url: boardPause, headers }),
        await app.inject({ method: 'POST', url: boardResume, headers }),
        await app.inject({ method: 'POST', url: cardSkip, headers }),
        await app.inject({ method: 'POST', url: cardRestart, headers })
      ]
      expect(res.map((r) => r.statusCode)).toEqual([status, status, status, status])
      expect(await prisma.kanbanBoard.findUniqueOrThrow({ where: { id: BOARD } })).toMatchObject({ paused: false })
      expect(await prisma.kanbanCard.findUniqueOrThrow({ where: { id: CARD } })).toMatchObject({ status: 'ready' })
      expect(await prisma.auditEvent.count()).toBe(0)
    } finally {
      await close()
    }
  }

  it('no credentials → 401', async () => {
    await expectRefused(401, {})
  })

  it('an interactive collaborator → 403', async () => {
    const { headers } = await memberBearer(prisma, oidc, 'collaborator', 'kanban-controls-collab')
    await expectRefused(403, headers)
  })

  it('an interactive viewer → 403', async () => {
    const { headers } = await memberBearer(prisma, oidc, 'viewer', 'kanban-controls-viewer')
    await expectRefused(403, headers)
  })

  it('the devAuth stub (no OIDC configured) → 403', async () => {
    await seedBoard()
    const app = buildHttpApp(prisma, {}, undefined, undefined, { kanbanControls: controls() })
    try {
      const res = await app.app.inject({ method: 'POST', url: boardPause, headers: {} })
      expect(res.statusCode).toBe(403)
    } finally {
      await app.close()
    }
  })

  it("the owner's personal API key → 403", async () => {
    const minted = new ApiKeyCodec({ API_KEY_PEPPER: TEST_API_KEY_PEPPER }).mint()
    await prisma.apiKey.create({
      data: {
        principalType: 'user',
        userId: DEFAULT_OWNER_ID,
        orgId: DEFAULT_ORG_ID,
        hash: minted.hash,
        displayTail: minted.displayTail
      }
    })
    await expectRefused(403, bearer(minted.token))
  })
})
