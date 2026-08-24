import { priceCall, type PriceableCall } from "./pricing.ts";

export interface CostRow extends PriceableCall {
  operation: string;
  tenant_id: string | null;
  user_id: string | null;
  ts: string;
}

export function providerOf(model: string | null): string {
  const m = model ?? "";
  if (m.startsWith("gemini")) return "gemini";
  if (m.startsWith("claude")) return "claude";
  return "self-hosted";
}

export interface CostRollup {
  total: number;
  today: number;
  last7d: number;
  projected30d: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  byOperation: Record<string, number>;
  byUser: Record<string, number>;
}

export function computeCost(rows: CostRow[], now: number): CostRollup {
  const dayMs = 86_400_000;
  const acc: CostRollup = {
    total: 0,
    today: 0,
    last7d: 0,
    projected30d: 0,
    byProvider: {},
    byModel: {},
    byOperation: {},
    byUser: {},
  };
  for (const r of rows) {
    const usd = priceCall(r);
    acc.total += usd;
    const age = now - Date.parse(r.ts);
    if (age <= dayMs) acc.today += usd;
    if (age <= 7 * dayMs) acc.last7d += usd;
    const add = (o: Record<string, number>, k: string) => {
      o[k] = (o[k] ?? 0) + usd;
    };
    add(acc.byProvider, providerOf(r.model));
    add(acc.byModel, r.model ?? "unknown");
    add(acc.byOperation, r.operation ?? "unknown");
    add(acc.byUser, r.tenant_id ?? r.user_id ?? "unknown");
  }
  acc.projected30d = (acc.last7d / 7) * 30;
  return acc;
}

export interface BudgetBurn {
  provider: string;
  budgetUsd: number;
  spentUsd: number;
  remainingUsd: number;
  pctConsumed: number;
  burnPerDay: number;
  etaDays: number | null;
}

export function computeBudget(
  spentByProvider: Record<string, number>,
  budgets: Record<string, number>,
  windowDays: number,
): BudgetBurn[] {
  return Object.entries(budgets).map(([provider, budgetUsd]) => {
    const spentUsd = spentByProvider[provider] ?? 0;
    const remainingUsd = budgetUsd - spentUsd;
    const burnPerDay = windowDays > 0 ? spentUsd / windowDays : 0;
    return {
      provider,
      budgetUsd,
      spentUsd,
      remainingUsd,
      pctConsumed: budgetUsd > 0 ? (spentUsd / budgetUsd) * 100 : 0,
      burnPerDay,
      etaDays: burnPerDay > 0 ? remainingUsd / burnPerDay : null,
    };
  });
}
