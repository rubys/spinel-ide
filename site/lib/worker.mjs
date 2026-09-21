// The compiler Web Worker: compiles spinel.wasm once and answers
// {id, op, args} requests off the UI thread. A wasm call is synchronous and
// cannot be interrupted, so the worker keeps no state the page cannot
// rebuild: wasm-client.mjs terminates and respawns it on a hang or a trap.
// (Protocol and the reason for it: roundhouse/wasm/lib/worker.mjs.)
import { analyze, runWasi } from "./spinel-runner.mjs";
import { untar } from "./clang-runner.mjs";

let modulePromise = null;   // spinel.wasm
let sourcesPromise = null;  // the Ruby sources beside the compiler's lib/ (pkg.tar: packages/, builtins/)
const programs = new Map(); // url -> compiled program module (Run button)

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    if (op === "init") {
      modulePromise = fetch(args.wasmUrl).then((r) => {
        if (!r.ok) throw new Error(`spinel.wasm: ${r.status}`);
        return WebAssembly.compileStreaming(r);
      });
      sourcesPromise = args.pkgTarUrl
        ? fetch(args.pkgTarUrl).then((r) => { if (!r.ok) throw new Error(`pkg.tar: ${r.status}`); return r.arrayBuffer(); }).then(untar)
        : Promise.resolve(null);
      await Promise.all([modulePromise, sourcesPromise]);
      self.postMessage({ id, result: true });
      return;
    }
    if (!modulePromise) throw new Error("worker not initialized");
    const mod = await modulePromise;
    if (op === "version") {
      const r = await runWasi(mod, "spinel", ["--version"]);
      self.postMessage({ id, result: r.stdout.trim() });
    } else if (op === "analyze") {
      self.postMessage({ id, result: await analyze(mod, args.source, { name: args.name, sources: await sourcesPromise }) });
    } else if (op === "run") {
      // A precompiled sample program: fetched once, instantiated per run.
      let pm = programs.get(args.wasmUrl);
      if (!pm) {
        pm = fetch(args.wasmUrl).then((r) => {
          if (!r.ok) throw new Error(`${args.wasmUrl}: ${r.status}`);
          return WebAssembly.compileStreaming(r);
        });
        programs.set(args.wasmUrl, pm);
      }
      const t0 = performance.now();
      const r = await runWasi(await pm, args.name || "program", args.argv || [], {}, []);
      self.postMessage({ id, result: { rc: r.rc, stdout: r.stdout, stderr: r.stderr, elapsed_ms: Math.round(performance.now() - t0) } });
    } else {
      throw new Error(`unknown op: ${op}`);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
