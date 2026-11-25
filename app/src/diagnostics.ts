export type DrainPhase = "drain_turns_failed" | "drain_box_failed" | "drain_delivery_failed"
  | "drain_log_flush_failed" | "drain_compaction_failed" | "drain_prune_failed" | "drain_forget_failed";

type Diagnostic = DrainPhase
  | "admission_failed"
  | "billing_command_failed"
  | "box_claim_failed"
  | "box_ensure_failed"
  | "box_erase_pending"
  | "box_reclaim_failed"
  | "box_unavailable"
  | "delivery_exhausted"
  | "delivery_failed"
  | "included_provider_refused"
  | "invite_failed"
  | "ledger_flush_failed"
  | "line_quota"
  | "line_quota_unavailable"
  | "operator_alert_failed"
  | "request_failed"
  | "stripe_checkout_expiry_failed"
  | "stripe_checkout_failed"
  | "stripe_duplicate_subscription"
  | "stripe_event_ignored"
  | "stripe_event_rejected"
  | "stripe_portal_failed"
  | "stripe_standing_unavailable"
  | "telegram_callback_failed"
  | "turn_compaction_failed";

export function diagnostic(code: Diagnostic, value?: number): void {
  console.warn(value === undefined ? { code } : { code, value });
}
