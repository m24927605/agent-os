/**
 * RED-first tests for SLICE-P2R-R1-S1 — connect-node OpenShell client + pinned proto/image-digest.
 *
 * These tests assert the connection-contract behaviours and security invariants of §5 of the slice
 * spec (docs/slices/phase-2-remaining/P2R-R1-S1-connect-node-client-pinned-proto.md) BEFORE any
 * implementation exists. They must be SEEN to fail first (import of ./client.js fails to resolve).
 *
 * No live OpenShell server is available in this environment (design §7.4): every test drives the
 * client through an INJECTED transport double. The fail-closed invariant — a thrown / timed-out /
 * non-HEALTHY Health response resolves `{ ok: false }` and NEVER throws across the boundary, and
 * NEVER leaks the baseUrl — is the load-bearing security probe.
 */
import { describe, expect, it, vi } from "vitest";
import {
  type OpenShellTransport,
  PINNED_SANDBOX_IMAGE,
  assertPinnedImageDigest,
  createOpenShellClient,
} from "./client.js";

/** A transport double whose `health()` resolves a caller-supplied result. */
function transportResolving(ok: boolean): OpenShellTransport {
  return { health: () => Promise.resolve({ ok }) };
}

describe("createOpenShellClient", () => {
  it("returns an object exposing a health() method", () => {
    const client = createOpenShellClient({
      baseUrl: "https://gateway.invalid:443",
      deadlineMs: 1_000,
      transport: transportResolving(true),
    });
    expect(typeof client.health).toBe("function");
  });

  it("resolves { ok: true } when the injected transport reports HEALTHY", async () => {
    const client = createOpenShellClient({
      baseUrl: "https://gateway.invalid:443",
      deadlineMs: 1_000,
      transport: transportResolving(true),
    });
    await expect(client.health()).resolves.toEqual({ ok: true });
  });

  it("resolves { ok: false } (fail-closed, does NOT throw) when the transport throws", async () => {
    const throwing: OpenShellTransport = {
      health: () => Promise.reject(new Error("connection refused")),
    };
    const client = createOpenShellClient({
      baseUrl: "https://gateway.invalid:443",
      deadlineMs: 1_000,
      transport: throwing,
    });
    await expect(client.health()).resolves.toEqual({ ok: false });
  });

  it("resolves { ok: false } (fail-closed) when the transport never settles within the deadline", async () => {
    const hanging: OpenShellTransport = {
      health: () => new Promise<{ ok: boolean }>(() => {}),
    };
    const client = createOpenShellClient({
      baseUrl: "https://gateway.invalid:443",
      deadlineMs: 10,
      transport: hanging,
    });
    await expect(client.health()).resolves.toEqual({ ok: false });
  });

  it("does NOT leak baseUrl to console on a transport failure", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretishBaseUrl = "https://super-secret-gateway.internal:8443";
    const throwing: OpenShellTransport = {
      health: () => Promise.reject(new Error("boom")),
    };
    const client = createOpenShellClient({
      baseUrl: secretishBaseUrl,
      deadlineMs: 1_000,
      transport: throwing,
    });
    await client.health();
    for (const spy of [errSpy, logSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secretishBaseUrl);
      }
    }
    errSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});

describe("assertPinnedImageDigest", () => {
  it("throws on a floating tag (deny-by-default — only sha256 digests are pinned)", () => {
    expect(() => assertPinnedImageDigest("alpine:latest")).toThrow();
    expect(() => assertPinnedImageDigest("registry.io/img:1.2.3")).toThrow();
    expect(() => assertPinnedImageDigest("")).toThrow();
    expect(() => assertPinnedImageDigest("sha256:")).toThrow();
    expect(() => assertPinnedImageDigest("sha256:xyz")).toThrow();
  });

  it("does NOT throw on a well-formed sha256 digest", () => {
    expect(() =>
      assertPinnedImageDigest(
        "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ),
    ).not.toThrow();
  });

  it("does NOT throw on a full OCI ref pinned by @sha256 digest (the gateway-pullable form)", () => {
    // The gateway needs the full registry reference to pull; a digest-pinned ref is still immutable.
    expect(() =>
      assertPinnedImageDigest(
        "ghcr.io/nvidia/openshell-community/sandboxes/openclaw@sha256:c116946b3f9e84791630f21f115ac35c9c9f669af70ec0eef3035d79833a9550",
      ),
    ).not.toThrow();
  });

  it("STILL throws on a digest-shaped tail that is not pinned (mutable ref, no @sha256)", () => {
    // A floating tag on a real registry path must remain rejected even though it has a colon.
    expect(() => assertPinnedImageDigest("ghcr.io/org/img:latest")).toThrow();
    expect(() => assertPinnedImageDigest("ghcr.io/org/img@sha256:tooshort")).toThrow();
  });
});

describe("PINNED_SANDBOX_IMAGE", () => {
  it("is a sha256-prefixed digest (deny-by-default: a non-digest pin is not accepted)", () => {
    expect(PINNED_SANDBOX_IMAGE).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => assertPinnedImageDigest(PINNED_SANDBOX_IMAGE)).not.toThrow();
  });
});
