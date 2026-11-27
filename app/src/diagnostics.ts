export type DrainPhase = "drain_turns_failed" | "drain_box_failed" | "drain_delivery_failed" | "drain_billing_alert_failed"
  | "drain_log_flush_failed" | "drain_compaction_failed" | "drain_prune_failed" | "drain_forget_failed";

export type Diagnostic = DrainPhase
  | "admission_failed"
  | "billing_command_failed"
  | "box_claim_failed"
  | "box_ensure_failed"
  | "box_erase_pending"
  | "box_reclaim_failed"
  | "box_unavailable"
  | "delivery_exhausted"
  | "delivery_failed"
  | "erase_billing_hold"
  | "erase_box_hold"
  | "erase_box_host_mismatch"
  | "erase_box_unverified"
  | "erase_failed"
  | "included_provider_refused"
  | "invite_failed"
  | "ledger_flush_failed"
  | "line_loading_failed"
  | "line_quota"
  | "line_quota_unavailable"
  | "line_reply_quota"
  | "line_reply_usage_write_failed"
  | "operator_alert_date_lookup_failed"
  | "operator_alert_failed"
  | "operator_alert_unconfirmed"
  | "operator_alert_destination_unavailable"
  | "request_failed"
  | "routine_delivery_budget"
  | "stripe_checkout_expiry_failed"
  | "stripe_checkout_failed"
  | "stripe_duplicate_subscription"
  | "stripe_event_failed"
  | "stripe_event_ignored"
  | "stripe_event_rejected"
  | "stripe_portal_failed"
  | "stripe_refresh_failed"
  | "stripe_standing_unavailable"
  | "telegram_callback_failed"
  | "telegram_typing_failed"
  | "turn_compaction_failed";

export function diagnostic(code: Diagnostic, value?: number): void {
  console.warn(value === undefined ? { code } : { code, value });
}

export function operatorAlertChatMigrated(oldChatId: string, newChatId: string): void {
  console.warn({ code: "operator_alert_chat_migrated", oldChatId, newChatId });
}
