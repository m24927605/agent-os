// FIXTURE (not compiled; tsconfig includes only `src`). Stands in for a vendor adapter module
// whose path carries a vendor token ("openshell"). Used by no-vendor-in-core.test.ts to prove the
// dependency-cruiser rule fires when a CORE module imports a vendor. Do NOT import from real code.
export const vendorClient = "openshell-vendor-client";
