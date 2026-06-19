// Generate the TS-produced cross-language chain fixture (testdata/ts-chain.json) from the SHARED
// events.json input, using the TS reference InMemoryAppendOnlyLog (S0.5). The Go side generates an
// equivalent fixture from the SAME events.json + SAME seeded key; the conformance tests then
// cross-verify (Go verifies this, TS verifies the Go one) and assert entryHash/head/signature equality.
//
// Run AFTER `pnpm run build`. The canary is assembled at RUNTIME (events.json holds only a __CANARY__
// token), redacted before append, so no secret literal is ever committed and the fixture holds only
// redacted events + hashes + base64 signature + public key (NO private key).
import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { redactSecrets } from "../../dist/audit/redact.js";
import { InMemoryAppendOnlyLog } from "../../dist/audit/kernel/log.js";

const here = new URL(".", import.meta.url);
const canary = `sk-${"a".repeat(40)}`; // obvious non-secret sentinel, runtime-assembled
const raw = readFileSync(new URL("events.json", here), "utf8").replaceAll("__CANARY__", canary);
const events = JSON.parse(raw);

// Deterministic ed25519 key from a fixed 32-byte seed (test-only; matches the Go generator's seed).
const seed = Buffer.alloc(32, 7);
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(privateKey);

const log = new InMemoryAppendOnlyLog({ publicKey, privateKey });
for (const ev of events) {
  log.append(redactSecrets(ev)); // redact BEFORE append so the stored/fixture event holds no canary
}
const entries = log.entries().map((e) => ({
  sequence: e.sequence,
  event: e.event,
  prevHash: e.prevHash,
  entryHash: e.entryHash,
}));
const cp = log.checkpoint();

const fixture = {
  version: "agentos.cross-lang-chain.v1",
  publicKey: `ed25519:${publicKey.export({ type: "spki", format: "der" }).toString("base64")}`,
  entries,
  checkpoint: { length: cp.length, headEntryHash: cp.headEntryHash, signature: cp.signature },
};
writeFileSync(new URL("testdata/ts-chain.json", here), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote testdata/ts-chain.json (${entries.length} entries, TS-produced)`);
