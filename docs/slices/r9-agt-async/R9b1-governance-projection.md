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

## (2) ⚠️ BEST-EFFORT credential-blind(本刀核心;**非絕對保證**,務必誠實標示)
- **結構性絕無**:env、stdin、file contents(projector 只吃 `{argv}`,這些根本不是 input → 不可能洩)。
- argvRedacted **每個 token** 過 redactSecrets(**只擋已知 secret 形狀** sk-/ghp_/AKIA/xox/JWT/PEM;by-KEY scrub 不適用於 standalone token);**bounded**(MAX_TOKENS,超出 truncated=true,不靜默吞)。
- networkHosts **剝 userinfo**(`user:secret@host` → `host`)+ redactSecrets。
- **⚠️ 限制(誠實)**:**非標準形狀的 credential**(如 `--password=hunter2`、`--api-key ZZZ_custom_999`)**不會被 shape-redaction 擋,可能殘留於 argvRedacted**。故此 projection **只能交給 operator 自己的本機 AGT advisory 引擎**(可信治理 peer,如 PDP / SpendGuard DecisionLedger),**絕不可進 log / WORM / audit payload / artifact / trace / fixture**。這是 best-effort(shape-redact + userinfo-strip + bound + no-env/stdin/contents),**非「任何形式 credential 都不會穿過」的保證**。
- 純函式、無 I/O、無 throw on 正常 input(防禦性:空/超長 argv fail-safe)。
- (MINOR follow-up)`extractHost` 對 `@` 出現在 path 的 URL(`https://u:s@host/p@x`)會回傳 path 片段當 host(cosmetic;secret 仍被剝,無洩漏)——advisory hint 的小瑕,留 R9b-2/後續修。

## (3) Test-first plan（RED 先行)
- 一般 argv(`["npm","test"]`)→ argv0="npm"、argc=2、argvRedacted=["npm","test"]、operationClass 合理、truncated=false。
- **credential canary**:`["curl","https://user:sk-AAAAAAAAAAAAAAAAAAAA@api.example.com","-H","Authorization: sk-BBBBBBBBBBBBBBBBBBBB"]` → argvRedacted 內 **canary 全 redacted**;networkHosts=["api.example.com"](**無 user:secret@**)。mutation:移除 token redact → canary 現身 argvRedacted → 翻紅;移除 userinfo strip → secret 現身 networkHosts → 翻紅。
- **bounded**:argv 長度 > MAX_TOKENS → argvRedacted 長度 == MAX_TOKENS 且 truncated=true、argc=原始長度。mutation:移除 bound → 翻紅(長度超標)。
- usesShellInterpreter:`["bash","-c","..."]`→true;`["ls","-c"]`(ls 非 shell)→false。
- destructiveFlags:`["rm","-rf","/"]`→含 "-rf"。
- canary 全 **runtime-built**(secret-scan clean)。

## (4) Definition of Done（實測)
- [x] **DONE（merged)**:`GovernanceProjection` 型別 + 純 `buildExecRunProjection`(argv0/argc/argvRedacted〔每 token redactSecrets + bound 64 + truncated〕/usesShellInterpreter/networkHosts〔userinfo strip + redact〕/destructiveFlags/operationClass)。RED → verify **exit 0**(1199 passed + 26 skipped;14 測;**credential canary 全 redacted、networkHosts 無 userinfo、bounded**;remove-token-redact/remove-userinfo-strip/remove-bound 三 mutation 各翻紅;env/stdin/contents 結構性非 input;純函式無 I/O、inert〔僅自身 test import〕;depcruise no-vendor-in-core 綠+bite;secret-scan clean;typecheck clean)。獨立 Opus4.8 review:已知形狀 secret 全位置擋下、userinfo-strip 無 bypass、結構性無 env/stdin/contents、3 mutation 翻紅、pure+inert。**1 MAJOR(honesty/overclaim)已採納修正**:文件曾宣稱「NO credential 出現在任何欄位」,但非標準形狀 credential 會殘留 argvRedacted;已改為 **best-effort（shape-redact + userinfo-strip + bound + no-env/stdin/contents)+ 明示限制 + 僅供本機 AGT 引擎、非 log/WORM sink**(module header + 本 §2)。security 機制本身正確,僅文件措辭。

## (5) Rollback / Depends-on / 誠實前提
- Rollback:`git revert`(純新檔加法)。
- Depends-on:`redactSecrets`(audit barrel)、SETUP1b userinfo-strip 樣式。Blocks:R9b-2(AGT secondary 消費此 projection)。
- **誠實前提**:R9b-1 是**純 projection,目前無人消費**(inert until R9b-2 wires AGT secondary + 接進 PolicyRequest/closure)。隔離理由:credential-blind projection 是 R9 最敏感的新件,獨立嚴審勝過混在 transport 裡。
