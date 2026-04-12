import type { AnalyzerResult } from "../models/types";

export class Prioritizer {
  private activeResult: AnalyzerResult | null = null;
  private activeExpiresAt = 0;

  /** Returns true if this result should be displayed on the HUD. */
  shouldDisplay(result: AnalyzerResult): boolean {
    if (!result.triggered) return false;

    const now = Date.now();

    // If a higher-priority result is still active, suppress this one
    if (this.activeResult && now < this.activeExpiresAt) {
      if (result.priority < this.activeResult.priority) return false;
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
