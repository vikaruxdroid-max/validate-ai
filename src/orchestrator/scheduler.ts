import type { BaseAnalyzer } from "../analyzers/base";

interface ScheduledEntry {
  analyzer: BaseAnalyzer;
  lastRun: number;
}

export class Scheduler {
  private passive: ScheduledEntry[] = [];
  private active: BaseAnalyzer[] = [];

  register(analyzer: BaseAnalyzer): void {
    if (analyzer.schedule === "passive") {
      this.passive.push({ analyzer, lastRun: 0 });
    } else {
      this.active.push(analyzer);
    }
  }

  /** Returns passive analyzers that are due to run based on their interval. */
  getPassiveDue(now: number): BaseAnalyzer[] {
    const due: BaseAnalyzer[] = [];
    for (const entry of this.passive) {
      if (now - entry.lastRun >= entry.analyzer.intervalMs) {
        due.push(entry.analyzer);
        entry.lastRun = now;
      }
    }
    return due;
  }

  getActiveAnalyzers(): BaseAnalyzer[] {
    return this.active;
  }

  getAllAnalyzers(): BaseAnalyzer[] {
    return [
      ...this.active,
      ...this.passive.map((e) => e.analyzer),
    ];
  }
}
