#!/usr/bin/env bash
# Build the spinel COMPILER as a wasm32-wasi command module.
#
#   scripts/build-spinel-wasm.sh <spinel checkout> <output .wasm>
#
# Needs: the wasi-sdk (WASI_SDK, or WASI_SDK_PATH, else /opt/wasi-sdk) and a
# spinel checkout that has had `make deps` (vendor/prism) and `make` (the
# derived headers build/csrc/spinel_rev.h and sp_rt_names.h). spinel's own
# Makefile builds the *runtime* for wasm (`make wasm-rt`); the compiler is
# not a target upstream, so this script compiles src/ + prism + the regexp
# engine with the same flags the Makefile's WASI_CFLAGS use, against
# spinel's lib/wasi shim. The two additions the compiler needs beyond the
# shim: `-Wno-implicit-function-declaration` (recent clang rejects the
# handful of declared-after-use functions in src/) and a `system()` stub
# (main.c's invoke-cc path; the shim covers popen but not system).
set -euo pipefail

SPINEL=${1:?spinel checkout}
OUT=${2:?output .wasm}
WASI_SDK=${WASI_SDK:-${WASI_SDK_PATH:-/opt/wasi-sdk}}
CLANG="$WASI_SDK/bin/clang"
[ -x "$CLANG" ] || { echo "no wasi-sdk clang at $CLANG (set WASI_SDK)" >&2; exit 1; }
[ -f "$SPINEL/vendor/prism/include/prism.h" ] || { echo "run 'make deps' in $SPINEL first" >&2; exit 1; }
[ -f "$SPINEL/build/csrc/sp_rt_names.h" ] || { echo "run 'make' in $SPINEL first (derived headers)" >&2; exit 1; }

OBJ=$(mktemp -d)
trap 'rm -rf "$OBJ"' EXIT

CF=(-O2 -std=gnu11 -w -Wno-implicit-function-declaration
    -I"$SPINEL/lib/wasi"
    -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN
    -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false)

cd "$SPINEL"
for f in src/*.c; do
  case "$f" in src/spinel_parse.c) continue;; esac
  "$CLANG" "${CF[@]}" -Ivendor/prism/include -Ibuild/csrc -Isrc -Ilib -Ilib/regexp -c "$f" -o "$OBJ/$(basename "$f" .c).o"
done
"$CLANG" "${CF[@]}" -Ivendor/prism/include -c src/spinel_parse.c -o "$OBJ/sp_parse_lib.o"
for f in vendor/prism/src/*.c vendor/prism/src/util/*.c; do
  "$CLANG" "${CF[@]}" -Ivendor/prism/include -Ivendor/prism/src -c "$f" -o "$OBJ/prism_$(basename "$f" .c).o"
done
for f in lib/regexp/*.c; do
  "$CLANG" "${CF[@]}" -Ilib/regexp -c "$f" -o "$OBJ/re_$(basename "$f" .c).o"
done
"$CLANG" "${CF[@]}" -c lib/wasi/sp_wasi.c -o "$OBJ/sp_wasi.o"
printf '#include <errno.h>\nint system(const char *c) { (void)c; errno = ENOSYS; return -1; }\n' > "$OBJ/system_stub.c"
"$CLANG" -O2 -c "$OBJ/system_stub.c" -o "$OBJ/system_stub.o"

# 16 MB stack: the parser's AST flattening is recursive and the 64 KB
# default overflows on ordinary programs.
"$CLANG" -O2 -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false \
  -Wl,-z,stack-size=16777216 \
  -lsetjmp -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman \
  "$OBJ"/*.o -lm -o "$OUT"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
