#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Turn `llvm-dwarfdump-18 --debug-line <elf>` output into lines.json.

Usage: uv run lines.py <main.elf> <out.json>

Writes a JSON array of {"addr": int, "line": int, "file": "<basename>"},
one entry per debug-line-table row where is_stmt is set and the row is not
an end_sequence marker, restricted to rows whose file is main.c or
llmcpu.h (start.S carries no debug info, so its rows never appear), sorted
by addr and deduplicated on addr (first occurrence wins).
"""

import json
import re
import subprocess
import sys
from pathlib import Path

FILE_ENTRY_RE = re.compile(r"^file_names\[\s*(\d+)\]:$")
NAME_RE = re.compile(r'^\s*name:\s*"([^"]*)"$')
TABLE_HEADER_RE = re.compile(
    r"^Address\s+Line\s+Column\s+File\s+ISA\s+Discriminator\s+OpIndex\s+Flags$"
)
WANTED_BASENAMES = {"main.c", "llmcpu.h"}


def run_dwarfdump(elf_path: Path) -> str:
    result = subprocess.run(
        ["llvm-dwarfdump-18", "--debug-line", str(elf_path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def parse_debug_line(output: str) -> list[dict]:
    lines = output.splitlines()
    entries: list[dict] = []

    file_names: dict[int, str] = {}
    in_table = False
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]

        file_entry_match = FILE_ENTRY_RE.match(line.strip())
        if file_entry_match is not None:
            index = int(file_entry_match.group(1))
            # The name is on the next non-blank line.
            j = i + 1
            while j < n:
                name_match = NAME_RE.match(lines[j])
                if name_match is not None:
                    file_names[index] = name_match.group(1)
                    break
                j += 1
            i = j + 1
            continue

        if TABLE_HEADER_RE.match(line.strip()) is not None:
            in_table = True
            i += 1
            # Skip the "------" separator line.
            if i < n and set(lines[i].strip()) <= {"-", " "}:
                i += 1
            continue

        if in_table:
            stripped = line.strip()
            if stripped == "" or stripped.startswith("debug_line["):
                in_table = False
                # Reset file table for the next compile unit's line program.
                file_names = {}
                i += 1
                continue

            tokens = stripped.split()
            addr_tok, line_tok, _col_tok, file_tok = tokens[0:4]
            flags = tokens[7:]

            is_stmt = "is_stmt" in flags
            end_sequence = "end_sequence" in flags

            if is_stmt and not end_sequence:
                file_index = int(file_tok)
                basename = file_names.get(file_index, "")
                if basename in WANTED_BASENAMES:
                    entries.append(
                        {
                            "addr": int(addr_tok, 16),
                            "line": int(line_tok),
                            "file": basename,
                        }
                    )
            i += 1
            continue

        i += 1

    return entries


def main() -> None:
    if len(sys.argv) != 3:
        print("usage: uv run lines.py <main.elf> <out.json>", file=sys.stderr)
        raise SystemExit(2)

    elf_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])

    output = run_dwarfdump(elf_path)
    entries = parse_debug_line(output)

    entries.sort(key=lambda e: e["addr"])

    deduped: dict[int, dict] = {}
    for entry in entries:
        deduped.setdefault(entry["addr"], entry)
    result = [deduped[addr] for addr in sorted(deduped)]

    out_path.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
