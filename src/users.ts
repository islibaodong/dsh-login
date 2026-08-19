import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'

export interface UserRecord {
  username: string
  hash: string
  salt: string
  isAdmin: boolean
  createdAt: number
}

const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/
const KEY_LEN = 64

function hashPassword(password: string, saltHex: string): string {
  return scryptSync(password, Buffer.from(saltHex, 'hex'), KEY_LEN).toString('hex')
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'))
}

export class UserStore {
  constructor(
    private readonly credentials: CredentialProvider,
    private readonly ref: CredentialRef,
  ) {}

  async list(): Promise<UserRecord[]> {
    const resolved = await this.credentials.resolve(this.ref)
    if (resolved === undefined) return []
    try {
      const parsed = JSON.parse(resolved.value) as UserRecord[]
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  async isEmpty(): Promise<boolean> {
    return (await this.list()).length === 0
  }

  async create(username: string, password: string, isAdmin: boolean): Promise<UserRecord> {
    if (!USERNAME_PATTERN.test(username)) throw new Error('invalid username')
    if (password.length === 0) throw new Error('password must not be empty')
    const records = await this.list()
    if (records.some(u => u.username === username)) throw new Error(`user "${username}" already exists`)
    const salt = randomBytes(16).toString('hex')
    const record: UserRecord = {
      username, salt, hash: hashPassword(password, salt),
      isAdmin: records.length === 0 ? true : isAdmin,
      createdAt: Date.now(),
    }
    await this.credentials.set(this.ref, JSON.stringify([...records, record]))
    return record
  }

  async verify(username: string, password: string): Promise<UserRecord | undefined> {
    const record = (await this.list()).find(u => u.username === username)
    if (record === undefined) return undefined
    return constantTimeEqualHex(hashPassword(password, record.salt), record.hash) ? record : undefined
  }

  async setPassword(username: string, password: string): Promise<void> {
    if (password.length === 0) throw new Error('password must not be empty')
    const records = await this.list()
    const record = records.find(u => u.username === username)
    if (record === undefined) throw new Error(`unknown user "${username}"`)
    record.salt = randomBytes(16).toString('hex')
    record.hash = hashPassword(password, record.salt)
    await this.credentials.set(this.ref, JSON.stringify(records))
  }

  async remove(username: string): Promise<void> {
    const records = await this.list()
    const next = records.filter(u => u.username !== username)
    if (next.length === records.length) throw new Error(`unknown user "${username}"`)
    await this.credentials.set(this.ref, JSON.stringify(next))
  }
}
