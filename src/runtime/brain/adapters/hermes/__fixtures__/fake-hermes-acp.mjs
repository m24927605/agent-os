#!/usr/bin/env node
/**
 * FAKE `hermes acp` — an in-tree subprocess double for SLICE-DHB2a.
 *
 * It speaks the SAME wire `AcpStdioTransport` drives: ACP (Agent Client Protocol) = JSON-RPC 2.0,
 * newline-delimited (one JSON object per line) over stdin/stdout. It NEVER calls a real model and
 * NEVER touches credits — it replays canned responses + `session/update` notifications + a
 * `session/request_permission` request, then resolves the prompt.
 *
 * It is driven by env vars so one fixture covers every test scenario (happy, propose-only,
 * fail-closed: non-zero / malformed / EOF, credential-blind spy, and host-access deny):
 *   FAKE_ACP_SCENARIO   one of: happy | permission | hostaccess | nonzero | malformed | eof
 *                       (default: happy)
 *   FAKE_ACP_LOG        path of a JSON side-channel log the test reads afterwards (optional)
 *
 * The side-channel log records:
 *   (a) every line received on stdin (so the test can assert the ONLY data sent is the ACP protocol
 *       + the intent — credential-blind);
 *   (b) the client's response to `session/request_permission` (so the test can OBSERVE it was a DENY
 *       — propose-only), plus whether the fake "executed" the tool (only if approved — so an
 *       approve-mutation in the transport flips the propose-only assertion);
 *   (c) the fake's OWN `process.env` (so the test can assert minimalEnv did NOT leak the parent's
 *       secret-bearing env into the child — child-env credential-blind);
 *   (d) the client's responses to agent->client `fs/read_text_file` / `terminal/create` requests
 *       (so the test can OBSERVE they were DENIED with a -32601 error and no host access occurred).
 *
 * NO secret literals live in this file — secret-scan stays clean. (It records, but never invents,
 * any secret-shaped string.)
 */
import { writeFileSync } from "node:fs";

const SCENARIO = process.env.FAKE_ACP_SCENARIO ?? "happy";
const LOG_PATH = process.env.FAKE_ACP_LOG;

/**
 * SLICE-EXEC3a exec-loop proposals: a JSON array of `{tool, args}` the FAKE proposes, one per turn.
 * For `exec_loop` the array is consumed turn-by-turn (and the loop ends with end_turn once exhausted);
 * for `exec_loop_forever` the LAST entry is re-proposed on every turn (never end_turn — maxTurns test).
 * This lets a test script EXACTLY what the brain proposes (a registered exec tool name + DECLARED
 * args), with NO secret literals in this fixture (any canary is built by the test, not invented here).
 */
function parseExecProposals() {
  const raw = process.env.FAKE_ACP_EXEC_PROPOSALS;
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
const EXEC_PROPOSALS = parseExecProposals();

/** Records of what the client did, flushed to the side-channel log on exit. */
const record = {
  scenario: SCENARIO,
  stdinLines: /** @type {string[]} */ ([]),
  methodsReceived: /** @type {string[]} */ ([]),
  permissionResponse: /** @type {unknown} */ (undefined),
  permissionApproved: false,
  toolExecuted: false,
  // (c) child-env credential-blind: the env the CHILD actually received. The test asserts the
  // parent's secret-bearing vars did NOT leak in (only PATH/HOME + explicit opts.env survive).
  childEnvKeys: Object.keys(process.env),
  childEnv: { ...process.env },
  // (d) host-access deny-by-default: the client's responses to fs/terminal agent->client requests.
  fsReadResponse: /** @type {unknown} */ (undefined),
  terminalCreateResponse: /** @type {unknown} */ (undefined),
  hostAccessGranted: false,
  // (e) DHB3a closed loop: the text of each FOLLOW-UP session/prompt the client fed back (the governed
  // result), and the permission response observed on EACH turn (propose-only must hold every turn).
  promptTexts: /** @type {string[]} */ ([]),
  permissionResponsesPerTurn: /** @type {unknown[]} */ ([]),
};

function flushLog() {
  if (LOG_PATH !== undefined) {
    try {
      writeFileSync(LOG_PATH, JSON.stringify(record));
    } catch {
      // best-effort side channel; never crash the fake over logging
    }
  }
}

/** Write one newline-delimited JSON-RPC message to stdout (the wire to the client). */
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** A response to a client request `id`. */
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

/** Emit a `session/update` notification carrying ONE AcpUpdateFrame as its `update`. */
function sessionUpdate(sessionId, update) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

let nextServerRequestId = 1000;
/** Outstanding agent->client requests keyed by id, so we can correlate the client's response. */
const pendingServerRequests = new Map();

/**
 * Send an agent->client request and resolve when the client responds. (Used for
 * `session/request_permission` — propose-only: the client MUST answer.)
 */
function serverRequest(method, params) {
  const id = nextServerRequestId++;
  return new Promise((resolve) => {
    pendingServerRequests.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const SESSION_ID = "sess-fake-1";

/** Decide whether a permission response APPROVED execution (allow/approve) vs denied (cancelled/reject). */
function isApproval(response) {
  const outcome =
    response && typeof response === "object" && "outcome" in response
      ? response.outcome
      : undefined;
  const outcomeKind =
    outcome && typeof outcome === "object" && "outcome" in outcome ? outcome.outcome : undefined;
  const selectedOption =
    outcome && typeof outcome === "object" && "optionId" in outcome ? outcome.optionId : undefined;
  return outcomeKind === "selected" && (selectedOption === "allow" || selectedOption === "approve");
}

/**
 * Ask the client to permit executing a tool (propose-only test). Records the per-turn response so the
 * test can assert EVERY turn was answered with a cancellation. A correct client DENIES; if it ever
 * approves, the fake self-executes (which the test catches as a propose-only violation).
 */
async function askPermission(toolCallId, title) {
  const response = await serverRequest("session/request_permission", {
    sessionId: SESSION_ID,
    toolCall: { toolCallId, title },
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  });
  record.permissionResponsesPerTurn.push(response);
  if (isApproval(response)) {
    record.permissionApproved = true;
    record.toolExecuted = true;
    sessionUpdate(SESSION_ID, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `EXECUTED ${title} (client approved!)` },
    });
  }
}

/** Per-prompt turn index for the loop scenarios (each session/prompt = one turn). */
let loopTurn = 0;

/**
 * DHB3a `loop`: a CLOSED agentic loop over a held session. Turn 1 proposes a tool_call + asks
 * permission (denied) and does NOT resolve end_turn — it WAITS for the client's second session/prompt
 * (the governed result). On the SECOND prompt it proposes a SECOND tool_call (continue). On the THIRD
 * prompt it resolves stopReason:"end_turn" (done). `loop_forever` proposes a tool_call on EVERY prompt
 * and NEVER resolves end_turn (for the maxTurns cap test).
 */
async function runLoopTurn(forever) {
  loopTurn += 1;
  const id = loopTurn;

  // A terminal turn (only for `loop` on turn 3): no proposal, resolve end_turn -> loop ends.
  if (!forever && id >= 3) {
    sessionUpdate(SESSION_ID, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "all done" },
    });
    flushLog();
    promptResolve(); // stopReason: "end_turn"
    return;
  }

  // Otherwise propose a tool_call + ask permission (denied every turn). Do NOT resolve end_turn:
  // the prompt resolves with a stopReason ONLY so the client can read this turn's proposals, then the
  // client feeds back the governed result as the next prompt. We resolve "tool_use" (a non-terminal
  // stopReason) so the DRIVER keeps looping while there is a proposal.
  sessionUpdate(SESSION_ID, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `loop turn ${id}: I will run a tool` },
  });
  sessionUpdate(SESSION_ID, {
    sessionUpdate: "tool_call",
    toolCallId: `call-${id}`,
    title: `loop_tool_${id}`,
    rawInput: { step: id },
  });
  await askPermission(`call-${id}`, `loop_tool_${id}`);
  flushLog();
  // Resolve THIS prompt with a non-terminal stopReason so the client governs the proposal and feeds
  // the result back as the next prompt (the loop closes).
  promptResolveWith({ stopReason: "tool_use" });
}

/**
 * SLICE-EXEC3a `exec_loop` / `exec_loop_forever`: a CLOSED agentic loop whose tool_call frames carry a
 * REGISTERED exec tool NAME (the frame's `title`) + DECLARED args (the frame's `rawInput`) drawn from
 * FAKE_ACP_EXEC_PROPOSALS. The brain NEVER supplies argv — only the tool name + declared params; the
 * composer's binding builds argv. Same propose-only + feed-back-and-loop mechanics as `runLoopTurn`.
 */
async function runExecLoopTurn(forever) {
  loopTurn += 1;
  const id = loopTurn;

  // Pick this turn's proposal. exec_loop: walk the array, then end_turn once exhausted. exec_loop_forever:
  // clamp to the last entry and NEVER end_turn (the maxTurns blast-radius cap test).
  const idx = forever ? Math.min(id - 1, EXEC_PROPOSALS.length - 1) : id - 1;
  const proposal = EXEC_PROPOSALS[idx];

  if (!forever && proposal === undefined) {
    // No more scripted proposals -> a terminal turn (no proposal, end_turn) so the loop ends cleanly.
    sessionUpdate(SESSION_ID, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "exec loop done" },
    });
    flushLog();
    promptResolve(); // stopReason: "end_turn"
    return;
  }

  const tool = proposal?.tool ?? "exec.echo";
  const args = proposal?.args ?? {};
  sessionUpdate(SESSION_ID, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: `exec loop turn ${id}: I will run ${tool}` },
  });
  sessionUpdate(SESSION_ID, {
    sessionUpdate: "tool_call",
    toolCallId: `call-${id}`,
    title: tool,
    rawInput: args,
  });
  await askPermission(`call-${id}`, tool);
  flushLog();
  promptResolveWith({ stopReason: "tool_use" });
}

async function runPrompt(promptParams) {
  // The intent text the client forwarded (credential-blind: this is the only caller payload).
  // We do not need it beyond recording — it is captured in stdinLines already.

  if (SCENARIO === "malformed") {
    // Emit a NON-JSON line mid-prompt -> the client's line parser must fail-closed (throw).
    process.stdout.write("this is not json at all\n");
    // give the client a tick to react, then exit
    setTimeout(() => {
      flushLog();
      process.exit(0);
    }, 50);
    return;
  }

  if (SCENARIO === "eof") {
    // Close stdout mid-prompt WITHOUT a prompt response -> client sees EOF -> fail-closed.
    flushLog();
    process.exit(0);
    return;
  }

  if (SCENARIO === "nonzero") {
    // Exit non-zero BEFORE resolving the prompt -> fail-closed.
    flushLog();
    process.exit(3);
    return;
  }

  if (SCENARIO === "loop" || SCENARIO === "loop_forever") {
    await runLoopTurn(SCENARIO === "loop_forever");
    return;
  }

  if (SCENARIO === "exec_loop" || SCENARIO === "exec_loop_forever") {
    await runExecLoopTurn(SCENARIO === "exec_loop_forever");
    return;
  }

  // happy + permission both stream two updates first: a plan chunk, then a proposed tool_call.
  sessionUpdate(SESSION_ID, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "first I will open a PR" },
  });
  sessionUpdate(SESSION_ID, {
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "open_pr",
    rawInput: { bundleRef: "github:PAT:prod" },
  });

  if (SCENARIO === "permission") {
    // PROPOSE-ONLY: ask the client to permit executing the tool. A correct client DENIES.
    const response = await serverRequest("session/request_permission", {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: "call-1", title: "open_pr" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    record.permissionResponse = response;
    // Decide whether the client APPROVED. An approval = an `allow`/`approve` outcome; anything
    // else (cancelled / reject) is a denial. The fake only "executes" the tool if approved.
    const outcome =
      response && typeof response === "object" && "outcome" in response
        ? response.outcome
        : undefined;
    const outcomeKind =
      outcome && typeof outcome === "object" && "outcome" in outcome ? outcome.outcome : undefined;
    const selectedOption =
      outcome && typeof outcome === "object" && "optionId" in outcome
        ? outcome.optionId
        : undefined;
    record.permissionApproved =
      outcomeKind === "selected" && (selectedOption === "allow" || selectedOption === "approve");
    if (record.permissionApproved) {
      // Self-execution — must NEVER happen under propose-only. If it does, the test catches it.
      record.toolExecuted = true;
      sessionUpdate(SESSION_ID, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "EXECUTED open_pr (client approved!)" },
      });
    }
  }

  if (SCENARIO === "hostaccess") {
    // DENY-BY-DEFAULT: the agent asks the client for HOST access (filesystem + terminal). We declared
    // NO fs/terminal client capability, so a correct client answers each with a JSON-RPC -32601 error
    // and grants NO access. The fake "obtains host access" ONLY if it gets a success `result`.
    const fsResponse = await serverRequest("fs/read_text_file", {
      sessionId: SESSION_ID,
      path: "/etc/should-never-be-read",
    });
    record.fsReadResponse = fsResponse;
    const terminalResponse = await serverRequest("terminal/create", {
      sessionId: SESSION_ID,
      command: "id",
    });
    record.terminalCreateResponse = terminalResponse;
    // A response is a GRANT only if it carries a success `result` (no `error`). A -32601 error =
    // denial. If either request was answered with a success, host access was (wrongly) granted.
    const isGrant = (r) => r !== null && typeof r === "object" && !("error" in r);
    record.hostAccessGranted = isGrant(fsResponse) || isGrant(terminalResponse);
    if (record.hostAccessGranted) {
      // Must NEVER happen: surface it so the test can catch a mis-answered request.
      sessionUpdate(SESSION_ID, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "HOST ACCESS GRANTED (client mis-answered!)" },
      });
    }
  }

  // Flush the side-channel log SYNCHRONOUSLY before resolving the prompt: once the prompt resolves
  // the turn is complete and the client may tear the child down (kill), which would race a
  // flush-on-exit. Flushing here guarantees the test can always read what happened.
  flushLog();

  // Resolve the prompt -> the turn ends.
  // (id is filled in by the caller's request id correlation below.)
  promptResolve();
}

let promptResolve = () => {};
/** Resolve the in-flight prompt with a CUSTOM result (e.g. a non-terminal stopReason for loop turns). */
let promptResolveWith = (_result) => {};

/** Extract the plain text the client sent in a session/prompt's content (the governed result, etc.). */
function promptText(params) {
  const prompt = params && typeof params === "object" ? params.prompt : undefined;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) =>
      block && typeof block === "object" && typeof block.text === "string" ? block.text : "",
    )
    .join("");
}

/** How many session/prompt messages the client has sent so far (turn 1 = the intent). */
let promptCount = 0;

/** Handle one fully-parsed JSON-RPC message arriving from the client (on our stdin). */
function onClientMessage(msg) {
  // A client->agent request has a `method` and an `id`.
  if (typeof msg.method === "string" && msg.id !== undefined) {
    record.methodsReceived.push(msg.method);
    switch (msg.method) {
      case "initialize":
        respond(msg.id, {
          protocolVersion: 1,
          agentCapabilities: {},
        });
        return;
      case "session/new":
        respond(msg.id, { sessionId: SESSION_ID });
        return;
      case "session/prompt": {
        promptCount += 1;
        // The FIRST prompt carries the intent; every SUBSEQUENT prompt carries the governed result the
        // client fed back. Record the follow-up texts so the loop test can assert what egressed.
        if (promptCount > 1) record.promptTexts.push(promptText(msg.params));
        // Resolve the prompt only after the scenario's streaming completes. Two resolvers bound to
        // THIS prompt's id: the default end_turn, and a custom-result one for loop turns.
        promptResolve = () => respond(msg.id, { stopReason: "end_turn" });
        promptResolveWith = (result) => respond(msg.id, result);
        void runPrompt(msg.params);
        return;
      }
      default:
        // Unknown client->agent request -> method-not-found.
        send({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: `method not found: ${msg.method}` },
        });
        return;
    }
  }

  // A response to one of OUR (agent->client) requests has an `id` and a `result`/`error`.
  if (msg.id !== undefined && ("result" in msg || "error" in msg)) {
    const resolver = pendingServerRequests.get(msg.id);
    if (resolver !== undefined) {
      pendingServerRequests.delete(msg.id);
      resolver("error" in msg ? { error: msg.error } : msg.result);
    }
    return;
  }
  // Notifications from the client are ignored by this fake.
}

// --- stdin line buffering: parse newline-delimited JSON-RPC from the client. -----------------------
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx = buffer.indexOf("\n");
  while (idx !== -1) {
    const line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.length > 0) {
      record.stdinLines.push(line);
      try {
        onClientMessage(JSON.parse(line));
      } catch {
        // A malformed line FROM the client — the real transport never sends one; ignore.
      }
    }
    idx = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => {
  // Client closed stdin (e.g. consumer stopped early / transport cleaned up). Flush + exit clean.
  flushLog();
  process.exit(0);
});

// Flush the side-channel log on any exit path so the test can read what happened.
process.on("exit", flushLog);
