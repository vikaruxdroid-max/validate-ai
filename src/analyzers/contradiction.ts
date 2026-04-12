import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class ContradictionAnalyzer extends BaseAnalyzer {
  readonly name = "contradiction";
  readonly category = "analysis";
  readonly priority = 70;
  readonly schedule = "passive" as const;
  readonly intervalMs = 5000;
  readonly defaultCooldownMs = 20_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: detect contradictions within the conversation
    return this.noTrigger();
  }
}
