// Drive the built page in headless Chromium and assert the demo beats:
// the compiler loads in the worker, a sample analyzes, a hover shows an
// inferred type, the refusal sample shows an error marker, the widening
// sample a warning, and Run prints the native oracle's output.
//
//   node scripts/verify-ide.mjs <site url>       (e.g. http://localhost:8099)
//
// Needs `playwright` resolvable (CI: `npm i playwright` + chromium). Set
// PLAYWRIGHT_MODULE to an absolute path to use another install.
import { readFile } from "node:fs/promises";

const base = process.argv[2] || "http://localhost:8099";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");

let failures = 0;
const ok = (m) => console.log(`  ok  ${m}`);
const fail = (m) => { failures++; console.log(`FAIL  ${m}`); };
const check = (c, m) => (c ? ok(m) : fail(m));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const consoleErrors = [];
// Monaco rejects its own pending hover/tokenization promises with
// "Canceled" when the model is swapped under them (a sample switch); that
// is its cancellation token, not a page error.
const benign = (t) => /Canceled/.test(t);
page.on("pageerror", (e) => { if (!benign(String(e))) consoleErrors.push(String(e)); });
page.on("console", (m) => { if (m.type() === "error" && !benign(m.text())) consoleErrors.push(m.text()); });

// The analysis carries the sample it was made for, so opening a sample and
// waiting for its own result cannot be satisfied by the previous one.
const waitAnalyzed = async (name, ms = 120000) => {
  await page.waitForFunction((n) => window.__ide?.analysis()?.sample === n, name, { timeout: ms });
  return page.evaluate(() => window.__ide.analysis());
};

await page.goto(`${base}/ide/#point`);
const a = await waitAnalyzed("point");
check(a.types.length > 0, `point analyzed: ${a.types.length} typed nodes in ${a.elapsed_ms} ms`);
check(/@x: Integer/.test(a.rbs), "point: signatures pane has @x: Integer");
const editorKind = await page.evaluate(() => window.__ide.editorKind());
ok(`editor: ${editorKind}`);

// Hover: put the mouse on `@x` inside dist2 and expect Monaco's hover widget
// to show the inferred type. Only Monaco renders hovers; the textarea
// fallback (CDN unreachable) skips this beat rather than failing it.
if (editorKind === "monaco") {
  const src = await (await fetch(`${base}/samples/point.rb`)).text();
  const lineNo = src.split("\n").findIndex((l) => /def dist2/.test(l)) + 1;
  const col = src.split("\n")[lineNo - 1].indexOf("@x") + 2;
  // A real mouse hover over the token: Monaco maps the pointer to a model
  // position and asks every hover provider, ours included.
  const pt = await page.evaluate(([l, c]) => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.revealLineInCenter(l);
    const p = ed.getScrolledVisiblePosition({ lineNumber: l, column: c });
    const r = ed.getDomNode().getBoundingClientRect();
    return { x: r.left + p.left + 3, y: r.top + p.top + p.height / 2 };
  }, [lineNo, col]);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.move(pt.x + 1, pt.y);
  try {
    await page.waitForSelector(".monaco-hover:not(.hidden)", { state: "visible", timeout: 10000 });
    const text = await page.locator(".monaco-hover:not(.hidden)").first().innerText();
    check(/Integer/.test(text), `hover on @x shows: ${text.replace(/\s+/g, " ").trim().slice(0, 80)}`);
  } catch (e) {
    fail(`hover widget did not appear: ${e.message}`);
  }
}

// Refusal -> error marker; widening -> warning marker.
await page.evaluate(() => window.__ide.open("refusal"));
const r = await waitAnalyzed("refusal");
check(r.diagnostics.some((d) => d.severity === "error"), `refusal: ${r.diagnostics.filter((d) => d.severity === "error").length} error diagnostic(s)`);
if (editorKind === "monaco") {
  const markers = await page.evaluate(() => window.monaco.editor.getModelMarkers({ owner: "spinel" }).map((m) => m.severity));
  check(markers.includes(8), `refusal: an error marker is set (${markers.length} markers)`);
}
await page.evaluate(() => window.__ide.open("widening"));
const w = await waitAnalyzed("widening");
check(w.diagnostics.some((d) => d.severity === "warning"), `widening: ${w.diagnostics.length} warning(s)`);

// Run: the precompiled sample prints the oracle.
await page.evaluate(() => window.__ide.open("binary_trees"));
await waitAnalyzed("binary_trees");
await page.click("#btnRun");
await page.waitForFunction(() => /\[exit \d+/.test(document.getElementById("outputText").textContent), null, { timeout: 60000 });
const out = await page.locator("#outputText").innerText();
const expected = await (await fetch(`${base}/samples/binary_trees.out`)).text();
check(out.startsWith(expected) && /\[exit 0/.test(out), `Run binary_trees: ${out.replace(/\s+/g, " ").trim().slice(0, 80)}`);

// An edit disables Run (nothing to compile it with here) and re-analyzes.
await page.evaluate(() => {
  const ed = window.monaco?.editor.getEditors()[0];
  if (ed) ed.executeEdits("test", [{ range: new window.monaco.Range(1, 1, 1, 1), text: "# edited\n" }]);
});
if (editorKind === "monaco") {
  await page.waitForFunction(() => document.getElementById("btnRun").disabled, null, { timeout: 5000 });
  ok("Run disabled after an edit");
}

check(consoleErrors.length === 0, `no page errors${consoleErrors.length ? ": " + consoleErrors.slice(0, 3).join(" | ") : ""}`);
await page.screenshot({ path: process.env.SCREENSHOT || "ide.png" });
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
