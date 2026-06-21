import { describe, expect, it } from "vitest";
import { type AgentContext, parseAgentContext } from "../../iam/ids.js";
import { receiveText } from "../intent/index.js";
import { InactiveSpeechToText, type SpeechToTextPort, voiceToIntent } from "./index.js";

// A valid zero-skill caller identity. Voice is merely an input adapter in front of the
// IntentGateway; the AgentContext is supplied by the host, exactly as on the text path.
const ctx: AgentContext = parseAgentContext({
  actorId: "user-1",
  tenantId: "personal",
  projectId: "home",
  taskId: "task-1",
  requestId: "req-1",
});

// Arbitrary audio bytes — never inspected by the inactive gate (it denies before transcribe).
const AUDIO = new Uint8Array([0x52, 0x49, 0x46, 0x46]);

describe("Voice input adapter — inactive capability gate (G2)", () => {
  it("inactive fail-closed: transcribe → {ok:false, voice capability inactive}, never text", async () => {
    const out = await InactiveSpeechToText.transcribe(AUDIO);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("inactive STT must never return ok:true");
    expect(out.reason).toBe("voice capability inactive");
    // Adversarial: no `text` field can leak from the inactive default.
    expect((out as { text?: unknown }).text).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("text");
  });

  it("voiceToIntent(Inactive, …) → denied (voice not enabled must not enter the pipeline)", async () => {
    const out = await voiceToIntent(InactiveSpeechToText, AUDIO, ctx);
    expect(out.status).toBe("denied");
    if (out.status !== "denied") throw new Error("expected denied");
    expect(out.reason).toBe("voice capability inactive");
  });

  it("reuses the text path: a fake STT's transcript yields the SAME outcome as receiveText", async () => {
    const transcript = "backup my photos folder";
    // Fake STT assembled at runtime (DI seam) — returns a fixed transcript.
    const fakeStt: SpeechToTextPort = {
      transcribe: async () => ({ ok: true, text: transcript }),
    };
    const viaVoice = await voiceToIntent(fakeStt, AUDIO, ctx);
    const viaText = receiveText(transcript, ctx);
    // Voice is only an input adapter: transcribe→text→receiveText, pipeline unchanged.
    expect(viaVoice).toEqual(viaText);
    expect(viaVoice.status).toBe("intent");
  });

  it("fake STT transcribe failure → voiceToIntent denies (never guesses)", async () => {
    const failingStt: SpeechToTextPort = {
      transcribe: async () => ({ ok: false, reason: "no speech detected" }),
    };
    const out = await voiceToIntent(failingStt, AUDIO, ctx);
    expect(out.status).toBe("denied");
    if (out.status !== "denied") throw new Error("expected denied");
    expect(out.reason).toBe("no speech detected");
  });
});
