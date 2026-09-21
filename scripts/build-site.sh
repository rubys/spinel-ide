#!/usr/bin/env bash
# Assemble the publishable site into an output directory:
#
#   scripts/build-site.sh <spinel checkout> <out dir>
#
# - site/ (the page and its lib) copied as is
# - lib/spinel.wasm: the compiler, built by build-spinel-wasm.sh
# - samples/: each manifest entry's .rb (from samples/ or the spinel
#   checkout's `from` path), its native stdout as <name>.out (the oracle the
#   smoke gate and the Run button are checked against), and its
#   --target=wasm32-wasi build as <name>.wasm unless the entry is `norun`
#   (a sample that is refused on purpose has nothing to run)
# - lib/clang/: the @yowasp/clang toolchain (clang + wasm-ld + wasi sysroot
#   as wasm, ~105 MB) that Build & run uses for an edited program, from the
#   npm tarball at the version pinned below (YOWASP_CLANG_VERSION overrides)
# - lib/rt.tar: what that toolchain needs from the checkout: the runtime
#   headers, lib/wasi/, lib/wasm32-wasi/libspinel_rt.a and the bundled
#   packages' sp_*_wasi.o
# - lib/pkg.tar: the Ruby sources the compiler reads beside its lib/: the
#   bundled packages' (the analyzer's `require`) and builtins/ (Enumerable
#   in Ruby, spliced into every program that calls one; matz/spinel
#   1a492ebb)
# - version.json: the spinel commit, toolchain and build time the page shows
#
# Needs: the checkout built (`make deps && make && make wasm-rt`) and the
# wasi-sdk. Native compiles here are what `spinel -E` does; on the CI runner
# that is gcc.
set -euo pipefail

SPINEL=$(cd "${1:?spinel checkout}" && pwd)
OUT=${2:?out dir}
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT";; esac
HERE=$(cd "$(dirname "$0")/.." && pwd)
YOWASP_CLANG_VERSION=${YOWASP_CLANG_VERSION:-22.0.0-git20542-10}

rm -rf "$OUT"
mkdir -p "$OUT/samples" "$OUT/lib"
cp -R "$HERE/site/." "$OUT/"
"$HERE/scripts/build-spinel-wasm.sh" "$SPINEL" "$OUT/lib/spinel.wasm"

SP="$SPINEL/spinel"
[ -x "$SP" ] || { echo "no compiler at $SP (run make in the checkout)" >&2; exit 1; }
[ -f "$SPINEL/lib/wasm32-wasi/libspinel_rt.a" ] || { echo "run 'make wasm-rt' in $SPINEL first" >&2; exit 1; }

# The manifest the page reads: `file` resolved to a name under samples/,
# `wasm` set for the entries that have a build. Written with node so the
# JSON edit is not a sed over JSON.
node - "$HERE/samples/manifest.json" "$SPINEL" "$OUT/samples" "$SP" <<'EOF'
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const [manifest, spinel, out, sp] = process.argv.slice(2);
const entries = JSON.parse(fs.readFileSync(manifest, "utf8"));
const published = [];
const tmp = fs.mkdtempSync(path.join(require("os").tmpdir(), "spinel-ide-"));
for (const e of entries) {
  const src = e.from ? path.join(spinel, e.from) : path.join(path.dirname(manifest), e.file);
  const rb = `${e.name}.rb`;
  fs.copyFileSync(src, path.join(out, rb));
  const pub = { name: e.name, label: e.label, file: rb };
  if (e.argv) pub.argv = e.argv;
  if (!e.norun) {
    // Native build + run -> the expected output.
    const bin = path.join(tmp, e.name);
    execFileSync(sp, [path.join(out, rb), "-o", bin], { stdio: ["ignore", "inherit", "inherit"] });
    const stdout = execFileSync(bin, e.argv || [], { encoding: "utf8", maxBuffer: 64 << 20 });
    fs.writeFileSync(path.join(out, `${e.name}.out`), stdout);
    // The same program for wasm32-wasi.
    execFileSync(sp, ["--target=wasm32-wasi", path.join(out, rb), "-o", path.join(out, `${e.name}.wasm`)],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env } });
    pub.wasm = `${e.name}.wasm`;
  }
  published.push(pub);
  console.log(`sample ${e.name}${pub.wasm ? " (native + wasm)" : " (source only)"}`);
}
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(published, null, 2) + "\n");
fs.rmSync(tmp, { recursive: true, force: true });
EOF

# The in-tab toolchain. YOWASP_CLANG_TGZ names a local tarball (a cache);
# otherwise it is fetched from the npm registry.
mkdir -p "$OUT/lib/clang"
tgz=${YOWASP_CLANG_TGZ:-}
if [ -z "$tgz" ]; then
  tgz=$(mktemp -t yowasp-clang.XXXXXX)
  curl -sSL -o "$tgz" "https://registry.npmjs.org/@yowasp/clang/-/clang-$YOWASP_CLANG_VERSION.tgz"
fi
tar xzf "$tgz" -C "$OUT/lib/clang" --strip-components=2 package/gen
[ -f "$OUT/lib/clang/bundle.js" ] || { echo "toolchain tarball had no gen/bundle.js" >&2; exit 1; }
echo "toolchain @yowasp/clang $YOWASP_CLANG_VERSION ($(du -sh "$OUT/lib/clang" | cut -f1))"

# What the toolchain needs from the checkout, as one ustar archive.
(cd "$SPINEL" && find lib -name '*.h' -not -path 'lib/wasm32-wasi/*' ; find lib/wasi -type f; echo lib/wasm32-wasi/libspinel_rt.a; ls packages/*/sp_*_wasi.o) \
  | sort -u | (cd "$SPINEL" && tar --format=ustar -cf "$OUT/lib/rt.tar" -T -)
echo "rt.tar: $(tar tf "$OUT/lib/rt.tar" | wc -l | tr -d ' ') files ($(du -sh "$OUT/lib/rt.tar" | cut -f1))"
# The Ruby sources the compiler reads beside its lib/: `require "json"`
# resolves to packages/json/json.rb, and builtins/enumerable.rb is spliced
# ahead of a program that calls an Enumerable method (a compiler that
# cannot find it exits 1).
(cd "$SPINEL" && find packages -name '*.rb' -not -path '*/test/*'; ls packages/*/spin.toml; find builtins -name '*.rb') \
  | sort -u | (cd "$SPINEL" && tar --format=ustar -cf "$OUT/lib/pkg.tar" -T -)
echo "pkg.tar: $(tar tf "$OUT/lib/pkg.tar" | wc -l | tr -d ' ') files ($(du -sh "$OUT/lib/pkg.tar" | cut -f1))"

SHA=$(git -C "$SPINEL" rev-parse HEAD)
VERSION=$("$SP" --version)
printf '{ "spinel_sha": "%s", "spinel_version": "%s", "toolchain": "@yowasp/clang %s", "built_at": "%s" }\n' \
  "$SHA" "$VERSION" "$YOWASP_CLANG_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/version.json"
echo "site at $OUT: $VERSION ($SHA)"
