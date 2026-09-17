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

// ---- MCP ----
const mcpSession = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "diagnostics", arguments: { file: "samples/widening.rb" } } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "type_at", arguments: { file: "samples/point.rb", line: 7, column: 18 } } },
  { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "signatures", arguments: { file: "samples/widening.rb" } } },
  { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "wont_compile", arguments: { file: "samples/refusal.rb" } } },
  { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "c_for", arguments: { file: "samples/widening.rb", method: "total" } } },
  { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "type_at", arguments: { file: "samples/point.rb", line: 11, column: 5 } } },
  { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "diagnostics", arguments: { file: "samples/nope.rb" } } },
];

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
  check(r.code === 0 && r.lines.length === 9, `${label}: 9 responses, exit ${r.code}${r.err ? " stderr: " + r.err.slice(0, 200) : ""}`);
  if (r.lines.length < 9) return;
  const by = Object.fromEntries(r.lines.map((l) => [l.id, l]));
  check(by[1].result?.serverInfo?.name === "spinel-mcp", `${label}: initialize`);
  check(by[2].result?.tools?.length === 6, `${label}: tools/list has 6 tools`);
  check(/2 widening\(s\)/.test(text(by[3])) && /`total`/.test(text(by[3])), `${label}: diagnostics on widening.rb`);
  check(/`@x`: Integer/.test(text(by[4])), `${label}: type_at @x -> ${text(by[4])}`);
  check(/@price: untyped/.test(text(by[5])) && /\[slow/.test(text(by[5])), `${label}: signatures mark the slow path`);
  check(/1 refusal/.test(text(by[6])) && /unsupported/.test(text(by[6])), `${label}: wont_compile on refusal.rb`);
  check(/sp_total\(/.test(text(by[7])), `${label}: c_for total finds sp_total`);
  check(/Array\[untyped\] \| Array\[Integer\] \| String/.test(text(by[8])), `${label}: type_at on a call chain lists the nested types (${text(by[8]).slice(-60)})`);
  check(by[9].result?.isError === true && /no such file/.test(text(by[9])), `${label}: a missing file is a tool error`);
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
  // An edit that widens @y to Float: diagnostics come back for the new text.
  c.notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: src.replace("i * 2", "i * 2.5") }] });
  out.diags2 = (await c.next()).params;
  out.hints2 = (await c.request("textDocument/inlayHint", { textDocument: { uri }, range: {} })).result;
  await c.request("shutdown", null);
  c.notify("exit", null);
  out.stderr = c.stderr();
  return out;
}

function checkLsp(label, o) {
  check(o.init?.capabilities?.hoverProvider === true, `${label}: initialize advertises hover/inlayHint/codeLens`);
  check(o.diags1?.diagnostics?.length === 1 && o.diags1.diagnostics[0].severity === 2, `${label}: didOpen publishes the widening warning`);
  check(/Integer/.test(o.hover?.contents?.value || ""), `${label}: hover on @x -> ${(o.hover?.contents?.value || "none").replace(/\n/g, " ")}`);
  check(o.hints?.length === 2 && o.hints.some((h) => /\(untyped\) -> Integer/.test(h.label)), `${label}: inlay hints show both signatures (${o.hints?.map((h) => h.label).join("; ")})`);
  check(o.lenses?.some((x) => /slow path/.test(x.command.title)) && o.lenses?.some((x) => x.command.title === "fast path"), `${label}: code lenses mark fast and slow defs`);
  check(o.diags2?.diagnostics?.length >= 1, `${label}: didChange re-analyzes (${o.diags2?.diagnostics?.length} diagnostics)`);
  check(o.hints2?.some((h) => /Float/.test(h.label)), `${label}: after the edit a signature mentions Float (${o.hints2?.map((h) => h.label).join("; ")})`);
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
