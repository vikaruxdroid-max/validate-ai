import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class DecisionsAnalyzer extends BaseAnalyzer {
  readonly name = "decisions";
  readonly category = "conversation";
  readonly priority = 55;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: detect decisions, agreements, action items
    return this.noTrigger();
  }
}
