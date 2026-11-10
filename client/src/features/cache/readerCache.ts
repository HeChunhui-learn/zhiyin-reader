/** 有容量与有效期上限的 LRU，合并同键在途加载；不缓存失败。 */
export class ReaderCache<T> {
  private entries = new Map<string, { value: T; bytes: number; expires: number }>()
  private pending = new Map<string, Promise<T>>()
  private bytes = 0

  constructor(private maxBytes: number, private ttlMs: number, private now = Date.now) {}

  invalidate(key: string): void {
    for (const [id, entry] of this.entries) {
      if (id.startsWith(`${key}\u0001`)) {
        this.entries.delete(id)
        this.bytes -= entry.bytes
      }
    }
  }

  load(key: string, revision: string, fetch: () => Promise<T>): Promise<T> {
    const id = `${key}\u0001${revision}`
    const entry = this.entries.get(id)
    if (entry && entry.expires > this.now()) {
      this.entries.delete(id)
      this.entries.set(id, entry)
      return Promise.resolve(entry.value)
    }
    const existing = this.pending.get(id)
    if (existing) return existing
    const task = Promise.resolve().then(fetch).then(value => {
      const bytes = JSON.stringify(value).length * 2
      this.invalidate(key)
      if (bytes <= this.maxBytes) {
        while (this.bytes + bytes > this.maxBytes && this.entries.size) {
          const oldest = this.entries.keys().next().value!
          this.bytes -= this.entries.get(oldest)!.bytes
          this.entries.delete(oldest)
        }
        this.entries.set(id, { value, bytes, expires: this.now() + this.ttlMs })
        this.bytes += bytes
      }
      return value
    }).finally(() => this.pending.delete(id))
    this.pending.set(id, task)
    return task
  }
}
