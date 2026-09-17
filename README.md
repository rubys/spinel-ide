# spinel-ide

[Spinel](https://github.com/matz/spinel)'s whole-program type inference at a
cursor, in the browser: **https://rubys.github.io/spinel-ide/**

Hover a name for the type spinel inferred; markers show what it refuses to
compile and what widened to `untyped` (the boxed slow path); tabs show the
RBS it settled on and the C it emits; **Run** executes the program. A
sample runs from its precompiled `wasm32-wasi` build; an edited program is
compiled in the tab — clang and wasm-ld as wasm
([@yowasp/clang](https://www.npmjs.com/package/@yowasp/clang), LLVM 22)
over the C the analysis just emitted, against the runtime archive spinel's
own `make wasm-rt` built — and run the same way, in about a second after a
one-time ~27 MB (compressed) toolchain fetch. Everything is client-side:
the compiler is `spinel.wasm`, the same C sources as the native compiler
built by the wasi-sdk, and a program's analysis is the compiler's own
`--emit-types`, `--emit-rbs` and `-S` output.

This is the out-of-tree consumer of the compiler's output that
[matz/spinel#4509](https://github.com/matz/spinel/issues/4509) decided
belongs outside the compiler's tree, as roundhouse's
[`/ide/`](https://rubys.github.io/roundhouse/ide/) is for its analyzer. It
does not modify spinel; it builds it.

## spinel-mcp and spinel-lsp

Two more consumers of the same output, in [`tools/`](tools/): the
compiler's answers for an agent (MCP) and for an editor (LSP). Both are
written in the spinel subset and shared through
[`tools/spinel_query.rb`](tools/spinel_query.rb), which runs `spinel` on a
program and answers the type at a position, the diagnostics, the inferred
signatures and the C a method compiled to. They run either way:

```sh
ruby tools/spinel-mcp.rb [root]      # CRuby, no compile step
spinel tools/spinel-mcp.rb -o spinel-mcp && ./spinel-mcp [root]   # a static binary
```

The daily build compiles both with the fresh spinel, runs one scripted
session per protocol against the CRuby form and the binary, and requires
the answers to agree (`scripts/tools-smoke.mjs`); the binaries it built
(Linux x86-64) are published with the site at `tools/spinel-mcp` and
`tools/spinel-lsp`. The compiler they run is `$SPINEL`, else `spinel` on
PATH.

**spinel-mcp** — stdio, stateless; tools `diagnostics`, `wont_compile`,
`type_at`, `signatures`, `c_for`, `version`. For Claude Code:

```json
{ "mcpServers": { "spinel": { "command": "ruby", "args": ["/path/to/spinel-ide/tools/spinel-mcp.rb", "."] } } }
```

**spinel-lsp** — read-only: diagnostics (refusals as errors, widenings as
warnings), hover (the inferred type), inlay hints (the inferred signature
after each `def`), code lenses (fast path / slow path per `def`). A buffer
is analyzed by writing it beside its file so `require_relative` resolves.
Analysis is synchronous in this MVP, which is right for programs spinel
compiles in tens of milliseconds and wrong for a whole application.
`SPINEL_LSP_LOG=<path>` traces every message, which is what to attach to
a report.

Editor setup:

- **VS Code**: [`editors/vscode/`](editors/vscode/) is a thin client
  (verified on VS Code 1.136). Run it from source —
  `cd editors/vscode && npm install`, then
  `code --extensionDevelopmentPath=/path/to/spinel-ide/editors/vscode` —
  or package it with `npx @vscode/vsce package` and install the `.vsix`.
  Settings: `spinel.lsp.command` (default: this checkout's
  `tools/spinel-lsp.rb` under `ruby`) and `spinel.compiler` (the spinel
  binary; default: `spinel` on PATH).
- **Neovim** (0.10+), in `init.lua`:
  ```lua
  vim.api.nvim_create_autocmd("FileType", { pattern = "ruby", callback = function()
    vim.lsp.start({ name = "spinel", cmd = { "ruby", "/path/to/spinel-ide/tools/spinel-lsp.rb" } })
  end })
  ```
- **Helix**, in `languages.toml`:
  ```toml
  [language-server.spinel]
  command = "ruby"
  args = ["/path/to/spinel-ide/tools/spinel-lsp.rb"]
  [[language]]
  name = "ruby"
  language-servers = ["spinel"]
  ```
  (The Neovim and Helix snippets are the standard forms; only the VS Code
  client has been exercised so far — a report from either is welcome.)

Both tools are bounded by what `--emit-types` says; the section below is
the list.

## What the compiler doesn't say yet

Every consumer here — the page, the LSP, the MCP — answers from the JSON
`--emit-types` writes, and all of them hit the same four limits of it.
This is the list [matz/spinel#4522](https://github.com/matz/spinel/issues/4522)
asks about; it will shrink as fields land.

1. **No end position.** A node has a start line and column, no end. On
   `puts pts.map { |p| p.dist2(pts[0]) }.inspect` three nodes start at
   `pts` — the local read, the `map` call, the `inspect` call — so a hover
   there shows `Array[untyped] · Array[Integer] · String` and cannot say
   which is which. With spans, a hover shows the type of exactly the
   expression under the cursor.
2. **No node kind or name.** An entry is a position and a type, so nothing
   here can tell an identifier from a literal or find the other uses of
   `pts`. Go-to-definition, references and rename all wait on this.
3. **A widening names the method, not the slot.** *"`dist2` has a
   parameter or return widened to untyped"* is stamped at the `def`; the
   marker sits there, and the user reads the RBS to work out that it was
   `o`. With the slot and its position, the marker lands on `o`.
4. **Codegen's decisions are invisible.** Whether a call became a direct C
   call, a switch over the receiver's classes or a boxed send, and whether
   a block was inlined, is knowable only from the emitted C, which nobody
   reads. Per-node `dispatch`/`inlined` fields would give an editor the
   performance lens no other Ruby tool can have.

Not on this list, because no dump can provide it until the analyzer
records it: *why* a slot widened — matz's own design, per #4509.

## Reporting what you see

Reports go to [this repository's issues](https://github.com/rubys/spinel-ide/issues);
the compiler-side conversation is on matz/spinel and is linked under
Status below. A useful report has:

- the program (paste it — the page's URL carries the sample name, not an
  edit), or the sample name if unedited;
- where you hovered or what you pressed, what you got, and what you
  expected;
- the spinel commit, from the page's footer or
  [`version.json`](https://rubys.github.io/spinel-ide/version.json), or
  `spinel --version` for the tools;
- for the LSP, the editor and the `SPINEL_LSP_LOG` trace.

"I expected the type of the whole expression and got three candidates" is
exactly the kind of report that turns into a field in `--emit-types`.

## Status with the compiler

- [matz/spinel#4509](https://github.com/matz/spinel/issues/4509) — the
  RFC this repository answers: matz declined an in-tree IDE, LSP and MCP
  ("anyone is free to build any of them out of tree over what the
  compiler emits"), built `--target=wasm32-wasi` within a day, and made
  every refusal report in one run and appear in `--emit-types`.
- [matz/spinel#4519](https://github.com/matz/spinel/issues/4519) — the
  wasm link on a macOS host; fixed.
- [matz/spinel#4522](https://github.com/matz/spinel/issues/4522) — the
  request for the four fields above.

## It tracks spinel master

A [scheduled workflow](.github/workflows/build.yml) runs daily:

1. resolves `matz/spinel` master and stops if the live site is already at
   that commit;
2. clones it, builds the native compiler (`make deps && make`) and its
   wasm32-wasi runtime (`make wasm-rt`), then builds the *compiler itself*
   as wasm ([`scripts/build-spinel-wasm.sh`](scripts/build-spinel-wasm.sh))
   and each sample program for wasm32-wasi
   ([`scripts/build-site.sh`](scripts/build-site.sh));
3. gates the result: [`scripts/smoke.mjs`](scripts/smoke.mjs) (Node)
   checks that `spinel.wasm` emits C byte-identical to the native compiler's
   `--target=wasm32-wasi -S`, that `--emit-types` types every sample and
   carries the refusal sample's refusal as an error and the widening
   sample's widening as a warning, that every precompiled sample runs
   with stdout identical to the native binary's, and that the in-tab
   toolchain builds and runs an edited program and one that requires a
   bundled package; [`scripts/verify-ide.mjs`](scripts/verify-ide.mjs)
   (Playwright) loads the page, hovers a name, checks the markers, presses
   Run on a sample, then edits it and presses Build & run;
4. deploys to Pages only if both pass. A failed gate leaves the last good
   deployment up and opens (or updates) one `tracking-failure` issue here
   naming the spinel commit; the next green deploy closes it.

The footer of the page names the spinel commit it was built from.

## Layout

| Path | Role |
|---|---|
| `site/ide/` | the page (`index.html`, `ide.js`) |
| `site/lib/spinel-runner.mjs` | runs a WASI command module against an in-memory filesystem; `analyze()` is the three spinel passes |
| `site/lib/clang-runner.mjs` | compiles emitted C to a wasm32-wasi module with the @yowasp/clang toolchain over `rt.tar` (runtime headers, `libspinel_rt.a`, the packages' wasi objects) |
| `site/lib/worker.mjs`, `clang-worker.mjs`, `wasm-client.mjs` | the analyzer worker, the toolchain worker (spawned on the first Build & run), and their watchdog client (from roundhouse) |
| `site/lib/editor.js` | Monaco via CDN with a textarea fallback; the hover resolves spinel's start-keyed types to the word under the cursor |
| `site/lib/wasi/` | vendored [@bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) 0.4.2 (MIT/Apache-2.0) |
| `samples/` | the hand-written samples and the manifest; benchmark entries point into the spinel checkout |
| `tools/` | `spinel_query.rb` (the query core), `spinel-mcp.rb`, `spinel-lsp.rb` — subset Ruby, run by CRuby or compiled by spinel |
| `editors/vscode/` | a thin VS Code client for `spinel-lsp` |
| `scripts/` | the build and the three gates (`smoke.mjs`, `verify-ide.mjs`, `tools-smoke.mjs`) |

Built, not committed: `lib/spinel.wasm`, `lib/clang/` (the toolchain, from
the npm tarball pinned in `scripts/build-site.sh`), `lib/rt.tar`,
`lib/pkg.tar`, `samples/*.wasm`, `samples/*.out`, `version.json`.

## Running locally

```sh
git clone https://github.com/matz/spinel && (cd spinel && make deps && make && make wasm-rt)
export WASI_SDK=/opt/wasi-sdk        # wasi-sdk 34 or later
scripts/build-site.sh spinel _site
node scripts/smoke.mjs _site spinel
(cd _site && python3 -m http.server 8099) &
npm i playwright && npx playwright install chromium
node scripts/verify-ide.mjs http://localhost:8099
open http://localhost:8099/ide/
```

## What it does not do yet

- Completion, go-to-definition, rename, `why` a slot widened: see "What
  the compiler doesn't say yet" above.
- Programs larger than a benchmark: a whole-app compile belongs in the
  native compiler, not a tab.
- `Fiber`, `Thread`, sockets, processes: what the wasm32-wasi target does
  without ([docs/wasm.md](https://github.com/matz/spinel/blob/master/docs/wasm.md)).
- A package with carried C that needs a system library (`openssl`) does
  not link in the tab; the six bundled packages with wasi objects do.
