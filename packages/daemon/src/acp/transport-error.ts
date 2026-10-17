// Only the local ACP connection lifecycle can create this marker; provider payloads are never trusted as one.
export class AcpConnectionClosedError extends Error {
  readonly code = 'ACP_CONNECTION_CLOSED'

  constructor(cause: unknown) {
    super('ACP connection closed', { cause })
    this.name = 'AcpConnectionClosedError'
  }
}
