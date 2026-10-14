/**
 * Audit context primitive for business history operations.
 *
 * Provides a standardized, explicit compile-time type contract capturing
 * the actor, action, and event timestamp for business records without
 * runtime overhead or speculative framework dependencies.
 */
export interface AuditContext {
  /** Authenticated actor UUID executing the action. */
  actor: string;

  /** Explicit business action identifier. */
  action: string;

  /** Native JavaScript Date event timestamp. */
  recorded_at: Date;
}
