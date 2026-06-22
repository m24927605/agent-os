/**
 * Public surface for the concrete RPC AppendTransport adapter (slice P2R-R2-S6). The ONLY place the
 * runtime RPC vendor (@grpc/grpc-js) is wired; core consumes only the injected `AppendTransport` port.
 */
export { createRpcAppendTransport, type RpcAppendTransportOpts } from "./transport.js";
export { grpcAppendService } from "./grpc-client.js";
export { createEntriesReader, type EntriesReaderOpts } from "./read-transport.js";
// The Enterprise per-tenant LIVE WORM sink factory (SLICE-ES2b): binds an injected AppendTransport +
// TenantBinding into a sink that appends to that tenant's INDEPENDENT kernel partition chain
// (partition_id + per-tenant sourceId). Enterprise consumes it via its own barrel (which re-exports
// this), so the enterprise module never deep-imports a runtime internal.
export { createPartitionedIngestSink } from "./partitioned-sink.js";
