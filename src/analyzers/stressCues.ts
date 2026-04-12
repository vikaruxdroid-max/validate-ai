import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class StressCuesAnalyzer extends BaseAnalyzer {
  readonly name = "stressCues";
  readonly category = "analysis";
  readonly priority = 40;
  readonly schedule = "passive" as const;
  readonly intervalMs = 5000;
  readonly defaultCooldownMs = 20_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: detect elevated stress cues, hesitant delivery
    return this.noTrigger();
  }
}
