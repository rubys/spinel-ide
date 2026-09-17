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

// Pick the type(s) to show at a cursor from spinel's start-keyed entries.
// `types`: [{line (1-based), col (0-based), rbs}]. `word`: {startColumn,
// endColumn} 1-based from Monaco. Entries starting inside the word qualify;
// the innermost is the last one emitted at the greatest column. Exported so
// the smoke gate can test it without a DOM.
export function typesAtWord(types, lineNumber, word) {
  if (!word) return [];
  const startCol0 = word.startColumn - 1, endCol0 = word.endColumn - 1;
  const hits = types.filter((t) => t.line === lineNumber && t.col >= startCol0 && t.col < endCol0);
  if (!hits.length) return [];
  const maxCol = Math.max(...hits.map((t) => t.col));
  const at = hits.filter((t) => t.col === maxCol);
  // Distinct renderings, innermost first.
  const seen = new Set(); const out = [];
  for (const t of at.slice().reverse()) { if (!seen.has(t.rbs)) { seen.add(t.rbs); out.push(t.rbs); } }
  return out;
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
    monaco.languages.registerHoverProvider(["ruby"], {
      provideHover(model, position) {
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
      getValue: () => ed.getValue(),
      setValue(text) {
        suppress = true;
        const prev = ed.getModel();
        ed.setModel(monaco.editor.createModel(text, "ruby"));
        if (prev) prev.dispose();
        suppress = false;
      },
      // spinel diagnostics: {line 1-based, col 0-based, severity, message}. A
      // refusal is stamped at its statement; a widening at the def. Neither
      // carries an end. A warning at a def marks the `def` word only, so a
      // hover elsewhere on that line shows the inferred type rather than
      // the marker; a refusal marks the rest of its line.
      setMarkers(diags) {
        const model = ed.getModel();
        const markers = diags.map((d) => {
          const line = Math.max(1, Math.min(d.line || 1, model.getLineCount()));
          const startColumn = Math.max(1, (d.col || 0) + 1);
          const word = d.severity !== "error" ? model.getWordAtPosition({ lineNumber: line, column: startColumn }) : null;
          const endColumn = word ? word.endColumn : Math.max(startColumn + 1, model.getLineMaxColumn(line));
          return {
            startLineNumber: line, startColumn,
            endLineNumber: line, endColumn,
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
