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
 * Apply attack erosion. Returns new base_defence and whether transfer is triggered.
 */
function applyErosion(currentDefence, erosionFactor = EROSION_FACTOR) {
  const newDefence = currentDefence * (1 - erosionFactor);
  return {
    newBaseDefence: newDefence,
    triggersTransfer: newDefence < TRANSFER_THRESHOLD,
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

module.exports = {
  computeDefenceScore,
  applyErosion,
  applyPatrol,
  EROSION_FACTOR,
  TRANSFER_THRESHOLD,
  DEFAULT_HALF_LIFE_DAYS,
  MIN_ZONE_AREA_M2,
};
