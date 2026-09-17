// Drive an LSP server over stdio with a scripted session; prints each
// response and notification as one JSON line. Used by tools-smoke.mjs.
import { spawn } from "node:child_process";
export function lspClient(cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let buf = Buffer.alloc(0);
  const waiters = [];
  const inbox = [];
  p.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const i = buf.indexOf("\r\n\r\n");
      if (i < 0) break;
      const m = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, i).toString());
      const len = Number(m[1]);
      if (buf.length < i + 4 + len) break;
      const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString());
      buf = buf.subarray(i + 4 + len);
      const w = waiters.shift();
      if (w) w(msg); else inbox.push(msg);
    }
  });
  let stderr = "";
  p.stderr.on("data", (d) => { stderr += d; });
  const next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise((r) => waiters.push(r));
  const send = (obj) => { const body = JSON.stringify(obj); p.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); };
  let id = 0;
  return {
    request: async (method, params) => { send({ jsonrpc: "2.0", id: ++id, method, params }); for (;;) { const m = await next(); if (m.id === id) return m; inbox.unshift(m); if (m.method) { inbox.shift(); return { notification: m, ...(await waitFor(id)) }; } } },
    notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
    next,
    stderr: () => stderr,
    close: () => p.kill(),
  };
  async function waitFor(wantId) { for (;;) { const m = await next(); if (m.id === wantId) return m; } }
}
