// Compile the C spinel emits into a wasm32-wasi module, in JavaScript: the
// @yowasp/clang toolchain (clang + wasm-ld + a wasi sysroot, LLVM 22, built
// as wasm) over a file tree holding spinel's runtime headers, the runtime
// archive `make wasm-rt` produced, and the bundled packages' wasi objects.
// Web-platform APIs only; drives the browser worker and the Node smoke gate.
//
// The tree comes from rt.tar, which scripts/build-site.sh packs from the
// spinel checkout: lib/*.h, lib/regexp/*.h, lib/wasi/**, lib/wasm32-wasi/
// libspinel_rt.a and packages/*/sp_*_wasi.o. The flags are the ones
// `spinel --target=wasm32-wasi --print-build` reports, so the module built
// here is the one the native driver would have built.

const enc = new TextEncoder();
const dec = new TextDecoder();

// A ustar archive -> nested { name: Uint8Array | subtree }, the Tree shape
// @yowasp/runtime takes. Only regular files and directories; names are
// short (< 100 chars) so the prefix field is never needed, but it is read.
export function untar(bytes) {
  const tree = {};
  const view = new Uint8Array(bytes);
  const str = (off, len) => { const s = dec.decode(view.subarray(off, off + len)); const z = s.indexOf("\0"); return z < 0 ? s : s.slice(0, z); };
  let pos = 0;
  while (pos + 512 <= view.length) {
    if (view[pos] === 0) break;                       // end-of-archive blocks
    const name = str(pos, 100), size = parseInt(str(pos + 124, 12), 8) || 0;
    const type = String.fromCharCode(view[pos + 156] || 48), prefix = str(pos + 345, 155);
    const full = (prefix ? prefix + "/" : "") + name;
    pos += 512;
    if (type === "0" || type === "\0") {
      const parts = full.split("/").filter(Boolean);
      let node = tree;
      for (const p of parts.slice(0, -1)) node = node[p] ??= {};
      node[parts[parts.length - 1]] = view.slice(pos, pos + size);
    }
    pos += Math.ceil(size / 512) * 512;
  }
  return tree;
}

// Declarations + definitions for what the toolchain's wasi-libc lacks and
// the runtime headers call: flockfile/funlockfile (added to the single-
// threaded libc after this libc snapshot). Force-included so the call sites
// see the prototype (an implicit int declaration would mismatch the
// definition's signature and trap at the call).
const COMPAT_H = "#include <stdio.h>\nvoid flockfile(FILE *);\nvoid funlockfile(FILE *);\n";
const COMPAT_C = '#include "compat.h"\nvoid flockfile(FILE *f) { (void)f; }\nvoid funlockfile(FILE *f) { (void)f; }\n';

const CFLAGS = [
  "-O2", "-w", "-Ilib", "-Ilib/regexp", "-Ilib/wasi", "-include", "compat.h",
  "-D_WASI_EMULATED_SIGNAL", "-D_WASI_EMULATED_PROCESS_CLOCKS", "-D_WASI_EMULATED_GETPID", "-D_WASI_EMULATED_MMAN",
  "-mllvm", "-wasm-enable-sjlj", "-mllvm", "-wasm-use-legacy-eh=false",
];
const LDFLAGS = [
  "-lsetjmp", "-lwasi-emulated-signal", "-lwasi-emulated-process-clocks", "-lwasi-emulated-getpid", "-lwasi-emulated-mman", "-lm",
  "-Wl,-z,stack-size=8388608", "-Wl,--gc-sections",
];

// toolchainUrl: the directory holding @yowasp/clang's gen/ (bundle.js and
// its wasm). rtTarUrl: rt.tar. onProgress({stage, done, total}) is called
// as the (large) toolchain fetches. Returns { compile(c, opts) }.
export async function loadToolchain(toolchainUrl, rtTarUrl, { onProgress, fetchImpl = fetch } = {}) {
  const { runClang } = await import(new URL("bundle.js", toolchainUrl).href);
  const rt = await fetchImpl(rtTarUrl).then((r) => { if (!r.ok) throw new Error(`${rtTarUrl}: ${r.status}`); return r.arrayBuffer(); }).then(untar);
  const objects = [];
  for (const [pkg, files] of Object.entries(rt.packages ?? {})) {
    for (const f of Object.keys(files)) if (f.endsWith("_wasi.o")) objects.push(`packages/${pkg}/${f}`);
  }
  const fetchProgress = onProgress
    ? (e) => onProgress({ stage: "toolchain", done: e.doneLength, total: e.totalLength })
    : undefined;

  // c: the emitted C. opts.overflow: raise|wrap|promote (spinel's default is
  // raise). Returns { wasm, stderr, rc, elapsed_ms }; wasm is null when the
  // compile or link failed, and stderr says why.
  async function compile(c, { overflow = "raise", name = "program" } = {}) {
    const files = { ...rt, "compat.h": enc.encode(COMPAT_H), "compat.c": enc.encode(COMPAT_C), [`${name}.c`]: enc.encode(c) };
    const args = [
      "clang", ...CFLAGS, `-DSP_INT_OVERFLOW_MODE_${overflow.toUpperCase()}`,
      `${name}.c`, "compat.c", ...objects, "lib/wasm32-wasi/libspinel_rt.a", ...LDFLAGS,
      "-o", `${name}.wasm`,
    ];
    let stderr = "";
    const t0 = performance.now();
    let out, rc = 0;
    try {
      out = await runClang(args, files, { stderr: (b) => { if (b) stderr += dec.decode(b); }, stdout: (b) => { if (b) stderr += dec.decode(b); }, fetchProgress });
    } catch (e) {
      if (typeof e?.code === "number") { rc = e.code; out = e.files; } else throw e;
    }
    const wasm = rc === 0 && out?.[`${name}.wasm`] instanceof Uint8Array ? out[`${name}.wasm`] : null;
    return { wasm, stderr, rc: wasm ? 0 : (rc || 1), elapsed_ms: Math.round(performance.now() - t0) };
  }

  return { compile, objects };
}
