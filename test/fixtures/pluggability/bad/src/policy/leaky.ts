// FIXTURE (not compiled). A CORE module (src/policy/...) that ILLEGALLY imports a vendor adapter.
// The no-vendor-in-core dependency-cruiser rule MUST flag this edge. Do NOT import from real code.
import { vendorClient } from "../runtime/openshell/client.js";

export const leaked = vendorClient;
