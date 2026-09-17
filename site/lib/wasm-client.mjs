// Main-thread client for worker.mjs: the {id, op, args} RPC behind a
// watchdog. A wasm call can hang or trap; on timeout or a worker error the
// client terminates the worker, spawns a fresh one, and rejects the call in
// flight, so the page shows a message instead of freezing the tab.
// Adapted from roundhouse/wasm/lib/wasm-client.mjs (MIT).
export function createClient({ workerUrl, wasmUrl, timeoutMs = 30000, initTimeoutMs = 120000, onRestart } = {}) {
  let worker, pending, nextId, ready;

  function spawn() {
    worker = new Worker(workerUrl, { type: "module" });
    pending = new Map();
    nextId = 1;
    worker.onmessage = (e) => {
      const { id, result, error } = e.data;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      error ? p.reject(new Error(error)) : p.resolve(result);
    };
    worker.onerror = (ev) => restart(`worker crashed: ${ev?.message || "trap"}`);
    ready = post("init", { wasmUrl }, initTimeoutMs);
    ready.catch(() => {});
  }

  function restart(reason) {
    const dead = worker;
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    try { dead.terminate(); } catch { /* gone */ }
    if (onRestart) { try { onRestart(reason); } catch { /* ignore */ } }
    spawn();
  }

  function post(op, args, timeout) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`${op} exceeded ${timeout}ms`));
        restart(`${op} timed out after ${timeout}ms`);
      }, timeout);
      pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, op, args });
    });
  }

  async function call(op, args) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = ready;
      try { await r; } catch (e) { if (r === ready) throw e; continue; }
      if (r === ready) return post(op, args, timeoutMs);
    }
    throw new Error("compiler worker unavailable");
  }

  spawn();
  return {
    ready: () => ready,
    call,
    version: () => call("version", {}),
    analyze: (source, name) => call("analyze", { source, name }),
    run: (wasmUrl, name, argv) => call("run", { wasmUrl, name, argv }),
    dispose: () => { try { worker.terminate(); } catch { /* ignore */ } },
  };
}
