import type { AnalyzerResult } from "../models/types";

const MODE_RANK: Record<string, number> = {
  ALERT: 3,
  CARD: 2,
  COMPACT: 1,
  PASSIVE: 0,
};

export class Prioritizer {
  private activeResult: AnalyzerResult | null = null;
  private activeExpiresAt = 0;

  /** Returns true if this result should be displayed on the HUD. */
  shouldDisplay(result: AnalyzerResult): boolean {
    if (!result.triggered) return false;

    const now = Date.now();

    if (this.activeResult && now < this.activeExpiresAt) {
      const activeRank = MODE_RANK[this.activeResult.suggestedHudMode] ?? 0;
      const newRank = MODE_RANK[result.suggestedHudMode] ?? 0;

      // Never interrupt CARD or ALERT with a PASSIVE cue
      if (newRank < activeRank) return false;

      // Same rank: only allow if higher priority
      if (newRank === activeRank && result.priority < this.activeResult.priority) {
        return false;
      }
    }

    this.activeResult = result;
    this.activeExpiresAt = now + (result.expiresInMs ?? 10_000);
    return true;
  }

  getActive(): AnalyzerResult | null {
    if (this.activeResult && Date.now() >= this.activeExpiresAt) {
      this.activeResult = null;
    }
    return this.activeResult;
  }

  clear(): void {
    this.activeResult = null;
    this.activeExpiresAt = 0;
  }
}
