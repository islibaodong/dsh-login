/**
 * DefaultWorkspaceSetting — live + persisted on/off flag for per-user default
 * workspace provisioning.
 *
 * Mirrors TrustedHosts' contract: the in-memory value is authoritative for the
 * running process; the JSON file is restart survival (debounced, best-effort).
 * An admin toggles it from the 设置-用户管理 panel via
 * /api/auth/admin/settings/default-workspace; the /api provisioner reads it
 * live (via get/on) so a toggle takes effect without a restart.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Debounce window for coalescing disk writes (ms). */
const SAVE_DEBOUNCE_MS = 200

/**
 * Persisted runtime flag backing the "默认用户工作空间" toggle.
 *
 * @param filePath JSON file holding `{ enabled: boolean }`.
 * @param initial Fallback when the file is absent/corrupt (the config default).
 */
export class DefaultWorkspaceSetting {
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

  /** Whether per-user default-workspace provisioning is currently on. */
  get(): boolean {
    return this.enabled
  }

  /**
   * Set the flag and persist it. Returns the new value. Best-effort write.
   */
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