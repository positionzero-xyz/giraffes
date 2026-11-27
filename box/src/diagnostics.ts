type BoxDiagnostic =
  | { readonly code: "parse_failed" | "agent_failed" | "signin_exit"; readonly exit: number | null }
  | { readonly code: "parse_complete" | "agent_complete"; readonly durationMs: number; readonly costUsd: number | null }
  | { readonly code: "parse_abandoned"; readonly durationMs: number }
  | { readonly code: "signin_complete"; readonly signedIn: boolean }
  | { readonly code: "route_failed" | "session_missing" | "signin_started" }
  | { readonly code: "legacy_session_write_failed" | "legacy_session_read_failed" | "session_cleanup_failed"; readonly error: string };

export function diagnostic(event: BoxDiagnostic): void {
  console.info(event);
}
