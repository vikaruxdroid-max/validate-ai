import { BaseAnalyzer } from "./base";
import { claudeRequest } from "../services/claude";
import { FACT_EXTRACTION_SYSTEM } from "../prompts/haiku";
import { FACT_VALIDATION_SYSTEM } from "../prompts/sonnet";
import type {
  AnalyzerContext,
  AnalyzerResult,
  ValidationResult,
  Verdict,
  Confidence,
} from "../models/types";

// ── Trigger detection ───────────────────────────────────────────────

const TRIGGERS = [
  // Primary: "even check" + common STT mishearings
  "even check",
  "even czech",
  "even jack",
  "even chek",
  // Alternatives
  "fact check",
  "check this",
];

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function detectTrigger(text: string): string | null {
  const clean = normalize(text);
  for (const t of TRIGGERS) {
    if (clean.includes(t)) return t;
  }
  return null;
}

// ── Analyzer ────────────────────────────────────────────────────────

export class FactValidationAnalyzer extends BaseAnalyzer {
  readonly name = "factValidation";
  readonly category = "verification";
  readonly priority = 90;
  readonly schedule = "active" as const;
  readonly intervalMs = 0; // trigger-based only
  readonly defaultCooldownMs = 30_000;

  /** Check if a transcript segment contains a trigger phrase. */
  checkTrigger(latestText: string): string | null {
    return detectTrigger(latestText);
  }

  async analyze(ctx: AnalyzerContext): Promise<AnalyzerResult> {
    const text = ctx.rollingText;
    if (text.trim().length < 10) {
      return this.result({
        confidence: "LOW",
        title: "No Speech",
        summary: "Not enough speech to validate",
        suggestedHudMode: "COMPACT",
        expiresInMs: 5000,
      });
    }

    // Step 1: Extract claim via Haiku
    console.log("[FactValidation] extracting claim...");
    const claim = await this.extractClaim(text);
    if (!claim || claim === "NONE") {
      return this.result({
        confidence: "LOW",
        title: "No Claim",
        summary: "No verifiable claim found",
        suggestedHudMode: "COMPACT",
        expiresInMs: 5000,
      });
    }
    console.log("[FactValidation] claim:", claim);

    // Step 2: Validate via Sonnet + web search
    console.log("[FactValidation] checking claim...");
    const validation = await this.validateClaim(claim);
    console.log("[FactValidation] result:", JSON.stringify(validation));

    return this.result({
      confidence: validation.confidence,
      title: validation.verdict,
      summary: validation.summary,
      suggestedHudMode: "CARD",
      expiresInMs: 10_000,
      details: { verdict: validation.verdict, claim },
    });
  }

  // ── Claude pipeline (migrated from main.ts) ──────────────────────

  private async extractClaim(recentText: string): Promise<string | null> {
    const text = await claudeRequest(
      "claude-haiku-4-5-20251001",
      FACT_EXTRACTION_SYSTEM,
      recentText,
      undefined,
      128,
    );
    const trimmed = text.trim();
    return trimmed || null;
  }

  private async validateClaim(claim: string): Promise<ValidationResult> {
    const text = await claudeRequest(
      "claude-sonnet-4-20250514",
      FACT_VALIDATION_SYSTEM,
      `Fact-check: "${claim}"`,
      [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      256,
    );

    console.log("[FactValidation] raw Claude text:", text);

    // Try JSON parse first
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          verdict: parsed.verdict ?? "DISPUTED",
          summary: parsed.summary ?? "Unable to determine",
          confidence: parsed.confidence ?? "LOW",
        };
      } catch (e) {
        console.warn("[FactValidation] JSON parse failed:", e);
      }
    }

    // Fallback: extract verdict/summary from raw text via regex
    console.log("[FactValidation] attempting regex fallback");
    const verdictMatch = text.match(/\b(SUPPORTED|PARTIAL|DISPUTED)\b/i);
    const summaryMatch = text.match(/summary[:\s]*["']?([^"'\n]{5,80})/i);
    const confMatch = text.match(/\b(HIGH|MED|LOW)\b/i);

    if (verdictMatch) {
      return {
        verdict: verdictMatch[1].toUpperCase() as Verdict,
        summary: summaryMatch?.[1]?.trim() ?? text.slice(0, 80),
        confidence: (confMatch?.[1]?.toUpperCase() as Confidence) ?? "LOW",
      };
    }

    // Complete failure
    throw new Error("CHECK FAILED: " + text.slice(0, 80));
  }
}
