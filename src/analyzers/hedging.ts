import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class HedgingAnalyzer extends BaseAnalyzer {
  readonly name = "hedging";
  readonly category = "conversation";
  readonly priority = 45;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: detect high hedging, evasive language
    return this.noTrigger();
  }
}
