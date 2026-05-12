// Per-session token budget tracker.
//
// Used by the orchestrator to add usage from each agent call and to enforce
// a hard cap. The cap is configurable; default 300_000 (from the spec).

export class BudgetExceededError extends Error {
  constructor(message, { usage, budget } = {}) {
    super(message);
    this.name = 'BudgetExceededError';
    if (usage) this.usage = usage;
    if (typeof budget === 'number') this.budget = budget;
  }
}

/**
 * Create a fresh token tracker.
 *
 * @param {{ budget?: number, initial?: { input?: number, output?: number } }} [options]
 * @returns {{
 *   add(usage: { input?: number, output?: number }): void,
 *   check(): void,
 *   totals: { input: number, output: number, total: number },
 *   remaining: number,
 *   budget: number,
 *   snapshot(): { input: number, output: number, total: number, budget: number, remaining: number },
 * }}
 */
export function createTokenTracker({ budget = 300_000, initial = {} } = {}) {
  let input = Math.max(0, initial.input ?? 0);
  let output = Math.max(0, initial.output ?? 0);

  function totals() {
    return { input, output, total: input + output };
  }

  return {
    add(usage) {
      if (!usage || typeof usage !== 'object') return;
      input += Math.max(0, usage.input ?? 0);
      output += Math.max(0, usage.output ?? 0);
    },

    check() {
      const t = input + output;
      if (t >= budget) {
        throw new BudgetExceededError(
          `Token budget exceeded: ${t} / ${budget}`,
          { usage: totals(), budget }
        );
      }
    },

    get totals() {
      return totals();
    },

    get remaining() {
      return Math.max(0, budget - input - output);
    },

    get budget() {
      return budget;
    },

    snapshot() {
      const t = totals();
      return { ...t, budget, remaining: Math.max(0, budget - t.total) };
    },
  };
}
