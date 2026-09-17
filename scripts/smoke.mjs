// The deploy gate. Runs against a built site directory and a spinel
// checkout, with nothing but Node (its WASI is not needed: the site's own
// browser shim drives every module, so what passes here is what the page
// runs). Every check names what it saw when it fails; the workflow deploys
// only when this exits 0.
//
//   node scripts/smoke.mjs <site dir> <spinel checkout>
//
// 1. spinel.wasm reports a version and emits, for every sample, C identical
//    to the native compiler's `--target=wasm32-wasi -S` output (same commit,
//    same program). The wasm-hosted compiler is a 32-bit spinel, so it
//    classifies integer literals for a 32-bit Integer, as the native one
//    does when asked for that target; a plain native -S would differ where
//    a literal exceeds 2**31.
// 2. --emit-types on the wasm build parses, types every sample, and carries
//    the refusal sample's refusal as a `severity: error` diagnostic and the
//    widening sample's widening as a warning.
// 3. Every precompiled sample .wasm runs under the shim with stdout equal to
//    the native binary's (samples/<name>.out).
// 4. The hover resolver picks the innermost type at a word.
// 5. Build & run: the in-tab toolchain (lib/clang + lib/rt.tar) compiles the
//    C the wasm compiler emits for an EDITED program and a program that
//    requires a bundled package, and both run with the expected output.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Absolute, because the native compiler is run from the samples directory.
const [siteDir, spinelDir] = process.argv.slice(2).map((p) => p && path.resolve(p));
if (!siteDir || !spinelDir) { console.error("usage: smoke.mjs <site dir> <spinel checkout>"); process.exit(2); }
const lib = (f) => pathToFileURL(path.join(siteDir, "lib", f)).href;
const { runWasi, analyze, text } = await import(lib("spinel-runner.mjs"));
const { typesAtWord } = await import(lib("editor.js"));
const { loadToolchain, untar } = await import(lib("clang-runner.mjs"));
const packages = untar(await readFile(path.join(siteDir, "lib", "pkg.tar"))).packages ?? {};

let failures = 0;
const ok = (msg) => console.log(`  ok  ${msg}`);
const fail = (msg) => { failures++; console.log(`FAIL  ${msg}`); };
const check = (cond, msg) => (cond ? ok(msg) : fail(msg));

const manifest = JSON.parse(await readFile(path.join(siteDir, "samples", "manifest.json"), "utf8"));
const compiler = await WebAssembly.compile(await readFile(path.join(siteDir, "lib", "spinel.wasm")));
const nativeSpinel = path.join(spinelDir, "spinel");

// 1. version + byte-identical C
const v = await runWasi(compiler, "spinel", ["--version"]);
check(v.rc === 0 && /^spinel /.test(v.stdout), `spinel.wasm --version: ${v.stdout.trim() || v.stderr.trim()}`);

const sources = {};
for (const s of manifest) {
  const src = await readFile(path.join(siteDir, "samples", s.file), "utf8");
  sources[s.name] = src;
  const wasmC = await runWasi(compiler, "spinel", [s.file, "-S"], { [s.file]: src });
  let nativeC = "", nativeRc = 0;
  try {
    // Same bare filename from the samples dir, so the #line paths agree.
    nativeC = execFileSync(nativeSpinel, [s.file, "--target=wasm32-wasi", "-S"], { cwd: path.join(siteDir, "samples"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch (e) { nativeRc = e.status ?? -1; nativeC = e.stdout || ""; if (e.status == null) fail(`${s.name}: native spinel did not run: ${e.message}`); }
  if (nativeRc !== 0 || wasmC.rc !== 0) {
    check(nativeRc !== 0 && wasmC.rc !== 0, `${s.name}: -S refused on both (native rc=${nativeRc}, wasm rc=${wasmC.rc})`);
  } else {
    check(wasmC.stdout === nativeC, `${s.name}: wasm -S is byte-identical to native --target=wasm32-wasi -S (${nativeC.length} bytes)`);
  }
}

// 2. --emit-types
for (const s of manifest) {
  const r = await analyze(compiler, sources[s.name], { name: s.file, packages });
  const errs = r.diagnostics.filter((d) => d.severity === "error");
  const warns = r.diagnostics.filter((d) => d.severity === "warning");
  check(r.types.length > 0, `${s.name}: --emit-types typed ${r.types.length} nodes in ${r.elapsed_ms} ms`);
  if (s.name === "refusal") {
    check(errs.length >= 1 && errs.some((d) => /unsupported/.test(d.message)), `refusal: carried as error diagnostic (${errs.map((d) => `${d.line}: ${d.message}`).join("; ") || "none"})`);
    check(r.c === "", "refusal: nothing emitted for -S");
  } else {
    check(errs.length === 0, `${s.name}: no refusals (${errs.map((d) => d.message).join("; ")})`);
    check(r.c.length > 0, `${s.name}: C emitted`);
  }
  if (s.name === "widening") {
    check(warns.some((d) => /widened to untyped/.test(d.message)), `widening: the slow-path warning is present (${warns.length} warnings)`);
    check(/untyped/.test(r.rbs), "widening: RBS shows untyped");
  }
  if (s.name === "point") check(/@x: Integer/.test(r.rbs), `point: RBS unboxed @x as Integer`);
}

// 3. run every precompiled sample against the native oracle
for (const s of manifest) {
  if (!s.wasm) { ok(`${s.name}: no build (norun)`); continue; }
  const mod = await WebAssembly.compile(await readFile(path.join(siteDir, "samples", s.wasm)));
  const expected = await readFile(path.join(siteDir, "samples", `${s.name}.out`), "utf8");
  const t0 = performance.now();
  let r;
  try { r = await runWasi(mod, s.name, s.argv || [], {}, []); }
  catch (e) { fail(`${s.name}: trapped: ${e.message}`); continue; }
  const ms = Math.round(performance.now() - t0);
  check(r.rc === 0 && r.stdout === expected, `${s.name}.wasm: rc=${r.rc}, stdout matches native (${expected.length} bytes, ${ms} ms)${r.stdout === expected ? "" : `\n      wasm: ${JSON.stringify(r.stdout.slice(0, 200))}\n    native: ${JSON.stringify(expected.slice(0, 200))}\n    stderr: ${r.stderr.slice(0, 200)}`}`);
}

// 4. hover resolution over real output
{
  const r = await analyze(compiler, sources.point, { name: "point.rb", packages });
  const line = sources.point.split("\n").findIndex((l) => /def dist2/.test(l)) + 1;
  const col = sources.point.split("\n")[line - 1].indexOf("@x") + 1;
  const got = typesAtWord(r.types, line, { startColumn: col, endColumn: col + 2 });
  check(got.includes("Integer"), `hover on @x in dist2 -> ${JSON.stringify(got)}`);
}

// 5. the in-tab toolchain on an edited program
{
  const fileFetch = async (url) => {
    const p = url instanceof URL ? url : new URL(url);
    const data = await readFile(p);
    return new Response(data, { status: 200 });
  };
  const t0 = performance.now();
  let tc;
  try {
    tc = await loadToolchain(pathToFileURL(path.join(siteDir, "lib", "clang") + "/"), pathToFileURL(path.join(siteDir, "lib", "rt.tar")), { fetchImpl: fileFetch });
    ok(`toolchain loaded in ${Math.round(performance.now() - t0)} ms (${tc.objects.length} package objects)`);
  } catch (e) { fail(`toolchain failed to load: ${e.message}`); }
  if (tc) {
    const edited = sources.hello.replace('"hello"', '"edited"');
    const a = await analyze(compiler, edited, { name: "hello.rb", packages });
    check(a.c.length > 0, "edited hello: C emitted");
    const b = await tc.compile(a.c, { name: "hello" });
    check(b.wasm && b.rc === 0, `edited hello: compiled in ${b.elapsed_ms} ms${b.wasm ? ` (${b.wasm.length} bytes)` : `: ${b.stderr.slice(0, 300)}`}`);
    if (b.wasm) {
      const r = await runWasi(await WebAssembly.compile(b.wasm), "hello", [], {}, []);
      check(r.rc === 0 && r.stdout === "edited 12\n", `edited hello runs: ${JSON.stringify(r.stdout)}${r.stderr ? " stderr: " + r.stderr.slice(0, 200) : ""}`);
    }
    const j = await analyze(compiler, 'require "json"\nputs JSON.generate({ "a" => [1, 2.5, nil] })\n', { name: "j.rb", packages });
    check(j.c.length > 0 && !j.diagnostics.some((d) => d.severity === "error"), `require "json" resolves in the analyzer (${j.diagnostics.map((d) => d.message.slice(0, 60)).join("; ") || "no diagnostics"})`);
    const jb = await tc.compile(j.c, { name: "j" });
    check(jb.wasm && jb.rc === 0, `require "json" program: linked${jb.wasm ? "" : `: ${jb.stderr.slice(0, 300)}`}`);
    if (jb.wasm) {
      const r = await runWasi(await WebAssembly.compile(jb.wasm), "j", [], {}, []);
      check(r.stdout === '{"a":[1,2.5,null]}\n', `require "json" program runs: ${JSON.stringify(r.stdout)}`);
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
