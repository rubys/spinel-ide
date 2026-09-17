// The toolchain Web Worker: loads @yowasp/clang (large: ~105 MB of wasm
// and sysroot, fetched once and cached by the browser) plus spinel's
// runtime tree, then builds and runs an edited program on request. Kept
// apart from the analyzer worker so a compile never delays a hover, and so
// the toolchain is only fetched when someone first presses Run on an
// edited program. Same {id, op, args} protocol as worker.mjs, behind the
// same watchdog client.
import { loadToolchain } from "./clang-runner.mjs";
import { runWasi } from "./spinel-runner.mjs";

let toolchainPromise = null;

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    if (op === "init") {
      toolchainPromise = loadToolchain(args.toolchainUrl, args.rtTarUrl, {
        onProgress: (p) => self.postMessage({ progress: p }),
      });
      await toolchainPromise;
      self.postMessage({ id, result: true });
      return;
    }
    if (!toolchainPromise) throw new Error("worker not initialized");
    const tc = await toolchainPromise;
    if (op === "buildAndRun") {
      const built = await tc.compile(args.c, { overflow: args.overflow, name: args.name || "program" });
      if (!built.wasm) { self.postMessage({ id, result: { built, run: null } }); return; }
      const t0 = performance.now();
      const mod = await WebAssembly.compile(built.wasm);
      const r = await runWasi(mod, args.name || "program", args.argv || [], {}, []);
      self.postMessage({ id, result: { built: { ...built, wasm: undefined, bytes: built.wasm.length }, run: { rc: r.rc, stdout: r.stdout, stderr: r.stderr, elapsed_ms: Math.round(performance.now() - t0) } } });
    } else {
      throw new Error(`unknown op: ${op}`);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
