import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fresh temp path for one OwnershipIndex data file. */
export function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'dsh-login-own-')), 'ownership.json')
}
