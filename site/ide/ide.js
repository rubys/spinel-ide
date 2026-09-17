// The /ide/ page: Monaco over spinel.wasm in a worker. Every edit re-runs
// the whole-program analysis (debounced) and refreshes the hover types, the
// markers, the RBS and the emitted C. Run executes the sample's precompiled
// wasm32-wasi build when the text is the sample's; an edited program is
// compiled in the tab by a second worker holding the clang toolchain
// (fetched on the first such Run, ~105 MB, then cached) from the C the
// analysis just emitted, and run the same way.
import { createEditor, createOutputView } from "../lib/editor.js";
import { createClient } from "../lib/wasm-client.mjs";

const $ = (id) => document.getElementById(id);
const els = {
  sample: $("sample"), analyze: $("btnAnalyze"), run: $("btnRun"), status: $("status"),
  counts: $("counts"), editor: $("editor"), diagList: document.querySelector("#diagnostics ul"),
  output: $("outputText"), version: $("version"),
};

const client = createClient({
  workerUrl: new URL("../lib/worker.mjs", import.meta.url),
  initArgs: {
    wasmUrl: new URL("../lib/spinel.wasm", import.meta.url).href,
    pkgTarUrl: new URL("../lib/pkg.tar", import.meta.url).href,
  },
  timeoutMs: 60000,
  onRestart: (reason) => status(`compiler restarted — ${reason}`),
});

// The toolchain worker is spawned on the first Run of an edited program.
let clang = null;
let toolchainStatus = "";
function clangClient() {
  if (clang) return clang;
  clang = createClient({
    workerUrl: new URL("../lib/clang-worker.mjs", import.meta.url),
    initArgs: {
      toolchainUrl: new URL("../lib/clang/", import.meta.url).href,
      rtTarUrl: new URL("../lib/rt.tar", import.meta.url).href,
    },
    timeoutMs: 180000,
    initTimeoutMs: 600000,
    onRestart: (reason) => status(`toolchain restarted — ${reason}`),
    onProgress: (p) => {
      const mb = (n) => (n / 1048576).toFixed(0);
      toolchainStatus = p.total ? `fetching toolchain ${mb(p.done)} / ${mb(p.total)} MB` : "fetching toolchain…";
      status(toolchainStatus);
      els.output.textContent = toolchainStatus + " (once; the browser caches it)";
    },
  });
  return clang;
}

let samples = [];          // manifest entries {name, label, file, wasm}
let current = null;        // the loaded sample
let currentSource = "";    // the sample's pristine text (Run is for this text)
let analysis = null;       // last result
let editor, rbsView, cView;
let debounce = null, inflight = false, queued = false;

function status(s) { els.status.textContent = s; }

// ── tabs ─────────────────────────────────────────────────────────────
for (const b of document.querySelectorAll("nav.tabs button")) {
  b.addEventListener("click", () => selectTab(b.dataset.tab));
}
function selectTab(name) {
  for (const b of document.querySelectorAll("nav.tabs button")) b.setAttribute("aria-selected", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".pane")) p.toggleAttribute("data-active", p.id === name);
}

// ── analysis ─────────────────────────────────────────────────────────
function scheduleAnalyze() {
  clearTimeout(debounce);
  debounce = setTimeout(() => { debounce = null; runAnalyze(); }, 300);
}

async function runAnalyze() {
  if (inflight) { queued = true; return; }
  inflight = true;
  const source = editor.getValue();
  status("analyzing…");
  try {
    const r = await client.analyze(source, current ? current.file : "main.rb");
    r.sample = current?.name ?? null;
    r.source = source;
    analysis = r;
    render(r);
    const errs = r.diagnostics.filter((d) => d.severity === "error").length;
    const warns = r.diagnostics.length - errs;
    status(`${r.elapsed_ms} ms · ${r.types.length} typed nodes`);
    els.counts.innerHTML = errs || warns
      ? `<b class="err">${errs}</b>/<b class="warn">${warns}</b>` : `<b class="ok">✓</b>`;
  } catch (e) {
    status(`analysis failed — ${e.message}`);
  } finally {
    inflight = false;
    if (queued) { queued = false; runAnalyze(); }
    updateRunButton();
  }
}

function render(r) {
  editor.setTypes(r.types);
  editor.setMarkers(r.diagnostics);
  rbsView.setValue(r.rbs || "(no signatures: the program defines no methods or classes)", "ruby");
  cView.setValue(r.c || (r.rc ? "(nothing emitted: the compile was refused — see Diagnostics)" : ""), "c");
  els.diagList.innerHTML = "";
  if (!r.diagnostics.length) {
    els.diagList.innerHTML = `<li class="empty">No refusals, nothing widened to untyped: every slot took the typed path.</li>`;
    return;
  }
  for (const d of r.diagnostics) {
    const li = document.createElement("li");
    li.className = d.severity;
    li.innerHTML = `<span class="where">${d.file}:${d.line}</span> ${escapeHtml(d.message)}`;
    els.diagList.appendChild(li);
  }
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ── Run ──────────────────────────────────────────────────────────────
const isPristine = () => Boolean(current) && editor.getValue() === currentSource;

function updateRunButton() {
  els.run.disabled = false;
  els.run.textContent = isPristine() && current?.wasm ? "Run" : "Build & run";
  els.run.title = isPristine() && current?.wasm
    ? "run the sample's precompiled wasm32-wasi build"
    : "compile the emitted C to wasm32-wasi in this tab (the toolchain is fetched once, ~105 MB) and run it";
}

const formatRun = (r) => (r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "") + `\n[exit ${r.rc} · ${r.elapsed_ms} ms]`;

async function runProgram() {
  selectTab("output");
  if (isPristine() && current?.wasm) {
    els.output.textContent = "running…";
    try {
      const r = await client.run(new URL(`../samples/${current.wasm}`, import.meta.url).href, current.name, current.argv || []);
      els.output.textContent = formatRun(r);
    } catch (e) {
      els.output.textContent = `run failed — ${e.message}`;
    }
    return;
  }
  // An edited program: the C from a current analysis, compiled here.
  els.output.textContent = "analyzing…";
  await settledAnalysis();
  if (!analysis?.c) {
    els.output.textContent = analysis?.rc
      ? "nothing to build: the compile was refused — see Diagnostics"
      : "nothing to build: no C was emitted";
    return;
  }
  const c = analysis.c;
  const tc = clangClient();
  els.output.textContent = toolchainStatus || "loading toolchain…";
  try {
    await tc.ready();
    els.output.textContent = "compiling…";
    status("compiling…");
    const r = await tc.buildAndRun(c, current?.name || "program", current?.argv || [], "raise");
    if (!r.run) {
      els.output.textContent = `C compile failed (rc ${r.built.rc}):\n${r.built.stderr}`;
      status("compile failed");
      return;
    }
    els.output.textContent = formatRun(r.run) + `\n[built ${(r.built.bytes / 1024).toFixed(0)} KB in ${r.built.elapsed_ms} ms]`;
    status(`built in ${r.built.elapsed_ms} ms, ran in ${r.run.elapsed_ms} ms`);
  } catch (e) {
    els.output.textContent = `build failed — ${e.message}`;
    status("build failed");
  }
}

// Resolve once the analysis reflects the editor's current text: a pending
// debounce or an in-flight pass is awaited rather than raced.
function settledAnalysis() {
  return new Promise((resolve) => {
    const tick = () => {
      if (!debounce && !inflight && !queued && analysis && analysis.source === editor.getValue()) return resolve();
      if (debounce) { clearTimeout(debounce); debounce = null; runAnalyze(); }
      setTimeout(tick, 50);
    };
    tick();
  });
}

// ── samples ──────────────────────────────────────────────────────────
async function loadSamples() {
  const r = await fetch(new URL("../samples/manifest.json", import.meta.url));
  if (!r.ok) throw new Error(`samples/manifest.json: ${r.status}`);
  samples = await r.json();
  els.sample.innerHTML = "";
  for (const s of samples) {
    const o = document.createElement("option");
    o.value = s.name; o.textContent = s.label || s.name;
    els.sample.appendChild(o);
  }
}

async function openSample(name) {
  const s = samples.find((x) => x.name === name) || samples[0];
  if (!s) return;
  const r = await fetch(new URL(`../samples/${s.file}`, import.meta.url));
  currentSource = await r.text();
  current = s;
  els.sample.value = s.name;
  editor.setValue(currentSource);
  els.output.textContent = "";
  updateRunButton();
  location.hash = s.name;
  runAnalyze();
}

// ── boot ─────────────────────────────────────────────────────────────
(async () => {
  editor = await createEditor(els.editor, { onChange: () => { updateRunButton(); scheduleAnalyze(); } });
  rbsView = await createOutputView($("rbs"));
  cView = await createOutputView($("c"));
  els.analyze.addEventListener("click", runAnalyze);
  els.run.addEventListener("click", runProgram);
  els.sample.addEventListener("change", () => openSample(els.sample.value));

  try {
    await loadSamples();
    await client.ready();
    const v = await client.version();
    fetch(new URL("../version.json", import.meta.url)).then((r) => r.ok ? r.json() : null).then((j) => {
      els.version.innerHTML = j
        ? `${v} · <a href="https://github.com/matz/spinel/commit/${j.spinel_sha}">${j.spinel_sha.slice(0, 8)}</a> · built ${j.built_at}`
        : v;
    }).catch(() => { els.version.textContent = v; });
    status("ready");
    await openSample(location.hash.slice(1) || samples[0]?.name);
  } catch (e) {
    status(`failed to start — ${e.message}`);
  }

  // Test hooks for scripts/verify-ide.mjs.
  window.__ide = {
    analysis: () => analysis,
    open: openSample,
    run: runProgram,
    ready: () => Boolean(analysis),
    editorKind: () => editor.kind,
    setSource: (text) => { editor.setValue(text); updateRunButton(); scheduleAnalyze(); },
  };
})();
