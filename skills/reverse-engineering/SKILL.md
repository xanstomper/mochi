---
name: reverse-engineering
description: Reverse-engineering workflow — binary disassembly output parsing (objdump/ghidra), network packet inspection, protocol tracing, and symbol recovery. Use when analyzing binaries, firmware, or packet captures.
tools: [read, glob, search, shell]
---

# Reverse Engineering Skill

## Preparation
- Identify the artifact type (ELF/PE/Mach-O, firmware, capture file). For binaries first run `file` and `readelf -h`/`file -p`, then decide: static (`objdump -d`, ghidra, `radare2`) or dynamic (`gdb`, `ltrace`/`strace`, `strings`).
- If a network capture, note the PCAP/PCAPNG and the flows of interest; use `tshark`/Wireshark filters rather than dumping everything.

## Static analysis
- `objdump -d` or `objdump -d -M intel` for disassembly; correlate with symbol tables when not stripped.
- When stripped, use string references (`strings -n 8`), call targets, and imported/exported tables to reconstruct intent.
- Read `readelf --syms`/`--dyn-syms` to locate PLT/GOT entries for API calls.

## Dynamic / tracing
- `strace` syscall traces reveal file/network behavior; `ltrace` reveals library calls.
- Breakpoints at interesting symbols; note registers/stack for arguments (SysV AMD64 ABI: RDI, RSI, RDX, RCX, R8, R9).

## Output
- Produce concise findings: artifact properties (arch, endianness, main symbols), observed behavior, and a hypothesis of purpose — cite concrete offsets/instructions as evidence. Never guess without pointing at the specific bytes.