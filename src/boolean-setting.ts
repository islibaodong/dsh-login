/**
 * BooleanSetting — live + persisted on/off flag, the shared runtime-toggle
 * backing for dsh-login admin switches (per-user default workspace, remote-web-ui
 * compatibility, ...).
 *
 * Mirrors TrustedHosts' contract: the in-memory value is authoritative for the
 * running process; the JSON file is restart survival (debounced, best-effort).
 * Admin toggles it from the 设置-用户管理 panel via /api/auth/admin/settings/<name>;
 * runtime consumers read it live via `get()` so a toggle takes effect instantly.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Debounce window for coalescing disk writes (ms). */
const SAVE_DEBOUNCE_MS = 200

/**
 * Persisted `{ enabled: boolean }` runtime flag.
 *
 * @param filePath JSON file holding `{ enabled: boolean }`.
 * @param initial Fallback when the file is absent/corrupt (the config default).
 */
export class BooleanSetting {
  private enabled: boolean
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  /** Tail of a single serialized write queue; writes never overlap. */
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string, initial: boolean) {
    this.enabled = initial
    try {
      const raw = readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed !== null && typeof parsed === 'object' && typeof (parsed as { enabled?: unknown }).enabled === 'boolean') {
        this.enabled = (parsed as { enabled: boolean }).enabled
      }
    } catch { /* absent or corrupt: keep the initial/config default */ }
  }

  /** Whether the toggle is currently on. */
  get(): boolean {
    return this.enabled
  }

  /** Set the flag and persist it (best-effort). Returns the new value. */
  set(enabled: boolean): boolean {
    this.enabled = enabled
    this.scheduleSave()
    return this.enabled
  }

  /** Force the pending save; resolves when the queued write settled. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    this.saving = this.saving.then(() => this.writeNow())
    await this.saving
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      this.saving = this.saving.then(() => this.writeNow())
    }, SAVE_DEBOUNCE_MS)
  }

  private async writeNow(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, `${JSON.stringify({ enabled: this.enabled })}\n`, 'utf8')
    } catch { /* persistence is best-effort; memory stays authoritative */ }
  }
}