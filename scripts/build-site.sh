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
# - version.json: the spinel commit and build time the page shows
#
# Needs: the checkout built (`make deps && make && make wasm-rt`) and the
# wasi-sdk. Native compiles here are what `spinel -E` does; on the CI runner
# that is gcc.
set -euo pipefail

SPINEL=$(cd "${1:?spinel checkout}" && pwd)
OUT=${2:?out dir}
HERE=$(cd "$(dirname "$0")/.." && pwd)

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

SHA=$(git -C "$SPINEL" rev-parse HEAD)
VERSION=$("$SP" --version)
printf '{ "spinel_sha": "%s", "spinel_version": "%s", "built_at": "%s" }\n' \
  "$SHA" "$VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$OUT/version.json"
echo "site at $OUT: $VERSION ($SHA)"
