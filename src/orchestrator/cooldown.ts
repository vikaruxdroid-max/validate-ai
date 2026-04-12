export class CooldownEngine {
  private cooldowns = new Map<string, number>();

  setCooldown(key: string, durationMs: number): void {
    this.cooldowns.set(key, Date.now() + durationMs);
  }

  isInCooldown(key: string): boolean {
    const until = this.cooldowns.get(key);
    if (!until) return false;
    if (Date.now() >= until) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }

  clear(key: string): void {
    this.cooldowns.delete(key);
  }

  clearAll(): void {
    this.cooldowns.clear();
  }
}
