import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class IntentAnalyzer extends BaseAnalyzer {
  readonly name = "intent";
  readonly category = "conversation";
  readonly priority = 50;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: detect persuasion intent, speculative framing
    return this.noTrigger();
  }
}
