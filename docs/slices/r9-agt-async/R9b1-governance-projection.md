# SLICE-R9b-1: GovernanceProjection 型別 + `exec.run` credential-blind projector

- **Phase**: R9（真 AGT 接入)— 第 2 刀之 1（credential-blind 的新 security 核心,純函式)
- **Branch**: slice/r9b1-governance-projection
- **Author**: Backend Architect    **Adversarial reviewer**: <fresh-context、非作者、獨立 Opus 4.8>
- **狀態**: **DRAFT（待核准開工)**

## (0) 動機
AGT advisory 要有用,需看「做什麼」(如 `exec.run` 的 argv),但**不能洩 args/secrets/env**(credential-blind)。R9b-1 只做這個**純函式 projection**:把 validated exec.run args 投影成一份**最小、redacted、bounded** 的 governance detail,供 AGT secondary(R9b-2)消費。**本刀無 transport、無 AGT、不接 PolicyRequest/closure**——純型別 + 純 projector + credential-blind 測,把最敏感的新件隔離嚴審。

## (1) 範圍(純 TS,新檔)
- 新 vendor-neutral 型別 `GovernanceProjection`(放 `src/policy/` 或 `src/tools/`,vendor-neutral 區;PDP 不讀,AGT adapter 才讀):
  ```
  { version: 1;
    operationClass: string;        // 粗分類,derive from argv0(如 "process"/"filesystem"/"network"/"unknown")
    argv0: string;                 // redacted
    argc: number;                  // 原始 token 數(未截斷前)
    argvRedacted: readonly string[];  // 每 token redactSecrets + bounded(MAX_TOKENS,如 64)
    truncated: boolean;            // argc > MAX_TOKENS 時 true(明示截斷,不靜默)
    usesShellInterpreter: boolean; // argv0 ∈ {sh,bash,zsh,dash,...} 且含 -c
    networkHosts: readonly string[];  // URL-like args 抽出的 host[:port],userinfo(user:pass@)剝除 + redacted
    destructiveFlags: readonly string[]; }  // best-effort 掃描已知破壞性 flag(-rf/--force/--no-preserve-root)
  ```
- 純函式 `buildExecRunProjection(validated: { argv: readonly string[] }): GovernanceProjection`:
  - argv0 = redactSecrets(argv[0]);argc = argv.length。
  - argvRedacted = argv.slice(0, MAX_TOKENS).map(redactSecrets);truncated = argv.length > MAX_TOKENS。
  - usesShellInterpreter:argv0 basename ∈ shell set 且其後含 `-c`。
  - networkHosts:掃 URL-like / `host:port` token → 剝 `user:pass@` userinfo(鏡像 SETUP1b splitEndpoint)+ redactSecrets。
  - destructiveFlags:best-effort 已知集合交集(不求全,只給 AGT hint)。
  - operationClass:from argv0 basename 粗分類,未知 → "unknown"。

## (2) ⚠️ Credential-blind 不變量(本刀核心,務必測死)
- **絕不輸出**:env、stdin、file contents、raw 未-redacted token、完整 userinfo/credential。
- argvRedacted **每個 token** 過 redactSecrets;**bounded**(MAX_TOKENS,超出 truncated=true,不靜默吞)。
- networkHosts **剝 userinfo**(`user:secret@host` → `host`)+ redactSecrets。
- 任何欄位(argv0/operationClass/...)都 redacted。
- 純函式、無 I/O、無 throw on 正常 input(防禦性:空 argv 已被 exec.run schema `.min(1)` 擋,但 projector 仍對空/超長 fail-safe)。

## (3) Test-first plan（RED 先行)
- 一般 argv(`["npm","test"]`)→ argv0="npm"、argc=2、argvRedacted=["npm","test"]、operationClass 合理、truncated=false。
- **credential canary**:`["curl","https://user:sk-AAAAAAAAAAAAAAAAAAAA@api.example.com","-H","Authorization: sk-BBBBBBBBBBBBBBBBBBBB"]` → argvRedacted 內 **canary 全 redacted**;networkHosts=["api.example.com"](**無 user:secret@**)。mutation:移除 token redact → canary 現身 argvRedacted → 翻紅;移除 userinfo strip → secret 現身 networkHosts → 翻紅。
- **bounded**:argv 長度 > MAX_TOKENS → argvRedacted 長度 == MAX_TOKENS 且 truncated=true、argc=原始長度。mutation:移除 bound → 翻紅(長度超標)。
- usesShellInterpreter:`["bash","-c","..."]`→true;`["ls","-c"]`(ls 非 shell)→false。
- destructiveFlags:`["rm","-rf","/"]`→含 "-rf"。
- canary 全 **runtime-built**(secret-scan clean)。

## (4) Definition of Done（待實測填)
- [ ] RED → verify exit 0(projector + 型別;**credential-blind 測死**〔token redact + userinfo strip + bounded〕;各 mutation 證非空;純函式無 I/O;depcruise clean〔vendor-neutral,無新跨區 import〕;secret-scan clean);獨立 Opus 4.8 review PASS(重點:**任何 secret/cred/env/stdin 都不可能穿過 projection**)。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純新檔加法)。
- Depends-on:`redactSecrets`(audit barrel)、SETUP1b userinfo-strip 樣式。Blocks:R9b-2(AGT secondary 消費此 projection)。
- **誠實前提**:R9b-1 是**純 projection,目前無人消費**(inert until R9b-2 wires AGT secondary + 接進 PolicyRequest/closure)。隔離理由:credential-blind projection 是 R9 最敏感的新件,獨立嚴審勝過混在 transport 裡。
