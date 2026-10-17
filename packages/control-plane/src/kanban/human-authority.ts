// Runtime identity prevents tool arguments, copies, and JSON from carrying human authority.
import type { RepoPermissionLevel } from '../github/repo-permission.js'

declare const humanAuthorityBrand: unique symbol

export interface KanbanHumanAuthority {
  readonly [humanAuthorityBrand]: true
  readonly login: string
  readonly permission: RepoPermissionLevel
}

const attested = new WeakSet<object>()

/** Importer and future human-path factories only: attest after live human identity and permission checks. */
export function attestHumanAuthority(login: string, permission: RepoPermissionLevel): KanbanHumanAuthority {
  const authority = Object.freeze({ login, permission }) as KanbanHumanAuthority
  attested.add(authority)
  return authority
}

export function isAttestedHumanAuthority(value: unknown): value is KanbanHumanAuthority {
  return typeof value === 'object' && value !== null && attested.has(value)
}
