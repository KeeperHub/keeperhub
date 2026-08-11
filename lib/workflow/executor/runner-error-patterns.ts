/**
 * SDK error shape regexes shared between executor.workflow.ts and
 * spurious-recovery.ts.
 *
 * Kept in a standalone module to avoid circular dependencies: spurious-recovery
 * needs these patterns but must not import executor.workflow (which pulls the
 * entire plugin registry and step-registry chain).
 *
 * Exported from executor.workflow.ts as well (re-export) so the existing unit
 * test that imports them from there continues to work without change.
 */

/**
 * KEEP-398: SDK error shapes that indicate a spurious step-completion failure.
 *
 * The Workflow DevKit produces three distinct messages for the same underlying
 * lost-completion-event situation, depending on which code path the framework
 * takes when it re-fires the step on resume:
 *   1. "Step ... exceeded max retries (N retries)" -- pre-check path
 *   2. "Step ... failed after N retries: ..."      -- catch path
 *   3. "Step did not record completion ..."        -- direct timeout path
 */
export const EXCEEDED_MAX_RETRIES_REGEX = /exceeded max retries/i;
export const FAILED_AFTER_RETRIES_REGEX = /failed after.*retries/i;
export const NO_STEP_COMPLETION_REGEX = /Step did not record completion/i;
