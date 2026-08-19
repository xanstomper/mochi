# Mochi native accelerators

Small, dependency-free native programs that speed up the parts of the agent
that are pure hot loops. Each one is a single self-contained file with no
crates, no vcpkg, no node-gyp: it reads a framed request on stdin and writes
a one-line result on stdout. The TS layer (`src/tools/native-match.ts`)
prefers the native binary and transparently falls back to the TypeScript
implementation when the binary is absent.

Build both with:

    npm run build:native

Layout:
- `rust/fuzzy.rs`            Rust fuzzy line matcher (used by edit tool)
- `cpp/fuzzy.cpp`            identical matcher in C++ (0.17.6 uses this when
                             `MOCHI_NATIVE_FUZZY` is unset and nothing else exists)
- `bin/fuzzy_rust`           compiled Rust binary (cargo build/package)
- `bin/fuzzy_cpp`            compiled C++ binary (g++ -O2)
