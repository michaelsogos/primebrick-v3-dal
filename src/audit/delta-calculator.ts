/**
 * Delta calculator — computes field-level old/new diffs for audit trail.
 *
 * Used by Repository write ops (add, update, delete, restore, hardDelete) to
 * produce the `delta` object passed to `AuditPort.writeAudit()`.
 */

/** Convert bigint to number for JSON serialization (safe for audit deltas) */
function bigintToNumber(val: unknown): unknown {
  if (typeof val === "bigint") {
    const num = Number(val);
    // Return as string if it would lose precision
    if (Math.abs(num) > Number.MAX_SAFE_INTEGER) return val;
    return num;
  }
  return val;
}

/** Calculate delta between old and new records for audit. */
export function calculateDelta(
  oldEntity: Record<string, unknown>,
  newEntity: Record<string, unknown>,
): Record<string, { old: unknown; new: unknown }> {
  const delta: Record<string, { old: unknown; new: unknown }> = {};
  for (const key in newEntity) {
    const oldVal = bigintToNumber(oldEntity[key]);
    const newVal = bigintToNumber(newEntity[key]);
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      delta[key] = { old: oldVal, new: newVal };
    }
  }
  return delta;
}

/** Calculate delta and force include specific fields even when unchanged. */
export function calculateDeltaWithForcedFields(
  oldEntity: Record<string, unknown>,
  newEntity: Record<string, unknown>,
  forceFields: string[],
): Record<string, { old: unknown; new: unknown }> {
  const delta = calculateDelta(oldEntity, newEntity);
  for (const key of forceFields) {
    if (!(key in delta) && key in newEntity) {
      delta[key] = { old: bigintToNumber(oldEntity[key] ?? null), new: bigintToNumber(newEntity[key]) };
    }
  }
  return delta;
}
