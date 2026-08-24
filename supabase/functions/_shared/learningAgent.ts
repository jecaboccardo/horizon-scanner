/**
 * supabase/functions/_shared/learningAgent.ts
 *
 * Bayesian learning agent — converts accumulated user feedback into
 * weight proposals for each methodology domain per user.
 *
 * Pure functions (no side effects, no DB):
 *   updateBeta       — update Beta distribution params from new signals
 *   clampWeight      — apply per-step +/-15% and absolute [0.5, 2.0] bounds
 *   checkDrift       — detect aggregate drift across all proposals
 *   buildExplanation — plain-language description of a weight change
 *
 * Orchestrator (requires Supabase adminClient):
 *   runLearningAgent — full pipeline: fetch feedback -> compute -> write proposals
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum number of signals required before computing a weight update */
const MIN_SIGNALS = 8;

/** Absolute weight bounds */
const WEIGHT_MIN = 0.5;
const WEIGHT_MAX = 2.0;

/** Maximum per-step fractional change in either direction */
const STEP_LIMIT = 0.15;

/** Drift threshold: mean |proposedWeight - 1.0| > this fires an alert */
const DRIFT_THRESHOLD = 0.10;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BetaUpdateResult {
  newAlpha: number;
  newBeta: number;
  rawWeight: number;
}

interface DriftCheckResult {
  exceeded: boolean;
  pct: number;
}

interface Proposal {
  userId: string;
  domain: string;
  currentWeight: number;
  proposedWeight: number;
  newAlpha: number;
  newBeta: number;
  explanation: string;
  signalCount: number;
}

interface LearningAgentResult {
  usersProcessed: number;
  proposalsCreated: number;
  alertFired: boolean;
  processedSignals: number;
}

// deno-lint-ignore no-explicit-any
interface FeedbackRow {
  id: string;
  user_id: string;
  work_id: string | null;
  brief_id: string | null;
  type: string;
  processed_at: string | null;
  works: { methodology_design: string | null } | null;
}

interface FeedbackGroup {
  userId: string;
  domain: string;
  signals: string[];
  ids: string[];
}

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Update Beta distribution parameters with new signal counts.
 *
 * rawWeight maps the posterior mean from (0,1) -> (0.5, 2.0):
 *   rawWeight = 0.5 + (newAlpha / (newAlpha + newBeta)) * 1.5
 */
export function updateBeta(
  alpha: number,
  betaParam: number,
  positiveSignals: number,
  negativeSignals: number
): BetaUpdateResult {
  const newAlpha = alpha + positiveSignals;
  const newBeta = betaParam + negativeSignals;
  const posteriorMean = newAlpha / (newAlpha + newBeta);
  const rawWeight = 0.5 + posteriorMean * 1.5;
  return { newAlpha, newBeta, rawWeight };
}

/**
 * Clamp a raw (unconstrained) weight proposal to safe bounds.
 *
 * Two constraints applied in order:
 *   1. Per-step: new weight must be within +/-15% of current weight
 *   2. Absolute: result must be within [0.5, 2.0]
 */
export function clampWeight(rawWeight: number, currentWeight: number): number {
  const stepMin = currentWeight * (1 - STEP_LIMIT);
  const stepMax = currentWeight * (1 + STEP_LIMIT);

  // Apply per-step clamp first
  let clamped = Math.min(Math.max(rawWeight, stepMin), stepMax);

  // Then apply absolute bounds
  clamped = Math.min(Math.max(clamped, WEIGHT_MIN), WEIGHT_MAX);

  return clamped;
}

/**
 * Check whether the aggregate drift across all proposals exceeds the threshold.
 *
 * Drift = mean of |proposedWeight - 1.0| across all proposals, expressed as %.
 * Exceeded when drift > DRIFT_THRESHOLD (10%).
 */
export function checkDrift(
  proposals: Array<{ proposedWeight: number }>
): DriftCheckResult {
  if (proposals.length === 0) {
    return { exceeded: false, pct: 0 };
  }

  const meanDrift =
    proposals.reduce((sum, p) => sum + Math.abs(p.proposedWeight - 1.0), 0) /
    proposals.length;

  const pct = meanDrift * 100;
  return { exceeded: pct > DRIFT_THRESHOLD * 100, pct };
}

/**
 * Build a plain-language explanation for a weight change.
 *
 * Pattern: "Based on {N} signals for {DOMAIN} papers ({X} positive, {Y} negative),
 * propose {increase|decrease} weight by {Z}% -- from {current} to {proposed}.
 * Posterior: Beta({pos+2}, {neg+2})."
 */
export function buildExplanation(
  domain: string,
  currentWeight: number,
  proposedWeight: number,
  signalCount: number,
  pos: number,
  neg: number
): string {
  const direction = proposedWeight >= currentWeight ? "increase" : "decrease";
  const changePct = Math.abs(
    ((proposedWeight - currentWeight) / currentWeight) * 100
  ).toFixed(1);
  const posteriorAlpha = pos + 2;
  const posteriorBeta = neg + 2;

  // Format weights to avoid bare integers (1 -> 1.0) for readability
  const fmtCurrent =
    currentWeight % 1 === 0 ? currentWeight.toFixed(1) : String(currentWeight);
  const fmtProposed =
    proposedWeight % 1 === 0
      ? proposedWeight.toFixed(1)
      : String(proposedWeight);

  return (
    `Based on ${signalCount} signals for ${domain} papers ` +
    `(${pos} positive, ${neg} negative), ` +
    `propose ${direction} weight by ${changePct}% -- ` +
    `from ${fmtCurrent} to ${fmtProposed}. ` +
    `Posterior: Beta(${posteriorAlpha}, ${posteriorBeta}).`
  );
}

// ---------------------------------------------------------------------------
// Signal mapping
// ---------------------------------------------------------------------------

/** Map a feedback type to positive/negative signal counts */
function signalFromType(type: string): { pos: number; neg: number } {
  switch (type) {
    case "like":
    case "save":
      return { pos: 1, neg: 0 };
    case "dislike":
    case "dismiss":
      return { pos: 0, neg: 1 };
    default:
      return { pos: 0, neg: 0 };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the Bayesian learning agent.
 *
 * Steps:
 *  1. Fetch all unprocessed feedback (processed_at IS NULL) with joined works
 *  2. Group by (user_id, domain) — domain from works.methodology_design
 *  3. Skip pairs with < MIN_SIGNALS signals
 *  4. For each qualifying pair: upsert domain_weights, compute update, build proposal
 *  5. Run drift check on all proposals
 *  6. If drift exceeded: insert weight_alert, return early (no proposals written)
 *  7. If drift OK: insert weight_proposals with status='pending'
 *  8. Mark all processed feedback with processed_at = now()
 *  9. Return summary { usersProcessed, proposalsCreated, alertFired, processedSignals }
 */
export async function runLearningAgent(
  db: SupabaseClient
): Promise<LearningAgentResult> {
  // Step 1: Fetch unprocessed feedback with works join for methodology domain
  const { data: feedbackRows, error: fetchError } = await db
    .from("feedback")
    .select(
      "id, user_id, work_id, brief_id, type, processed_at, works(methodology_design)"
    )
    .is("processed_at", null);

  if (fetchError) {
    throw new Error(
      `[learningAgent] Failed to fetch feedback: ${fetchError.message}`
    );
  }

  if (!feedbackRows || feedbackRows.length === 0) {
    return {
      usersProcessed: 0,
      proposalsCreated: 0,
      alertFired: false,
      processedSignals: 0,
    };
  }

  // Step 2: Group feedback by (user_id, domain)
  // Only work-level feedback with a valid methodology_design is used here.
  // Brief-level feedback (work_id null) would require parsing brief sections —
  // that fan-out is handled separately; for now we skip rows without a domain.
  const groups = new Map<string, FeedbackGroup>();

  for (const row of feedbackRows as unknown as FeedbackRow[]) {
    const domain = row.works?.methodology_design;
    if (!domain) continue; // skip if no methodology resolved

    const key = `${row.user_id}::${domain}`;
    if (!groups.has(key)) {
      groups.set(key, {
        userId: row.user_id,
        domain,
        signals: [],
        ids: [],
      });
    }
    const group = groups.get(key)!;
    group.signals.push(row.type);
    group.ids.push(row.id);
  }

  // Step 3-4: Process qualifying pairs
  const proposals: Proposal[] = [];
  const processedIds: string[] = [];
  const usersSet = new Set<string>();

  for (const [, group] of groups) {
    if (group.signals.length < MIN_SIGNALS) continue;

    const { userId, domain, signals, ids } = group;
    usersSet.add(userId);
    processedIds.push(...ids);

    // Count positive and negative signals
    let posCount = 0;
    let negCount = 0;
    for (const type of signals) {
      const { pos, neg } = signalFromType(type);
      posCount += pos;
      negCount += neg;
    }

    // Upsert domain_weights to ensure row exists (initialize if missing)
    const { data: existingRow } = await db
      .from("domain_weights")
      .select("alpha, beta_param, weight, signal_count")
      .eq("user_id", userId)
      .eq("domain", domain)
      .single();

    const currentAlpha = existingRow?.alpha ?? 2;
    const currentBeta = existingRow?.beta_param ?? 2;
    const currentWeight = existingRow?.weight ?? 1.0;
    const currentSignalCount = existingRow?.signal_count ?? 0;

    await db.from("domain_weights").upsert({
      user_id: userId,
      domain,
      alpha: currentAlpha,
      beta_param: currentBeta,
      weight: currentWeight,
      signal_count: currentSignalCount + signals.length,
    });

    // Compute Beta update
    const { newAlpha, newBeta, rawWeight } = updateBeta(
      currentAlpha,
      currentBeta,
      posCount,
      negCount
    );

    // Clamp weight
    const proposedWeight = clampWeight(rawWeight, currentWeight);

    // Build explanation
    const explanation = buildExplanation(
      domain,
      currentWeight,
      proposedWeight,
      signals.length,
      posCount,
      negCount
    );

    proposals.push({
      userId,
      domain,
      currentWeight,
      proposedWeight,
      newAlpha,
      newBeta,
      explanation,
      signalCount: signals.length,
    });
  }

  // Step 5: Drift check
  const driftProposals = proposals.map((p) => ({
    proposedWeight: p.proposedWeight,
  }));
  const { exceeded, pct } = checkDrift(driftProposals);

  // Step 6: Drift alert — abort proposals
  if (exceeded) {
    await db.from("weight_alerts").insert({
      drift_pct: pct,
      proposal_count: proposals.length,
      triggered_at: new Date().toISOString(),
    });

    // Still mark feedback as processed so we don't reprocess endlessly
    if (processedIds.length > 0) {
      await db
        .from("feedback")
        .update({ processed_at: new Date().toISOString() })
        .in("id", processedIds);
    }

    return {
      usersProcessed: usersSet.size,
      proposalsCreated: 0,
      alertFired: true,
      processedSignals: processedIds.length,
    };
  }

  // Step 7: Insert proposals
  if (proposals.length > 0) {
    const proposalRows = proposals.map((p) => ({
      user_id: p.userId,
      domain: p.domain,
      current_weight: p.currentWeight,
      proposed_weight: p.proposedWeight,
      new_alpha: p.newAlpha,
      new_beta: p.newBeta,
      explanation: p.explanation,
      signal_count: p.signalCount,
      drift_pct: pct,
      status: "pending",
    }));
    await db.from("weight_proposals").insert(proposalRows);
  }

  // Step 8: Mark feedback as processed
  if (processedIds.length > 0) {
    await db
      .from("feedback")
      .update({ processed_at: new Date().toISOString() })
      .in("id", processedIds);
  }

  // Step 9: Return summary
  return {
    usersProcessed: usersSet.size,
    proposalsCreated: proposals.length,
    alertFired: false,
    processedSignals: processedIds.length,
  };
}
