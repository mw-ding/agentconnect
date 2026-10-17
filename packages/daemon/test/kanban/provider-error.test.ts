import { describe, expect, it } from 'vitest'
import { KANBAN_PROVIDER_REASON_CODES, KanbanReasonCode } from '@agentconnect.md/protocol'
import { AcpConnectionClosedError } from '../../src/acp/transport-error.js'
import { classifyProviderError } from '../../src/kanban/provider-error.js'

/** An ACP RequestError shape: JSON-RPC code, a title, and the runtime's own text under data. */
const rpc = (code: number, message: string, data?: unknown) => Object.assign(new Error(message), { code, data })

const transient = (reasonCode: string) => ({ kind: 'transient', reasonCode })
const fatal = (reasonCode: string) => ({ kind: 'fatal', reasonCode })

describe('classifyProviderError', () => {
  it.each([
    [
      '429 status code',
      rpc(-32603, 'Internal error', { message: 'API Error: 429 {"type":"rate_limit_error"}' }),
      transient('provider_rate_limited')
    ],
    ['rate limit phrase', new Error('Rate limit reached for requests per min'), transient('provider_rate_limited')],
    ['too many requests', new Error('Too Many Requests'), transient('provider_rate_limited')],
    ['numeric http status field', Object.assign(new Error('x'), { status: 429 }), transient('provider_rate_limited')],
    [
      'resource exhausted',
      new Error('RESOURCE_EXHAUSTED: quota exceeded for metric'),
      transient('provider_rate_limited')
    ],
    [
      '529 overloaded',
      rpc(-32603, 'Internal error', { message: 'API Error: 529 overloaded_error' }),
      transient('provider_overloaded')
    ],
    ['overloaded phrase', new Error('Overloaded'), transient('provider_overloaded')],
    ['ECONNRESET', new Error('read ECONNRESET'), transient('provider_network')],
    ['ETIMEDOUT', new Error('connect ETIMEDOUT 1.2.3.4:443'), transient('provider_network')],
    ['ENOTFOUND', new Error('getaddrinfo ENOTFOUND api.anthropic.com'), transient('provider_network')],
    ['socket hang up', new Error('socket hang up'), transient('provider_network')],
    [
      'fetch failed',
      new TypeError('fetch failed', { cause: new Error('other side closed') }),
      transient('provider_network')
    ],
    [
      'nested cause code',
      new Error('request failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) }),
      transient('provider_network')
    ],
    ['500', new Error('API Error: 500 Internal Server Error'), transient('provider_server_error')],
    ['501 status field', { status: 501 }, transient('provider_server_error')],
    ['507 HTTP status', new Error('HTTP 507'), transient('provider_server_error')],
    ['400 wins over api_error', { status: 400, type: 'api_error' }, fatal('provider_invalid_request')],
    ['502 bad gateway', new Error('Bad Gateway'), transient('provider_server_error')],
    ['503', Object.assign(new Error('upstream'), { statusCode: 503 }), transient('provider_server_error')],
    ['service unavailable', new Error('Service Unavailable'), transient('provider_server_error')],
    ['gateway timeout', new Error('504 Gateway Timeout'), transient('provider_server_error')],
    ['ACP connection closed', new Error('ACP connection closed'), fatal('turn_error')],
    ['process exited with code', new Error('agent process exited with code 1'), fatal('turn_error')],
    ['child process died', new Error('child process exited'), fatal('turn_error')],
    ['broken pipe', new Error('write EPIPE'), transient('provider_network')],
    ['agent crashed', new Error('agent crashed'), fatal('turn_error')],
    ['provider-side EPIPE', new Error('fetch failed', { cause: { code: 'EPIPE' } }), transient('provider_network')],
    [
      '429 with process-exit prose',
      { code: 429, message: 'usage limit; process exited with code 1' },
      transient('provider_rate_limited')
    ],
    [
      'tool exit in details',
      rpc(-32603, 'Internal error', { details: 'command exited with code 2' }),
      fatal('turn_error')
    ],
    ['agent transport reset', new AcpConnectionClosedError(new Error('connection reset')), fatal('agent_crashed')],
    ['agent transport EOF', new AcpConnectionClosedError(new Error('ACP connection closed')), fatal('agent_crashed')],
    [
      'remote code cannot forge a transport marker',
      { code: 'ACP_CONNECTION_CLOSED', message: 'agent crashed' },
      fatal('turn_error')
    ],
    ...[
      [429, 'provider_rate_limited'],
      [529, 'provider_overloaded'],
      [503, 'provider_server_error'],
      [401, 'provider_auth'],
      [403, 'provider_auth'],
      [400, 'provider_invalid_request']
    ].map(([code, reason]): [string, AcpConnectionClosedError, ReturnType<typeof fatal>] => [
      `structured ${code} precedes the transport marker`,
      new AcpConnectionClosedError({ status: code }),
      code === 400 || code === 401 || code === 403 ? fatal(String(reason)) : transient(String(reason))
    ]),
    [
      '401',
      rpc(-32603, 'Internal error', { message: 'Failed to authenticate. API Error: 401 invalid x-api-key' }),
      fatal('provider_auth')
    ],
    ['403', Object.assign(new Error('nope'), { status: 403 }), fatal('provider_auth')],
    ['invalid api key', new Error('Incorrect API key provided: sk-***'), fatal('provider_auth')],
    ['not logged in', new Error('Not logged in · Please run /login'), fatal('provider_auth')],
    ['ACP authRequired -32000', rpc(-32000, 'Authentication required'), fatal('provider_auth')],
    ['400', Object.assign(new Error('bad'), { status: 400 }), fatal('provider_invalid_request')],
    [
      'invalid_request_error',
      new Error('invalid_request_error: messages: text content blocks must be non-empty'),
      fatal('provider_invalid_request')
    ],
    ['-32602 invalid params', rpc(-32602, 'Invalid params'), fatal('provider_invalid_request')],
    [
      'context length',
      new Error("This model's maximum context length is 200000 tokens"),
      fatal('provider_context_overflow')
    ],
    [
      'prompt too long',
      rpc(-32603, 'Internal error', { message: 'Prompt is too long' }),
      fatal('provider_context_overflow')
    ],
    ['context_length_exceeded', new Error('context_length_exceeded'), fatal('provider_context_overflow')]
  ])('%s', (_name, err, expected) => {
    expect(classifyProviderError(err)).toEqual(expected)
  })

  it('context overflow wins over the 400 it arrives as', () => {
    expect(classifyProviderError(Object.assign(new Error('prompt is too long'), { status: 400 }))).toEqual(
      fatal('provider_context_overflow')
    )
  })

  it('auth wins over a rate-limit word in the same message', () => {
    expect(classifyProviderError(new Error('401 unauthorized (rate limit headers omitted)'))).toEqual(
      fatal('provider_auth')
    )
  })

  it.each([
    ['generic internal error', rpc(-32603, 'Internal error')],
    ['plain failure', new Error('something odd happened')],
    ['prose with a number', new Error('refactored 500 files and 429 tests')],
    ['non-error', 42.5],
    ['undefined', undefined],
    ['string', 'boom']
  ])('unknown stays failed/turn_error: %s', (_n, err) => {
    expect(classifyProviderError(err)).toEqual(fatal('turn_error'))
  })

  it('survives circular and hostile errors', () => {
    const loop: Record<string, unknown> = { message: 'ECONNRESET' }
    loop.cause = loop
    expect(classifyProviderError(loop)).toEqual(transient('provider_network'))
    const hostile = {
      get message(): string {
        throw new Error('getter')
      }
    }
    expect(classifyProviderError(hostile)).toEqual(fatal('turn_error'))
  })

  it('only emits reason codes the protocol accepts', () => {
    for (const code of KANBAN_PROVIDER_REASON_CODES) expect(KanbanReasonCode.safeParse(code).success).toBe(true)
  })
})
