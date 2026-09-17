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
after each `def`), code lenses (fast path / slow path per `def`). Any
LSP-capable editor points at it; a buffer is analyzed by writing it beside
its file so `require_relative` resolves. Analysis is synchronous in this
MVP, which is right for programs spinel compiles in tens of milliseconds
and wrong for a whole application.

Both are bounded by what `--emit-types` says: a start position per node,
no end, no node kind, and a widening reported at its `def` rather than at
the slot. That is the gap they exist to demonstrate.

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

- Completion, go-to-definition, rename, `why` a slot widened: the compiler
  does not answer those yet (`why` is matz's to design, per #4509; the
  others need node kinds, spans and resolved callees in `--emit-types`).
- Programs larger than a benchmark: a whole-app compile belongs in the
  native compiler, not a tab.
- `Fiber`, `Thread`, sockets, processes: what the wasm32-wasi target does
  without ([docs/wasm.md](https://github.com/matz/spinel/blob/master/docs/wasm.md)).
- A package with carried C that needs a system library (`openssl`) does
  not link in the tab; the six bundled packages with wasi objects do.
