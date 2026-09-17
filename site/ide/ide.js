// The /ide/ page: Monaco over spinel.wasm in a worker. Every edit re-runs
// the whole-program analysis (debounced) and refreshes the hover types, the
// markers, the RBS and the emitted C. The Run button runs the sample's
// precompiled wasm32-wasi build; an edited program cannot run here yet
// (that needs a C compiler in the tab), and the button says so.
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
  wasmUrl: new URL("../lib/spinel.wasm", import.meta.url).href,
  timeoutMs: 60000,
  onRestart: (reason) => status(`compiler restarted — ${reason}`),
});

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
  debounce = setTimeout(runAnalyze, 300);
}

async function runAnalyze() {
  if (inflight) { queued = true; return; }
  inflight = true;
  const source = editor.getValue();
  status("analyzing…");
  try {
    const r = await client.analyze(source, current ? current.file : "main.rb");
    r.sample = current?.name ?? null;
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
function updateRunButton() {
  const pristine = current && editor.getValue() === currentSource;
  els.run.disabled = !pristine || !current?.wasm;
  els.run.title = !current?.wasm
    ? "this sample has no precompiled build"
    : pristine
      ? "run the sample's precompiled wasm32-wasi build"
      : "Run is for the unedited sample: an edited program needs a C compiler in the tab, which is not here yet";
}

async function runProgram() {
  if (!current?.wasm) return;
  selectTab("output");
  els.output.textContent = "running…";
  try {
    const r = await client.run(new URL(`../samples/${current.wasm}`, import.meta.url).href, current.name, current.argv || []);
    els.output.textContent = (r.stdout || "") + (r.stderr ? "\n[stderr]\n" + r.stderr : "") + `\n[exit ${r.rc} · ${r.elapsed_ms} ms]`;
  } catch (e) {
    els.output.textContent = `run failed — ${e.message}`;
  }
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
  };
})();
