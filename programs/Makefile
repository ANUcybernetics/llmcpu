# Build every programs/<name>/main.c into <name>/main.elf, <name>/disasm.txt
# and <name>/lines.json. main.elf, disasm.txt and lines.json are committed
# artefacts (the site build never invokes a cross-compiler); only *.o is
# scratch and removed by `make clean`. Every tool is the versioned llvm-18
# binary and the ELF carries no absolute path (-fdebug-compilation-dir), so a
# rebuild anywhere with the same packages reproduces the committed files byte
# for byte; CI relies on that to check they are fresh.

CC        := clang-18
TARGET     = --target=riscv32
ARCHFLAGS  = -march=rv32i -mabi=ilp32

CFLAGS  := $(TARGET) $(ARCHFLAGS) -ffreestanding -fno-builtin -nostdlib \
           -mno-relax -O1 -g -fdebug-compilation-dir=. -Wall -Wextra -Werror -I.
ASFLAGS := $(TARGET) $(ARCHFLAGS) -mno-relax

LD       := ld.lld-18
OBJDUMP  := llvm-objdump-18
NM       := llvm-nm-18
LINES    := uv run lines.py

PROG_DIRS   := $(patsubst %/main.c,%,$(wildcard */main.c))
ELFS       := $(patsubst %,%/main.elf,$(PROG_DIRS))
DISASMS     := $(patsubst %,%/disasm.txt,$(PROG_DIRS))
LINES_JSONS := $(patsubst %,%/lines.json,$(PROG_DIRS))

.PHONY: all clean
all: $(ELFS) $(DISASMS) $(LINES_JSONS)

start.o: start.S
	$(CC) $(ASFLAGS) -c -o $@ $<

%/main.o: %/main.c llmcpu.h
	$(CC) $(CFLAGS) -c -o $@ $<

%/main.elf: %/main.o start.o link.ld
	$(LD) -T link.ld -nostdlib -o $@ start.o $*/main.o
	@if $(NM) -u $@ | grep -q .; then \
		echo "error: undefined symbols in $@:" >&2; \
		$(NM) -u $@ >&2; \
		exit 1; \
	fi

%/disasm.txt: %/main.elf
	$(OBJDUMP) -d -M no-aliases --no-print-imm-hex --no-show-raw-insn $< > $@

%/lines.json: %/main.elf lines.py
	$(LINES) $< $@

clean:
	rm -f start.o */main.o
