import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class RecallAnalyzer extends BaseAnalyzer {
  readonly name = "recall";
  readonly category = "memory";
  readonly priority = 80;
  readonly schedule = "active" as const;
  readonly intervalMs = 0; // trigger-based only
  readonly defaultCooldownMs = 10_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: recall previous conversation context on trigger
    return this.noTrigger();
  }
}
