import type { AnalyzerContext, AnalyzerResult, SuggestedHudMode } from "../models/types";

export type AnalyzerSchedule = "passive" | "active";

export abstract class BaseAnalyzer {
  abstract readonly name: string;
  abstract readonly category: string;
  abstract readonly priority: number;
  abstract readonly schedule: AnalyzerSchedule;
  abstract readonly intervalMs: number;
  abstract readonly defaultCooldownMs: number;

  abstract analyze(ctx: AnalyzerContext): Promise<AnalyzerResult>;

  protected noTrigger(): AnalyzerResult {
    return {
      analyzer: this.name,
      triggered: false,
      priority: this.priority,
      confidence: "LOW",
      category: this.category,
      title: "",
      summary: "",
      suggestedHudMode: "PASSIVE",
    };
  }

  protected result(opts: {
    confidence: AnalyzerResult["confidence"];
    title: string;
    summary: string;
    suggestedHudMode?: SuggestedHudMode;
    details?: Record<string, unknown>;
    expiresInMs?: number;
    cooldownKey?: string;
  }): AnalyzerResult {
    return {
      analyzer: this.name,
      triggered: true,
      priority: this.priority,
      confidence: opts.confidence,
      category: this.category,
      title: opts.title,
      summary: opts.summary,
      suggestedHudMode: opts.suggestedHudMode ?? "CARD",
      details: opts.details,
      expiresInMs: opts.expiresInMs,
      cooldownKey: opts.cooldownKey ?? this.name,
    };
  }
}
