// FIXTURE (not compiled). A CORE module importing another core module (no vendor token in the
// path). The no-vendor-in-core rule must NOT fire here. Do NOT import from real code.
import { auditUtil } from "../audit/util.js";

export const ok = auditUtil;
