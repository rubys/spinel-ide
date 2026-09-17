// Runs a WASI command module (spinel.wasm, or a program spinel compiled for
// wasm32-wasi) against an in-memory filesystem, and hands back what it wrote.
// Web-platform APIs only (the vendored @bjorn3/browser_wasi_shim), so the
// same module drives the browser worker, the Run button, and the Node smoke
// gate in scripts/smoke.mjs.
//
// spinel is a command, not a reactor: every invocation is a fresh instance
// of a module compiled once. Instantiation is ~10 ms; a compile of a
// benchmark-sized program is 15-160 ms, so an edit -> analyze loop can afford
// the three passes analyze() makes (--emit-types, --emit-rbs, -S).
import { WASI, File, OpenFile, ConsoleStdout, PreopenDirectory, Directory } from "./wasi/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// A tree ({ name: string | Uint8Array | subtree }) as the shim's Map of
// File / Directory inodes.
function mount(tree) {
  const entries = new Map();
  for (const [name, body] of Object.entries(tree)) {
    if (typeof body === "string") entries.set(name, new File(enc.encode(body)));
    else if (body instanceof Uint8Array) entries.set(name, new File(body));
    else if (body && typeof body === "object") entries.set(name, new Directory(mount(body)));
  }
  return entries;
}

// module: a compiled WebAssembly.Module. args: argv without argv[0].
// files: a tree placed in the preopened root "/" (a plain object is a
// directory, a string or Uint8Array a file).
// Returns { rc, stdout, stderr, files } where files is a name -> Uint8Array
// map of the root's top level after the run (inputs included, outputs added).
export async function runWasi(module, argv0, args, files = {}, env = ["TMPDIR=/"]) {
  let stdout = "", stderr = "";
  const root = new PreopenDirectory("/", mount(files));
  const fds = [
    new OpenFile(new File([])),
    ConsoleStdout.lineBuffered((s) => { stdout += s + "\n"; }),
    ConsoleStdout.lineBuffered((s) => { stderr += s + "\n"; }),
    root,
  ];
  const wasi = new WASI([argv0, ...args], env, fds, { debug: false });
  const inst = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
  let rc;
  try {
    rc = wasi.start(inst);
  } catch (e) {
    // A trap (unreachable, OOB) surfaces as a RuntimeError; a wasm `exit`
    // past what start() catches carries a numeric code.
    if (typeof e?.code === "number") rc = e.code;
    else throw e;
  }
  const out = {};
  for (const [name, node] of root.dir.contents) if (node.data) out[name] = node.data;
  return { rc, stdout, stderr, files: out };
}

export const text = (bytes) => (bytes ? dec.decode(bytes) : null);

// One analysis of a single-file program: the per-position types and the
// diagnostics (refusals as errors, widenings as warnings), the inferred RBS,
// and the emitted C. Three spinel invocations; each is independent, so a
// refusal that stops -S (nothing written) still leaves types and RBS.
//
// opts.packages: a tree of the bundled packages' Ruby sources
// (packages/<name>/...), so `require "json"` resolves. The compiler looks
// for them beside its lib/, found through lib/libspinel_rt.a existing next
// to argv[0]; a placeholder for that file is enough for the lookup.
export async function analyze(module, source, opts = {}) {
  const name = opts.name || "main.rb";
  const base = opts.packages
    ? { packages: opts.packages, lib: { "libspinel_rt.a": new Uint8Array([0]) } }
    : {};
  const t0 = performance.now();
  const types = await runWasi(module, "spinel", [name, "--emit-types", "-o", "main.json"], { ...base, [name]: source });
  const rbs = await runWasi(module, "spinel", [name, "--emit-rbs", "-o", "main.rbs"], { ...base, [name]: source });
  const c = await runWasi(module, "spinel", [name, "-S"], { ...base, [name]: source });
  let parsed = null;
  const json = text(types.files["main.json"]);
  if (json) { try { parsed = JSON.parse(json); } catch { parsed = null; } }
  return {
    types: parsed?.types ?? [],
    diagnostics: parsed?.diagnostics ?? parseStderr(types.stderr, name),
    rbs: text(rbs.files["main.rbs"]) ?? "",
    c: c.rc === 0 ? c.stdout : "",
    stderr: types.stderr,
    rc: types.rc,
    elapsed_ms: Math.round(performance.now() - t0),
  };
}

// `spinel: FILE:LINE: message` lines, for the case where no JSON was written
// (a parse failure stops before --emit-types has anything to write).
export function parseStderr(stderr, name) {
  const out = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/^spinel: (?:(.+?):(\d+): )?(.*)$/);
    if (!m) continue;
    if (/^\d+ refusals?$/.test(m[3])) continue;
    out.push({ file: m[1] || name, line: m[2] ? Number(m[2]) : 1, col: 0, severity: "error", message: m[3] });
  }
  return out;
}
