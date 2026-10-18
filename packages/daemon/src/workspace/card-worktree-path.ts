import * as path from 'node:path'

// Git prints forward slashes on Windows; compare canonical spellings before deciding whether a registration is ours.
export function cardWorktreeLocation(
  worktreePath: string,
  cwd: string,
  paths: Pick<typeof path, 'resolve' | 'dirname' | 'basename' | 'sep'> = path
): 'same' | 'managed' | 'foreign' {
  const canonical = (value: string) => {
    const resolved = paths.resolve(value)
    return paths.sep === '\\' ? resolved.toLowerCase() : resolved
  }
  const worktree = canonical(worktreePath)
  const destination = canonical(cwd)
  if (worktree === destination) return 'same'
  return paths.dirname(worktree) === paths.dirname(destination) && /^[a-f0-9]{24}$/.test(paths.basename(worktree))
    ? 'managed'
    : 'foreign'
}
