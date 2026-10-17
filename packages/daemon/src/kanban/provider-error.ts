// Kanban provider-error classifier (issue #2 M3): transient vs fatal from the turn's ACP error; pure, and unknown stays today's failed/turn_error.
import type { KanbanProviderReasonCode } from '@agentconnect.md/protocol'
import { AcpConnectionClosedError } from '../acp/transport-error.js'

export type ProviderErrorClass =
  | { kind: 'transient'; reasonCode: KanbanProviderReasonCode }
  | { kind: 'fatal'; reasonCode: KanbanProviderReasonCode | 'turn_error' }

/** The pre-classification behavior for an error nothing recognizes. */
export const UNCLASSIFIED_PROVIDER_ERROR: ProviderErrorClass = { kind: 'fatal', reasonCode: 'turn_error' }

const FIELDS = ['message', 'code', 'status', 'statusCode', 'type', 'reason', 'error', 'data', 'details', 'cause']

interface Signals {
  codes: Set<number>
  text: string
}

/** Walks the small family of fields ACP adapters and provider SDKs use to wrap an upstream error; depth and seen guards bound it. */
function collect(value: unknown, out: Signals, depth = 0, seen = new Set<object>()): void {
  if (typeof value === 'number' && Number.isInteger(value)) out.codes.add(value)
  else if (typeof value === 'string') {
    if (/^-?\d{3,5}$/.test(value.trim())) out.codes.add(Number(value.trim()))
    out.text += `\n${value.slice(0, 2000)}`
  } else if (value && typeof value === 'object' && depth < 5 && !seen.has(value)) {
    seen.add(value)
    if (Array.isArray(value)) for (const v of value.slice(0, 20)) collect(v, out, depth + 1, seen)
    else
      for (const key of FIELDS) {
        try {
          collect(Reflect.get(value, key), out, depth + 1, seen)
        } catch {
          // A hostile getter must not replace the original turn error.
        }
      }
  }
}

const has = (re: RegExp, text: string) => re.test(text)
// A bare status number only counts beside a word that makes it a status, never inside prose like "500 files"; ACP -32000 is authRequired.
const status = (nums: string) => new RegExp(`\\b(?:status|http|error|code)\\W{0,3}(?:${nums})\\b`, 'i')

const CONTEXT =
  /context[_ ](?:length|window)|prompt is too long|prompt too long|maximum context|too many tokens|input is too long/i
const AUTH =
  /unauthori[sz]ed|forbidden|invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|not logged in|authenticat|permission_denied|please run \/login|\blogin required\b/i
const INVALID = /invalid_request_error|invalid params|invalid request|bad request/i
const OVERLOADED = /overloaded/i
const RATE =
  /rate[_ -]?limit|too many requests|resource_exhausted|requests? per min|tokens? per min|per[- ]minute|usage limit|quota (?:exceeded|exhausted)/i
const NETWORK =
  /epipe|broken pipe|econnreset|etimedout|enotfound|eai_again|econnrefused|enetunreach|socket hang up|fetch failed|network (?:error|request failed)|connection (?:reset|refused|error|terminated)/i
const SERVER = /internal server error|bad gateway|service unavailable|gateway time-?out|server_error|api_error/i

/** Classify a settled turn's error: transient retries with backoff and is not counted; fatal is a counted failure. */
export function classifyProviderError(err: unknown): ProviderErrorClass {
  const s: Signals = { codes: new Set(), text: '' }
  collect(err, s)
  const { codes, text } = s
  const anyCode = (...n: number[]) => n.some((c) => codes.has(c))

  if (has(CONTEXT, text)) return { kind: 'fatal', reasonCode: 'provider_context_overflow' }
  if (anyCode(401, 403, -32000) || has(AUTH, text) || has(status('401|403'), text))
    return { kind: 'fatal', reasonCode: 'provider_auth' }
  if (anyCode(400, -32602) || has(INVALID, text) || has(status('400'), text))
    return { kind: 'fatal', reasonCode: 'provider_invalid_request' }
  if (anyCode(529) || has(OVERLOADED, text) || has(status('529'), text))
    return { kind: 'transient', reasonCode: 'provider_overloaded' }
  if (anyCode(429) || has(RATE, text) || has(status('429'), text))
    return { kind: 'transient', reasonCode: 'provider_rate_limited' }
  if ([...codes].some((code) => code >= 500 && code <= 599) || has(SERVER, text) || has(status('5[0-9]{2}'), text))
    return { kind: 'transient', reasonCode: 'provider_server_error' }

  if (err instanceof AcpConnectionClosedError) return { kind: 'fatal', reasonCode: 'agent_crashed' }
  if (has(NETWORK, text)) return { kind: 'transient', reasonCode: 'provider_network' }

  return UNCLASSIFIED_PROVIDER_ERROR
}
