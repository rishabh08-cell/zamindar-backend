// src/services/defenceService.js
// Core defence scoring + attack/patrol logic for territory zones

const EROSION_FACTOR = 0.30;
const TRANSFER_THRESHOLD = 0.10;
const DEFAULT_HALF_LIFE_DAYS = 7.0;
const MIN_ZONE_AREA_M2 = 100;

/**
 * Compute current defence score. Never stored in DB - always computed on read.
 * Formula: base_defence * 0.5^(elapsed_days / half_life_days)
 */
function computeDefenceScore(baseDefence, lastPatrolledAt, halfLifeDays = DEFAULT_HALF_LIFE_DAYS) {
  const elapsedMs = Date.now() - new Date(lastPatrolledAt).getTime();
  const elapsedDays = elapsedMs / (1000 * 60 * 60 * 24);
  const score = baseDefence * Math.pow(0.5, elapsedDays / halfLifeDays);
  return Math.max(0, Math.min(1, score));
}

/**
 * Apply attack erosion with optional loop count.
 *
 * Each loop multiplies defence by (1 - erosionFactor), compounded:
 *   newDefence = currentDefence * (1 - erosionFactor)^loopCount
 *
 * Examples with erosionFactor=0.30:
 *   1 loop:  1.00 * 0.70^1 = 0.70
 *   2 loops: 1.00 * 0.70^2 = 0.49
 *   3 loops: 1.00 * 0.70^3 = 0.34
 *   4 loops: 1.00 * 0.70^4 = 0.24
 *
 * @param {number} currentDefence  - live computed defence (0..1)
 * @param {number} erosionFactor   - per-loop erosion fraction (default 0.30)
 * @param {number} loopCount       - how many loops the attacker ran (default 1)
 * @returns {{ newBaseDefence: number, triggersTransfer: boolean, effectiveErosion: number }}
 */
function applyErosion(currentDefence, erosionFactor = EROSION_FACTOR, loopCount = 1) {
  const clampedLoops = Math.max(1, Math.round(loopCount));
  const retentionFactor = Math.pow(1 - erosionFactor, clampedLoops);
  const newDefence = currentDefence * retentionFactor;
  const effectiveErosion = 1 - retentionFactor; // total fraction removed this attack
  return {
    newBaseDefence: Math.max(0, newDefence),
    triggersTransfer: newDefence < TRANSFER_THRESHOLD,
    effectiveErosion,
  };
}

/**
 * Apply a patrol - resets base_defence to 1.0 for covered zones.
 */
function applyPatrol() {
  return {
    newBaseDefence: 1.0,
    newLastPatrolledAt: new Date().toISOString(),
  };
}

/**
 * Estimate loop count from run distance and polygon perimeter.
 * Simple heuristic: loops = round(run_distance_m / perimeter_m)
 * Minimum 1, maximum capped at 10 to avoid abuse.
 *
 * @param {number} runDistanceM   - total GPS track distance in metres
 * @param {number} perimeterM     - perimeter of the enclosed polygon in metres
 * @returns {number} estimated loop count
 */
function estimateLoopCount(runDistanceM, perimeterM) {
  if (!perimeterM || perimeterM <= 0) return 1;
  const estimate = Math.round(runDistanceM / perimeterM);
  return Math.min(Math.max(1, estimate), 10);
}

module.exports = {
  computeDefenceScore,
  applyErosion,
  applyPatrol,
  estimateLoopCount,
  EROSION_FACTOR,
  TRANSFER_THRESHOLD,
  DEFAULT_HALF_LIFE_DAYS,
  MIN_ZONE_AREA_M2,
};
