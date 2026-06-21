// FIXTURE (not compiled). A CORE module importing a vendor whose path uses the `-sdk` suffix —
// must be flagged by no-vendor-in-core after the boundary widening. Do NOT import from real code.
import { vendorSdkClient } from "../runtime/openshell-sdk/client.js";

export const leakedSuffix = vendorSdkClient;
