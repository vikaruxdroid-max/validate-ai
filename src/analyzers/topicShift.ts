import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class TopicShiftAnalyzer extends BaseAnalyzer {
  readonly name = "topicShift";
  readonly category = "conversation";
  readonly priority = 30;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 10_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: detect significant topic changes
    return this.noTrigger();
  }
}
