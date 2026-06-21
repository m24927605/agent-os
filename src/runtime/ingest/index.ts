/**
 * Public surface for the concrete RPC AppendTransport adapter (slice P2R-R2-S6). The ONLY place the
 * runtime RPC vendor (@grpc/grpc-js) is wired; core consumes only the injected `AppendTransport` port.
 */
export { createRpcAppendTransport, type RpcAppendTransportOpts } from "./transport.js";
export { grpcAppendService } from "./grpc-client.js";
