import { BaseAnalyzer } from "./base";
import type { AnalyzerContext, AnalyzerResult } from "../models/types";

export class CommitmentsAnalyzer extends BaseAnalyzer {
  readonly name = "commitments";
  readonly category = "conversation";
  readonly priority = 60;
  readonly schedule = "passive" as const;
  readonly intervalMs = 3000;
  readonly defaultCooldownMs = 15_000;

  async analyze(_ctx: AnalyzerContext): Promise<AnalyzerResult> {
    // Phase 2: detect promises, commitments, deadlines in speech
    return this.noTrigger();
  }
}
