// Helper for scripts/kanban-live-smoke.sh (scratch DB url/create/drop/seed, App delivery lookup): run with tsx from packages/control-plane; env only, prints no secrets.
import { createSign } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrisma } from '../packages/control-plane/src/persistence/prisma.js'
import { ensureDefaultTenant } from '../packages/control-plane/src/persistence/ensure-default-tenant.js'
import { DEFAULT_ORG_ID } from '../packages/control-plane/src/config/defaults.js'
import { ApiKeyCodec } from '../packages/control-plane/src/registry/apiKey.js'

const env = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}
const dbName = (): string => {
  const name = env('SMOKE_DB_NAME')
  if (!/^ac_kanban_smoke_[a-z0-9_]+$/.test(name)) throw new Error('SMOKE_DB_NAME must match ac_kanban_smoke_*')
  return name
}

// The scratch URL is the admin URL with only the path swapped (query kept); the result must name the ac_kanban_smoke_* database.
export function scratchUrl(adminUrl: string, name: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${name}`
  if (decodeURIComponent(url.pathname.slice(1)) !== name || !/^ac_kanban_smoke_[a-z0-9_]+$/.test(name))
    throw new Error('scratch database URL does not name an ac_kanban_smoke_* database')
  return url.href
}

async function createOrDropDb(action: 'create-db' | 'drop-db'): Promise<void> {
  const admin = createPrisma(env('SMOKE_ADMIN_URL'), { poolMax: 1 })
  try {
    const found = await admin.$queryRawUnsafe<unknown[]>('SELECT 1 FROM pg_database WHERE datname = $1', dbName())
    if (action === 'create-db' && found.length === 0) await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName()}"`)
    if (action === 'drop-db' && found.length > 0)
      await admin.$executeRawUnsafe(`DROP DATABASE "${dbName()}" WITH (FORCE)`)
    console.log(`${action}: ${dbName()}`)
  } finally {
    await admin.$disconnect()
  }
}

// Seeds what the interactive console flow would: installation row, daemon + key, agent, board.
async function seed(): Promise<void> {
  const databaseUrl = env('DATABASE_URL')
  if (databaseUrl !== scratchUrl(databaseUrl, dbName()))
    throw new Error('DATABASE_URL is not the scratch database; refusing to seed')
  const prisma = createPrisma(databaseUrl, { poolMax: 2 })
  try {
    await ensureDefaultTenant(prisma, { presetAgents: false })
    const installationId = BigInt(env('GITHUB_APP_INSTALLATION_ID'))
    const owner = env('SMOKE_REPO_OWNER')
    await prisma.githubInstallation.upsert({
      where: { installationId },
      create: {
        orgId: DEFAULT_ORG_ID,
        installationId,
        accountLogin: owner,
        accountType: 'User',
        repositorySelection: 'selected',
        permissions: { issues: 'write', contents: 'write', pull_requests: 'write', metadata: 'read' }
      },
      update: { orgId: DEFAULT_ORG_ID, revokedAt: null, suspendedAt: null }
    })
    const daemonId = env('SMOKE_DAEMON_ID')
    const agentId = env('SMOKE_AGENT_ID')
    await prisma.daemon.create({
      data: {
        id: daemonId,
        orgId: DEFAULT_ORG_ID,
        sessionEpoch: 1n,
        maxAgents: 4,
        status: 'ready',
        capabilities: { platforms: [], runtimes: ['claude-acp'], acp: true, features: [] }
      }
    })
    await prisma.agent.create({
      data: { id: agentId, orgId: DEFAULT_ORG_ID, name: env('SMOKE_AGENT_NAME'), runtime: 'claude-acp', daemonId }
    })
    // createKanbanBoard is interactive-OIDC-only (devAuth is refused), so the board row is inserted directly; reads stay on REST.
    await prisma.kanbanBoard.create({
      data: {
        id: env('SMOKE_BOARD_ID'),
        orgId: DEFAULT_ORG_ID,
        name: 'kanban-live-smoke',
        repoId: BigInt(env('SMOKE_REPO_ID')),
        repoFullName: env('SMOKE_REPO')
      }
    })
    const minted = new ApiKeyCodec({ API_KEY_PEPPER: env('API_KEY_PEPPER') }).mint()
    await prisma.apiKey.create({
      data: {
        principalType: 'daemon',
        orgId: DEFAULT_ORG_ID,
        daemonId,
        hash: minted.hash,
        displayTail: minted.displayTail
      }
    })
    // Daemon root: config.json carries the key (mode 0600, state dir only) and agent.json is the local agent definition.
    const root = env('SMOKE_DAEMON_ROOT')
    const workspace = join(root, 'agents', agentId, 'workspace')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    mkdirSync(workspace, { recursive: true })
    const configFile = join(root, 'config.json')
    writeFileSync(
      configFile,
      JSON.stringify({
        version: 1,
        daemonId,
        controlPlane: { enabled: true, url: env('SMOKE_CP_URL'), key: minted.token },
        logging: { level: 'info' }
      }),
      { mode: 0o600 }
    )
    chmodSync(configFile, 0o600) // covers a pre-existing file
    writeFileSync(
      join(root, 'agents', agentId, 'agent.json'),
      JSON.stringify({
        id: agentId,
        name: env('SMOKE_AGENT_NAME'),
        runtime: 'claude-acp',
        workspace: { mode: 'from-scratch', path: workspace },
        integrations: [],
        output: { mode: 'medium' }
      })
    )
    console.log(
      `seed: installation ${installationId}, board ${env('SMOKE_BOARD_ID')}, daemon ${daemonId}, agent ${agentId} (${env('SMOKE_AGENT_NAME')})`
    )
  } finally {
    await prisma.$disconnect()
  }
}

// App deliveries whose payload names `issue`: the X-GitHub-Delivery GUID, event/action, HTTP status, and redelivery flag.
interface Delivery {
  id: string
  guid: string
  event: string
  action: string | null
  status_code: number
  redelivery: boolean
  delivered_at: string
}
interface DeliveryDetail {
  request?: { payload?: { issue?: { number?: number }; repository?: { full_name?: string } } }
}
async function deliveries(issue: number, since: string): Promise<void> {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_CLIENT_ID?.trim() || env('GITHUB_APP_ID') })}`
  const pem = Buffer.from(env('GITHUB_APP_PRIVATE_KEY_B64'), 'base64').toString('utf8')
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url')}`
  // Delivery ids exceed 2^53, so keep them as strings.
  const call = async (path: string): Promise<unknown> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28'
      }
    })
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
    return JSON.parse((await res.text()).replace(/("id":\s*)(\d{16,})/g, '$1"$2"'))
  }
  for (const d of (await call('/app/hook/deliveries?per_page=100')) as Delivery[]) {
    const detail = (await call(`/app/hook/deliveries/${d.id}`)) as DeliveryDetail
    const payload = detail.request?.payload
    if (payload?.issue?.number !== issue || payload?.repository?.full_name !== env('SMOKE_REPO')) continue
    if (since && Date.parse(d.delivered_at) < Date.parse(since)) continue
    console.log(
      JSON.stringify({
        guid: d.guid,
        event: d.event,
        action: d.action,
        status: d.status_code,
        redelivery: d.redelivery,
        at: d.delivered_at
      })
    )
  }
}

const command = process.argv[2]
if (command === 'scratch-url') console.log(scratchUrl(env('SMOKE_ADMIN_URL'), dbName()))
else if (command === 'create-db' || command === 'drop-db') await createOrDropDb(command)
else if (command === 'seed') await seed()
else if (command === 'deliveries') await deliveries(Number(process.argv[3]), process.argv[4] ?? '')
else
  throw new Error(
    'usage: kanban-live-smoke-helper.mts scratch-url|create-db|drop-db|seed|deliveries <issue> [since-iso]'
  )
