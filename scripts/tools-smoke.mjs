// The gate for spinel-mcp and spinel-lsp: one scripted session per
// protocol, run against the CRuby form (`ruby tools/x.rb`) and, when a
// compiled binary is given, against that too, with the answers required to
// agree. Timings are normalized before comparing.
//
//   node scripts/tools-smoke.mjs <spinel binary> [<bin dir with spinel-mcp, spinel-lsp>]
//
// A disagreement between the two forms is a spinel bug with a repro (the
// tool source and the session), which is the point of running both.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lspClient } from "./lsp-session.mjs";

const [spinel, binDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!spinel) { console.error("usage: tools-smoke.mjs <spinel binary> [bin dir]"); process.exit(2); }
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const env = { SPINEL: spinel };

let failures = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));
const norm = (s) => JSON.stringify(s).replace(/analyzed in \d+ ms/g, "analyzed in N ms");

// Positions in point.rb, computed so an edit to the sample's comments does
// not move the test.
const pointSrc = (await readFile(path.join(repo, "samples", "point.rb"), "utf8")).split("\n");
const DEF_LINE = pointSrc.findIndex((l) => /def dist2/.test(l)) + 1;
const X_COL = pointSrc[DEF_LINE - 1].indexOf("@x");
const PUTS_LINE = pointSrc.findIndex((l) => /^puts pts.map/.test(l)) + 1;
const DIST2_COL = pointSrc[PUTS_LINE - 1].indexOf("dist2") + 1;
const O_COL = pointSrc[DEF_LINE - 1].indexOf("(o)") + 1;          // the parameter `o`
const O_USE_COL = pointSrc[DEF_LINE - 1].indexOf("o.x");          // its first use

// ---- MCP ----
const mcpSession = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "diagnostics", arguments: { file: "samples/widening.rb" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "type_at", arguments: { file: "samples/point.rb", line: DEF_LINE, column: X_COL } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "signatures", arguments: { file: "samples/widening.rb" } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "wont_compile", arguments: { file: "samples/refusal.rb" } } },
  { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "c_for", arguments: { file: "samples/widening.rb", method: "total" } } },
  { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "type_at", arguments: { file: "samples/point.rb", line: PUTS_LINE, column: 5 } } },
  { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "diagnostics", arguments: { file: "samples/nope.rb" } } },
  { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "slow_sites", arguments: { file: "samples/point.rb" } } },
  { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "definition", arguments: { file: "samples/point.rb", line: PUTS_LINE, column: DIST2_COL } } },
  { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "references", arguments: { file: "samples/point.rb", line: PUTS_LINE, column: 5 } } },
  { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "type_at", arguments: { file: "samples/point.rb", line: DEF_LINE, column: 6 } } },
  { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "definition", arguments: { file: "samples/point.rb", line: DEF_LINE, column: O_USE_COL } } },
  { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "type_at", arguments: { file: "samples/point.rb", line: DEF_LINE, column: O_COL } } },
];
const MCP_RESPONSES = mcpSession.filter((m) => m.id != null).length;

function runMcp(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: repo, env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, lines: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)), err }));
    p.stdin.end(mcpSession.map((m) => JSON.stringify(m)).join("\n") + "\n");
  });
}

const text = (r) => r.result?.content?.[0]?.text ?? "";
function checkMcp(label, r) {
  check(r.code === 0 && r.lines.length === MCP_RESPONSES, `${label}: ${MCP_RESPONSES} responses, exit ${r.code}${r.err ? " stderr: " + r.err.slice(0, 200) : ""}`);
  if (r.lines.length < MCP_RESPONSES) return;
  const by = Object.fromEntries(r.lines.map((l) => [l.id, l]));
  check(by[1].result?.serverInfo?.name === "spinel-mcp", `${label}: initialize`);
  check(by[2].result?.tools?.length === 9, `${label}: tools/list has 9 tools`);
  check(/\d+ widening\(s\)/.test(text(by[3])) && /`total`/.test(text(by[3])) && /parameter `items`/.test(text(by[3])), `${label}: diagnostics on widening.rb name the slot`);
  check(/passed `2\.5` is Float, where the slot was Integer \(two kinds meet: untyped\)/.test(text(by[3])) && /and `1` is Integer/.test(text(by[3])) && /born here/.test(text(by[3])), `${label}: diagnostics carry the why under each widening`);
  check(/`@x`: Integer/.test(text(by[4])), `${label}: type_at @x -> ${text(by[4]).split("\n")[0]}`);
  check(/@price: untyped/.test(text(by[5])) && /\[slow/.test(text(by[5])), `${label}: signatures mark the slow path`);
  check(/1 refusal/.test(text(by[6])) && /unsupported/.test(text(by[6])), `${label}: wont_compile on refusal.rb`);
  check(/sp_total\(/.test(text(by[7])), `${label}: c_for total finds sp_total`);
  check(/`pts`: Array\[untyped\]/.test(text(by[8])) && /enclosing: map -> Array\[Integer\], inspect -> String/.test(text(by[8])), `${label}: type_at on a call chain gives the tightest node and its enclosing calls`);
  check(by[9].result?.isError === true && /no such file/.test(text(by[9])), `${label}: a missing file is a tool error`);
  check(/`dist2` -> switch/.test(text(by[10])), `${label}: slow_sites lists dist2 as a switch`);
  check(/def `Point#dist2`: \(untyped\) -> Integer  \[slow/.test(text(by[11])), `${label}: definition of the dist2 call is its def, with its signature (${text(by[11])})`);
  check(/`Point#dist2`: \(untyped\) -> Integer/.test(text(by[13])), `${label}: type_at on a def is its signature (${text(by[13]).split("\n")[0]})`);
  check(new RegExp(`:${DEF_LINE}:${O_COL} RequiredParameterNode \`o\`: untyped`).test(text(by[14])), `${label}: definition of a parameter's use is the parameter (${text(by[14])})`);
  check(/`o`: untyped/.test(text(by[15])), `${label}: type_at on a parameter is the slot's type (${text(by[15]).split("\n")[0]})`);
  check(text(by[12]).split("\n").length === 3 && /LocalVariableWriteNode/.test(text(by[12])), `${label}: references of pts are its write and two reads`);
}

const mcpRuby = await runMcp("ruby", ["tools/spinel-mcp.rb", "."]);
checkMcp("mcp/ruby", mcpRuby);
if (binDir) {
  const mcpBin = await runMcp(path.join(binDir, "spinel-mcp"), ["."]);
  checkMcp("mcp/spinel", mcpBin);
  check(norm(mcpRuby.lines) === norm(mcpBin.lines), "mcp: the compiled binary answers exactly as CRuby does");
}

// ---- LSP ----
async function runLsp(cmd, args) {
  const c = lspClient(cmd, args, env);
  const file = path.join(repo, "samples", "point.rb");
  const uri = pathToFileURL(file).href;
  const src = await readFile(file, "utf8");
  const out = {};
  out.init = (await c.request("initialize", { processId: null, rootUri: pathToFileURL(repo).href, capabilities: {} })).result;
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", { textDocument: { uri, languageId: "ruby", version: 1, text: src } });
  out.diags1 = (await c.next()).params;
  const l = src.split("\n").findIndex((x) => /def dist2/.test(x));
  const col = src.split("\n")[l].indexOf("@x") + 1;
  out.hover = (await c.request("textDocument/hover", { textDocument: { uri }, position: { line: l, character: col } })).result;
  out.hints = (await c.request("textDocument/inlayHint", { textDocument: { uri }, range: {} })).result;
  out.lenses = (await c.request("textDocument/codeLens", { textDocument: { uri } })).result;
  const pl = src.split("\n").findIndex((x) => /^puts pts.map/.test(x));
  const dcol = src.split("\n")[pl].indexOf("dist2") + 1;
  out.def = (await c.request("textDocument/definition", { textDocument: { uri }, position: { line: pl, character: dcol } })).result;
  out.refs = (await c.request("textDocument/references", { textDocument: { uri }, position: { line: pl, character: 5 }, context: { includeDeclaration: true } })).result;
  out.hoverCall = (await c.request("textDocument/hover", { textDocument: { uri }, position: { line: pl, character: dcol } })).result;
  out.hoverDef = (await c.request("textDocument/hover", { textDocument: { uri }, position: { line: l, character: 6 } })).result;
  out.defParam = (await c.request("textDocument/definition", { textDocument: { uri }, position: { line: l, character: O_USE_COL } })).result;
  out.refsParam = (await c.request("textDocument/references", { textDocument: { uri }, position: { line: l, character: O_USE_COL }, context: { includeDeclaration: true } })).result;
  // An edit that widens @y to Float: diagnostics come back for the new text.
  c.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: src.replace("i * 2", "i * 2.5") }] });
  out.diags2 = (await c.next()).params;
  out.hints2 = (await c.request("textDocument/inlayHint", { textDocument: { uri }, range: {} })).result;
  // An edit that breaks the parse (an unclosed def): the parse error is
  // published, and hover still answers from the last analysis that parsed.
  c.notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: src.replace("attr_reader :x, :y", "def broken(\n  attr_reader :x, :y") }] });
  out.diags3 = (await c.next()).params;
  out.hover3 = (await c.request("textDocument/hover", { textDocument: { uri }, position: { line: l, character: col } })).result;
  await c.request("shutdown", null);
  c.notify("exit", null);
  out.stderr = c.stderr();
  return out;
}

function checkLsp(label, o) {
  check(o.init?.capabilities?.hoverProvider === true, `${label}: initialize advertises hover/inlayHint/codeLens`);
  const warns = (o.diags1?.diagnostics || []).filter((d) => d.severity === 2);
  check(warns.length === 1 && warns[0].range.start.character === 12 && /parameter `o`/.test(warns[0].message), `${label}: didOpen publishes the widening warning on its slot (${warns[0]?.range.start.line}:${warns[0]?.range.start.character})`);
  const rel = warns[0]?.relatedInformation || [];
  check(rel.length === 2 && rel[0].location.range.start.line === PUTS_LINE - 1 && /^passed `pts\[0\]` is untyped$/.test(rel[0].message) && /born here/.test(rel[1].message), `${label}: the warning's relatedInformation is the why (${rel.map((r) => r.message).join("; ") || "none"})`);
  const hints = (o.diags1?.diagnostics || []).filter((d) => d.source === "spinel codegen");
  check(hints.length === 3 && hints.every((d) => d.severity >= 3), `${label}: codegen decisions published as ${hints.length} hint diagnostics`);
  check(/Integer/.test(o.hover?.contents?.value || ""), `${label}: hover on @x -> ${(o.hover?.contents?.value || "none").replace(/\n/g, " ")}`);
  check(o.hints?.length === 2 && o.hints.some((h) => /\(untyped\) -> Integer/.test(h.label)), `${label}: inlay hints show both signatures (${o.hints?.map((h) => h.label).join("; ")})`);
  check(o.lenses?.some((x) => /slow path/.test(x.command.title)) && o.lenses?.some((x) => x.command.title === "fast path"), `${label}: code lenses mark fast and slow defs`);
  check(o.diags2?.diagnostics?.length >= 1, `${label}: didChange re-analyzes (${o.diags2?.diagnostics?.length} diagnostics)`);
  check(o.hints2?.some((h) => /Float/.test(h.label)), `${label}: after the edit a signature mentions Float (${o.hints2?.map((h) => h.label).join("; ")})`);
  const perr = (o.diags3?.diagnostics || []).filter((d) => d.severity === 1);
  check(perr.length >= 1, `${label}: a buffer that does not parse publishes the parse error (${perr.map((d) => `${d.range.start.line}:${d.range.start.character} ${d.message.slice(0, 40)}`).join("; ") || "none"})`);
  check(/Integer/.test(o.hover3?.contents?.value || ""), `${label}: hover still answers from the last-good analysis while the buffer does not parse`);
  check(o.def?.range?.start?.line === DEF_LINE - 1 && o.def?.range?.start?.character === 2, `${label}: definition of the dist2 call -> ${JSON.stringify(o.def?.range?.start)}`);
  check(o.refs?.length === 3, `${label}: references of pts -> ${o.refs?.length}`);
  check(/dispatch of `dist2`: switch/.test(o.hoverCall?.contents?.value || ""), `${label}: hover on the call shows its dispatch`);
  check(/\*\*Point#dist2\*\* — `\(untyped\) -> Integer`/.test(o.hoverDef?.contents?.value || ""), `${label}: hover on the def shows its signature (${(o.hoverDef?.contents?.value || "none").split("\n")[0]})`);
  check(o.defParam?.range?.start?.line === DEF_LINE - 1 && o.defParam?.range?.start?.character === O_COL, `${label}: definition of a parameter's use -> ${JSON.stringify(o.defParam?.range?.start)}`);
  check(o.refsParam?.length === 3, `${label}: references of a parameter include its declaration (${o.refsParam?.length})`);
  check(!o.stderr, `${label}: no stderr${o.stderr ? ": " + o.stderr.slice(0, 200) : ""}`);
}

const lspRuby = await runLsp("ruby", [path.join(repo, "tools", "spinel-lsp.rb")]);
checkLsp("lsp/ruby", lspRuby);
if (binDir) {
  const lspBin = await runLsp(path.join(binDir, "spinel-lsp"), []);
  checkLsp("lsp/spinel", lspBin);
  const strip = (o) => { const { stderr, ...rest } = o; return rest; };
  check(norm(strip(lspRuby)) === norm(strip(lspBin)), "lsp: the compiled binary answers exactly as CRuby does");
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
