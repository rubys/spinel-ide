// Editor abstraction: Monaco from a CDN (no bundler, no npm), a <textarea>
// fallback when the CDN is unreachable. Both expose the same small interface.
// Adapted from roundhouse/wasm/lib/editor.js (MIT); the hover provider is
// spinel's: `--emit-types` gives a START position per node and no end, so a
// hover resolves to the word under the cursor and the innermost node
// starting on it.

const MONACO_VERSION = "0.52.2";
const MONACO_BASE = `https://cdn.jsdelivr.net/npm/monaco-editor@${MONACO_VERSION}/min/vs`;
const LOAD_TIMEOUT_MS = 8000;

let monacoPromise = null;
export function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  monacoPromise = new Promise((resolve, reject) => {
    if (window.monaco) return resolve(window.monaco);
    const timer = setTimeout(() => reject(new Error("monaco load timeout")), LOAD_TIMEOUT_MS);
    window.MonacoEnvironment = { getWorker: () => ({ postMessage() {}, addEventListener() {}, terminate() {} }) };
    const script = document.createElement("script");
    script.src = `${MONACO_BASE}/loader.js`;
    script.onload = () => {
      window.require.config({ paths: { vs: MONACO_BASE } });
      window.require(["vs/editor/editor.main"], () => {
        clearTimeout(timer);
        silenceWorkerLanguageServices(window.monaco);
        resolve(window.monaco);
      }, (e) => { clearTimeout(timer); reject(e); });
    };
    script.onerror = () => { clearTimeout(timer); reject(new Error("monaco loader.js failed")); };
    document.head.appendChild(script);
  });
  return monacoPromise;
}

// Monaco's worker-backed language services would wait forever on the stubbed
// worker above; the main-thread Monarch highlighters are all we need.
function silenceWorkerLanguageServices(monaco) {
  const off = {
    completionItems: false, hovers: false, documentSymbols: false, links: false,
    documentHighlights: false, rename: false, colors: false, foldingRanges: false,
    diagnostics: false, selectionRanges: false, documentFormattingEdits: false,
    documentRangeFormattingEdits: false, tokens: false, definitions: false,
    references: false, inlayHints: false, codeActions: false, onTypeFormattingEdits: false,
  };
  const langs = monaco.languages;
  langs.json?.jsonDefaults?.setModeConfiguration(off);
  langs.typescript?.typescriptDefaults?.setModeConfiguration?.(off);
  langs.typescript?.javascriptDefaults?.setModeConfiguration?.(off);
}

// Records containing a position, tightest first. `records` carry
// {line, col, end_line, end_col} (1-based line, 0-based col, exclusive
// end) since matz/spinel#4522; `lineNumber` is 1-based and `column` is
// Monaco's 1-based column. A record without an end (an older spinel)
// never matches here.
export function spansAt(records, lineNumber, column) {
  const c = column - 1;
  const inside = (r) => r.end_line != null &&
    (lineNumber > r.line || (lineNumber === r.line && c >= r.col)) &&
    (lineNumber < r.end_line || (lineNumber === r.end_line && c < r.end_col));
  const size = (r) => (r.end_line - r.line) * 100000 + (r.end_col - r.col);
  // Same span, a named node first: a block's StatementsNode covers exactly
  // the call it is the body of.
  return records.filter(inside).sort((a, b) => size(a) - size(b) || (a.name ? 0 : 1) - (b.name ? 0 : 1));
}

// Fallback for a dump without spans: the entries that START inside the
// word, innermost first, distinct.
export function typesAtWord(types, lineNumber, word) {
  if (!word) return [];
  const startCol0 = word.startColumn - 1, endCol0 = word.endColumn - 1;
  const hits = types.filter((t) => t.line === lineNumber && t.col >= startCol0 && t.col < endCol0);
  if (!hits.length) return [];
  const maxCol = Math.max(...hits.map((t) => t.col));
  const at = hits.filter((t) => t.col === maxCol);
  const seen = new Set(); const out = [];
  for (const t of at.slice().reverse()) { if (!seen.has(t.rbs)) { seen.add(t.rbs); out.push(t.rbs); } }
  return out;
}

// What a hover says at a position: the tightest typed node, the chain of
// expressions enclosing it, and what codegen decided for the call or
// block there. Returns null when nothing is typed at the position.
export function hoverAt(types, codegen, lineNumber, column) {
  const spans = spansAt(types, lineNumber, column);
  if (!spans.length) return null;
  const tight = spans[0];
  const chain = [];
  for (const r of spans.slice(1, 4)) if (r.kind === "CallNode" && r.rbs !== chain[chain.length - 1]?.rbs) chain.push(r);
  const decisions = spansAt(codegen || [], lineNumber, column);
  const call = decisions.find((d) => d.kind === "CallNode");
  const block = decisions.find((d) => d.kind === "BlockNode");
  return { tight, chain, call, block };
}

export const DISPATCH_TEXT = {
  direct: "direct: one statically bound C call, or a builtin emitted in place — the fast path",
  switch: "switch: a switch over the classes the receiver can hold, each arm a direct call",
  boxed: "boxed: the receiver is a boxed value; a runtime helper dispatches over its tag at run time",
};

function hoverMarkdown(h) {
  const t = h.tight;
  const label = t.name ? `**${t.name}**` : `*${t.kind.replace(/Node$/, "")}*`;
  const lines = [`${label} — \`${t.rbs}\``];
  if (h.chain.length) lines.push("in " + h.chain.map((r) => `\`${r.name}\` → \`${r.rbs}\``).join(", "));
  if (h.call) lines.push(`dispatch of \`${h.call.name}\`: ${DISPATCH_TEXT[h.call.dispatch] || h.call.dispatch}`);
  if (h.block) lines.push(h.block.inlined ? "block: inlined into its caller" : "block: a function of its own (a proc, lambda, Fiber or Thread body)");
  if (t.rbs === "untyped" || /untyped/.test(t.rbs)) lines.push("_untyped: the boxed slow path_");
  return lines.map((l) => ({ value: l }));
}

// Monaco's Ruby word pattern stops at `@`/`$`, but spinel stamps an ivar or
// gvar node at its sigil, so the word a hover resolves to takes the sigils
// in front of it: `@x` is one word starting at `@`.
export function sigilWord(model, position) {
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const line = model.getLineContent(position.lineNumber);
  let start = word.startColumn;
  while (start > 1 && /[@$]/.test(line[start - 2])) start--;
  return { word: line.slice(start - 1, word.endColumn - 1), startColumn: start, endColumn: word.endColumn };
}

export async function createEditor(container, { onChange }) {
  try {
    const monaco = await loadMonaco();
    const ed = monaco.editor.create(container, {
      value: "", language: "ruby", automaticLayout: true,
      minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, tabSize: 2,
    });
    let suppress = false;
    ed.onDidChangeModelContent(() => { if (!suppress) onChange(ed.getValue()); });

    let hoverTypes = [];
    let hoverCodegen = [];
    let decorations = ed.createDecorationsCollection([]);
    monaco.languages.registerHoverProvider(["ruby"], {
      provideHover(model, position) {
        const h = hoverAt(hoverTypes, hoverCodegen, position.lineNumber, position.column);
        if (h) {
          const t = h.tight;
          return {
            range: new monaco.Range(t.line, t.col + 1, t.end_line, t.end_col + 1),
            contents: hoverMarkdown(h),
          };
        }
        // A dump without spans (an older spinel): the word heuristic.
        const word = sigilWord(model, position);
        const rbs = typesAtWord(hoverTypes, position.lineNumber, word);
        if (!rbs.length) return null;
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: "inferred type" }, { value: rbs.map((r) => "`" + r + "`").join("  ·  ") }],
        };
      },
    });

    return {
      kind: "monaco",
      setTypes(types) { hoverTypes = types; },
      // The codegen lens: every call that did not take the direct path is
      // underlined, boxed sends heavier than switches.
      setCodegen(codegen) {
        hoverCodegen = codegen || [];
        decorations.set(hoverCodegen
          .filter((d) => d.kind === "CallNode" && d.dispatch !== "direct" && d.end_line != null)
          .map((d) => ({
            range: new monaco.Range(d.line, d.col + 1, d.end_line, d.end_col + 1),
            options: { inlineClassName: d.dispatch === "boxed" ? "sp-boxed" : "sp-switch" },
          })));
      },
      getValue: () => ed.getValue(),
      setValue(text) {
        suppress = true;
        const prev = ed.getModel();
        ed.setModel(monaco.editor.createModel(text, "ruby"));
        if (prev) prev.dispose();
        suppress = false;
      },
      // spinel diagnostics: {line 1-based, col 0-based, severity, message},
      // with end_line/end_col since #4522 (a widening sits on its slot: the
      // parameter, or the def for a return). Without an end, a warning
      // marks the word at its position and a refusal the rest of its line.
      setMarkers(diags) {
        const model = ed.getModel();
        const markers = diags.map((d) => {
          const line = Math.max(1, Math.min(d.line || 1, model.getLineCount()));
          const startColumn = Math.max(1, (d.col || 0) + 1);
          let endLine = line, endColumn;
          if (d.end_line != null && d.end_col != null) {
            endLine = Math.max(line, Math.min(d.end_line, model.getLineCount()));
            endColumn = Math.max(startColumn + (endLine === line ? 1 : 0), d.end_col + 1);
          } else {
            const word = d.severity !== "error" ? model.getWordAtPosition({ lineNumber: line, column: startColumn }) : null;
            endColumn = word ? word.endColumn : Math.max(startColumn + 1, model.getLineMaxColumn(line));
          }
          return {
            startLineNumber: line, startColumn,
            endLineNumber: endLine, endColumn,
            message: d.message,
            severity: d.severity === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          };
        });
        monaco.editor.setModelMarkers(model, "spinel", markers);
      },
      focus: () => ed.focus(),
    };
  } catch (err) {
    console.warn("[spinel-ide] Monaco unavailable, using textarea fallback:", err.message);
    const ta = document.createElement("textarea");
    ta.spellcheck = false;
    container.appendChild(ta);
    ta.addEventListener("input", () => onChange(ta.value));
    return {
      kind: "textarea",
      getValue: () => ta.value,
      setValue(text) { ta.value = text; },
      setMarkers() {},
      setTypes() {},
      setCodegen() {},
      focus: () => ta.focus(),
    };
  }
}

// Read-only pane with syntax highlighting (a second Monaco), <pre> fallback.
export async function createOutputView(container) {
  try {
    const monaco = await loadMonaco();
    const ed = monaco.editor.create(container, {
      value: "", language: "plaintext", readOnly: true, domReadOnly: true,
      automaticLayout: true, minimap: { enabled: false }, fontSize: 12.5,
      scrollBeyondLastLine: false, tabSize: 2, wordWrap: "off",
    });
    return {
      kind: "monaco",
      setValue(text, lang) {
        const prev = ed.getModel();
        ed.setModel(monaco.editor.createModel(text, lang || "plaintext"));
        if (prev) prev.dispose();
      },
    };
  } catch {
    const pre = document.createElement("pre");
    container.appendChild(pre);
    return { kind: "pre", setValue(text) { pre.textContent = text; } };
  }
}
