#!/usr/bin/env node
// SLICE-ACT3-live operator driver. Invoked by scripts/e2e-live-gmail.sh ONLY when the operator has opted in
// (AGENTOS_ACTION_LIVE=1 + AGENTOS_ACTION_TEST_ACCOUNT + AGENTOS_GMAIL_OAUTH_KEY + AGENTOS_EGRESS_ALLOW set).
//
// It drives the REAL governed pipeline for gmail.send (the runner core `runGmailSelfSend`, compiled to dist)
// over the REAL HttpActionTransport using Node's built-in global `fetch` — the LIVE egress that actually hits
// gmail.googleapis.com. It runs ONE SELF-send to the operator's throwaway test account.
//
// RUNTIME-DIRECT posture (HONEST): THIS process resolves + holds the OAuth token at egress (the transport's
// resolveCredentialHeaders reads it from env). Credential-blind-to-brain/audit/WORM/projection — only the
// transport (the egress actor) ever materializes the token. Production-strongest = sandbox SecretResolver
// (EXEC2) where the runtime never holds the token. Runtime-direct is the reasonable first live path for a
// throwaway account.
//
// ⚠️ NEVER prints the token or the resolved Authorization value — only redacted trace / placeholders / status.
// ⚠️ Before the send it prints "ABOUT TO SEND to <account>" — the operator running this script IS the human
// confirmation (self-send + minimal blast radius). Imports the COMPILED dist (the sh runs build first).

import { redactSecrets } from "../dist/audit/index.js";
import { liveGmailPreflight, runGmailSelfSend } from "../dist/runtime/brain/adapters/hermes/index.js";

// CREDENTIAL-BLIND preflight: validate the opt-in env via a FIXED-reason gate that NEVER echoes any env
// VALUE (so a token mis-pasted into AGENTOS_GMAIL_OAUTH_KEY can never leak into this script's output).
// On skip/blocked we print ONLY the fixed reason and exit fail-closed; on ok we proceed.
const preflight = liveGmailPreflight(process.env);
if (preflight.status !== "ok") {
  // preflight.reason is FIXED-string-only (no env value). skip => 0 (opt-out), blocked => 2 (fail-closed).
  if (preflight.status === "skip") {
    console.log(`act-live-gmail: ${preflight.reason}`);
    process.exit(0);
  }
  console.error(`act-live-gmail: ${preflight.reason}`);
  process.exit(2);
}

const testAccount = process.env.AGENTOS_ACTION_TEST_ACCOUNT ?? "";
const oauthKey = process.env.AGENTOS_GMAIL_OAUTH_KEY ?? "";
// The egress host allowlist (comma-separated). The fold only lets the gmail host through.
const egressAllow = (process.env.AGENTOS_EGRESS_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

console.log("act-live-gmail: governed live self-send (runtime-direct; credential-blind to brain/audit)");
console.log(`act-live-gmail: egress allowlist = ${egressAllow.join(", ")}`);
console.log(`act-live-gmail: ABOUT TO SEND to ${testAccount} (SELF-send; the operator running this = confirmation)`);

const result = await runGmailSelfSend({
  live: true,
  testAccount,
  egressAllow,
  oauthKey,
  // The transport resolves the placeholder against THIS env at egress (the only resolution point).
  env: process.env,
  // No fake resolver — use the REAL userinfo resolver over the live transport.
  // No fake fetch — use Node's built-in global fetch (LIVE egress).
  fetchImpl: (url, init) => globalThis.fetch(url, init),
});

// Print the governance trace — each stage, redacted (never a token / Authorization value).
console.log("act-live-gmail: governance trace —");
for (const step of result.trace) {
  console.log(`  [${step.stage}] ${redactSecrets(step.detail)}`);
}

// The captured egress (post credential-resolution) — print ONLY method/url + a REDACTED Authorization marker.
for (const req of result.http.requests) {
  const hasAuth = typeof req.headers.Authorization === "string";
  console.log(`act-live-gmail: egress ${req.method} ${req.url} (Authorization: ${hasAuth ? "[REDACTED]" : "none"})`);
}

if (result.outcome.status === "executed") {
  // The connector maps a 2xx to ok:true; the detail is the effect's (redacted) detail. The real Gmail message
  // id is in the live response body, which we deliberately do NOT echo (it could carry account context) —
  // the operator confirms receipt in the test mailbox.
  console.log(`act-live-gmail: OUTCOME executed — detail: ${redactSecrets(result.outcome.detail ?? "(none)")}`);
  console.log("act-live-gmail: ok — governed live self-send executed (confirm receipt in the test mailbox)");
  process.exit(0);
}

console.error(
  `act-live-gmail: NOT SENT — ${result.outcome.status}${
    result.outcome.status === "denied" ? ` @${result.outcome.stage}: ${redactSecrets(result.outcome.reason)}` : ""
  }`,
);
process.exit(1);
