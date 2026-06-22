/**
 * Concrete RPC AppendTransport adapter (slice P2R-R2-S6).
 *
 * This is the SINGLE chokepoint where the runtime RPC client (@grpc/grpc-js) is named — it lives under
 * src/runtime/ (NOT core), so the `no-vendor-in-core` boundary (.dependency-cruiser.cjs) is intact and
 * the core IngestClient (src/audit/ingest, S2) keeps seeing only the injected `AppendTransport` port.
 *
 * Responsibility (and ONLY this): bridge the vendor-neutral `AppendTransport` port to the S5-generated
 * typed `AppendService` contract, and map EVERY transport-layer failure — an RPC error, a refused
 * connection, or a `timeoutMs` deadline — to a REJECT (fail-closed). Mirrors the Go reference client
 * (kernel/internal/client/client.go:24-49): append-only, the success path is a present `receipt`, and
 * anything else fails closed. It NEVER resolves a falsy receipt — the commitgate treats a resolved
 * value as a durable commit (docs/design/ingest-client-sync-commit.md §6), so a non-success MUST reject.
 *
 * The adapter does NOT parse success/failure semantics: it returns the oneof verbatim as an
 * `AppendResponseShape` and leaves the single fail-closed decision to S1 `parseAppendResponse`. The
 * concrete `AppendService` client is INJECTED (mirroring Go's `New(conn ClientConnInterface)` seam), so
 * these run against an in-process stub with zero network; composition-root wiring is S7.
 */
import type {
  AppendRequestShape,
  AppendResponseShape,
  AppendTransport,
} from "../../audit/index.js";
import {
  AppendError_Code,
  type AppendRequest,
  type AppendService,
  type AppendResponse as RpcAppendResponse,
} from "../_generated/ingest/ingest.js";
import { grpcAppendService } from "./grpc-client.js";

/** Default deadline for a single Append round-trip; a slow/hung kernel fails closed, never hangs forever. */
const DEFAULT_TIMEOUT_MS = 5_000;

export interface RpcAppendTransportOpts {
  /** Kernel AppendService endpoint (host:port). Used to build the real grpc-js client when `client` is absent. */
  readonly endpoint: string;
  /** Per-call deadline; on expiry the append REJECTS (fail-closed). Defaults to {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * Injected typed `AppendService` (the S5 contract). Production omits it and a grpc-js client is built
   * from `endpoint`; tests inject an in-process stub (no external process). Mirrors Go's injected conn.
   */
  readonly client?: AppendService;
}

/**
 * Build an `AppendTransport` backed by a concrete RPC client. Resolves an `AppendResponseShape` on a
 * served response; REJECTS on any transport error or on the `timeoutMs` deadline (fail-closed).
 */
export function createRpcAppendTransport(opts: RpcAppendTransportOpts): AppendTransport {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Build the real grpc-js-backed client lazily ONLY when none is injected (keeps tests network-free).
  const client = opts.client ?? grpcAppendService(opts.endpoint);

  return {
    append(req: AppendRequestShape): Promise<AppendResponseShape> {
      const rpcReq: AppendRequest = {
        sourceId: req.sourceId,
        sequence: req.sequence,
        canonicalEvent: req.canonicalEvent,
        // ES2a: proto AppendRequest gained `partition_id` (field 4). The TS consumer does NOT route by
        // partition yet (that is ES2b); send the proto3 default empty string so single-chain servers
        // ignore it (back-compat) and the partitioned server fail-closed denies it. NOT consumed here.
        partitionId: "",
      };

      // Race the call against the deadline. A synchronous throw, an async reject, OR a never-settling
      // call ALL surface as a reject — there is no path that resolves a non-served value.
      const call = new Promise<RpcAppendResponse>((resolve, reject) => {
        try {
          client.Append(rpcReq).then(resolve, reject);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`append: RPC timeout after ${timeoutMs}ms (fail-closed)`)),
          timeoutMs,
        );
      });

      return Promise.race([call, deadline]).then(
        (resp) => {
          if (timer !== undefined) clearTimeout(timer);
          return toResponseShape(resp);
        },
        (err) => {
          if (timer !== undefined) clearTimeout(timer);
          throw err instanceof Error ? err : new Error(String(err));
        },
      );
    },
  };
}

/**
 * Map the generated `AppendResponse` oneof to the vendor-neutral `AppendResponseShape` VERBATIM. We do
 * NOT decide success here: a `receipt` becomes `{receipt}`, an `error` becomes `{error}` (enum -> stable
 * name string, matching the kernel's `Code.String()` and S1's `CODE_UNSPECIFIED` deny), and an
 * empty/absent oneof becomes `{}` — S1 `parseAppendResponse` is the single fail-closed decision point.
 */
function toResponseShape(resp: RpcAppendResponse): AppendResponseShape {
  const result = resp.result;
  if (result === undefined) {
    return {};
  }
  if (result.$case === "receipt") {
    const r = result.receipt;
    return {
      receipt: {
        sequence: r.sequence,
        contentHash: r.contentHash,
        prevHash: r.prevHash,
        entryHash: r.entryHash,
      },
    };
  }
  return {
    error: {
      code: AppendError_Code[result.error.code] ?? "CODE_UNSPECIFIED",
      detail: result.error.detail,
    },
  };
}
