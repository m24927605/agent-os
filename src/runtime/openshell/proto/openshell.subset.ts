/**
 * Typed TS face of the PINNED OpenShell proto subset (openshell.subset.proto).
 *
 * SINGLE responsibility: the type source for the `Health` RPC contract — no logic. Mirrors the
 * vendored `openshell.v1` subset 1:1 (HealthRequest / HealthResponse / ServiceStatus). The `.proto`
 * file is the source of truth; `pnpm run openshell:proto:check` guards it against drift. Numeric enum
 * values match the upstream proto exactly so wire decoding stays faithful.
 *
 * pinned rev: f23c2c8e84193beac5c35af8cd80276b60b8dbd4 (NVIDIA OpenShell proto/openshell.proto)
 */

export const PROTO_PACKAGE = "openshell.v1";

/** Fully-qualified Health method id used on the wire (`/<package>.<service>/<method>`). */
export const HEALTH_METHOD = "/openshell.v1.OpenShell/Health";

/** ServiceStatus enum — values are the upstream proto numbers (openshell.proto:1485-1490). */
export enum ServiceStatus {
  /** proto3 zero value — treated as NOT healthy (fail-closed / deny-by-default). */
  SERVICE_STATUS_UNSPECIFIED = 0,
  SERVICE_STATUS_HEALTHY = 1,
  SERVICE_STATUS_DEGRADED = 2,
  SERVICE_STATUS_UNHEALTHY = 3,
}

/** Health check request — empty message (openshell.proto:277). */
export type HealthRequest = Record<string, never>;

/** Health check response (openshell.proto:280-284). */
export interface HealthResponse {
  status: ServiceStatus;
  version: string;
}
