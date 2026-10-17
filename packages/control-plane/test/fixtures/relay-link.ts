// Real relay HTTP ingress + rc/* WebSocket link for integration and live E2E tests: GitHub webhooks enter exactly as in production.
import { createHmac, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { RELAY_CP_SUBPROTOCOL, type RcGithubGraph, type RcGithubInstallation } from '@agentconnect.md/protocol'
import { ClientTransport, systemClock } from '../../../connection/src/index.js'
import { RelayCpClient } from '../../../relay/src/relay-cp-client.js'
import { buildRelayServer } from '../../../relay/src/server.js'
import { HookTable } from '../../../relay/src/hooks/hook-table.js'
import { HookRateLimiter } from '../../../relay/src/hooks/rate-limit.js'
import { registerGithubIngress } from '../../../relay/src/hooks/github-ingress.js'
import type { Logger } from '../../../relay/src/log.js'

export interface RelayCpLinkOptions {
  /** The CP's listening origin (http:// or ws://); the relay dials `/api/v1/relays/ws` on it. */
  cpUrl: string
  /** The CP's `RELAY_TOKEN` shared secret (or a relay ApiKey with `authMethod: 'apikey'`). */
  relayCredential: string
  authMethod?: 'token' | 'apikey'
  /** The App webhook secret; a CP deployment snapshot that carries one replaces it, as in production. */
  webhookSecret: string
  name?: string
  log?: Logger
  /** How long to wait for the link to reach READY. */
  readyTimeoutMs?: number
}

export interface RelayCpLink {
  /** `http://127.0.0.1:<port>/webhooks/github` — point a GitHub App (or a signed POST) here. */
  webhookUrl: string
  client: RelayCpClient
  server: FastifyInstance
  hooks: HookTable
  /** Every Kanban doorbell the relay put on the wire, in order (body-free, so safe to keep). */
  graphPokes: RcGithubGraph[]
  installationPokes: RcGithubInstallation[]
  close(): Promise<void>
}

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

/** Boots the relay's own Fastify server and CP client (the relay `index.ts` wiring for GitHub ingress) on a real port. */
export async function startRelayCpLink(opts: RelayCpLinkOptions): Promise<RelayCpLink> {
  const log = opts.log ?? quiet
  const deploymentConfig: { githubWebhookSecret?: string } = { githubWebhookSecret: opts.webhookSecret }
  const graphPokes: RcGithubGraph[] = []
  const installationPokes: RcGithubInstallation[] = []
  const hooks = new HookTable()
  const held: { client?: RelayCpClient } = {}
  const server = buildRelayServer(
    { isReady: () => held.client?.isReady() ?? false, relayId: () => held.client?.relayId },
    { logger: false }
  )
  const wsOrigin = opts.cpUrl.replace(/^http/, 'ws')
  const client = new RelayCpClient({
    auth: { method: opts.authMethod ?? 'token', credential: opts.relayCredential },
    name: opts.name ?? `test-relay-${randomUUID().slice(0, 8)}`,
    daemonUrl: 'ws://127.0.0.1:1/unused',
    heartbeatDefaultMs: 15_000,
    clock: systemClock,
    connect: () => ClientTransport.dial(wsOrigin, { subprotocol: RELAY_CP_SUBPROTOCOL, path: '/api/v1/relays/ws' }),
    log,
    // Production replaces the env secret with the CP's first snapshot outright, even when it carries none.
    onDeploymentConfig: (snapshot) => {
      deploymentConfig.githubWebhookSecret = snapshot.githubWebhookSecret
    },
    onHookAssign: (rule) => hooks.upsert(rule),
    onHookRemove: (hookId) => hooks.remove(hookId)
  })
  held.client = client
  const limiter = new HookRateLimiter(systemClock)
  registerGithubIngress(server, {
    table: hooks,
    daemons: () => undefined,
    report: (r) => client.emitRunReport(r),
    doorbell: (poke) => {
      installationPokes.push(poke)
      return client.emitGithubInstallation(poke)
    },
    graphDoorbell: (poke) => {
      graphPokes.push(poke)
      return client.emitGithubGraph(poke)
    },
    authorizeComment: (request) => client.authorizeGithubComment(request),
    authorizeRerequest: (request) => client.authorizeGithubRerequest(request),
    authzLimiter: new HookRateLimiter(systemClock, { capacity: 10, refillPerSec: 0.25 }),
    limiter,
    clock: systemClock,
    log,
    webhookSecret: () => deploymentConfig.githubWebhookSecret
  })
  client.start()
  const address = await server.listen({ port: 0, host: '127.0.0.1' })
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 10_000)
  while (!client.isReady()) {
    if (Date.now() > deadline) {
      await client.stop()
      await server.close()
      throw new Error(`relay link did not reach READY (state ${client.state})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return {
    webhookUrl: `${address}/webhooks/github`,
    client,
    server,
    hooks,
    graphPokes,
    installationPokes,
    close: async () => {
      await client.stop()
      await server.close()
    }
  }
}

/** GitHub's `X-Hub-Signature-256` value for a raw body. */
export function signGithubWebhook(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

/** POST one webhook the way GitHub does; `signature` overrides the computed header (pass a wrong one to test 401). */
export async function postGithubWebhook(
  webhookUrl: string,
  opts: { secret: string; event: string; payload: unknown; deliveryId?: string; signature?: string }
): Promise<{ status: number; deliveryId: string; body: string }> {
  const body = JSON.stringify(opts.payload)
  const deliveryId = opts.deliveryId ?? randomUUID()
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/test',
      'x-github-event': opts.event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': opts.signature ?? signGithubWebhook(opts.secret, body)
    },
    body
  })
  return { status: response.status, deliveryId, body: await response.text() }
}
