/* Linker script for llmcpu: a 16 KiB RV32I machine.
 * RAM is 0x0000..0x3FFF; code starts at 0x0 (_start is the entry point);
 * the stack starts at the top of RAM (_stack_top = 0x4000) and grows down.
 * MMIO (console/halt) lives above RAM at 0x4000/0x4004 and is not part of
 * this memory region.
 */

ENTRY(_start)

MEMORY
{
  RAM (rwx) : ORIGIN = 0x00000000, LENGTH = 0x4000
}

SECTIONS
{
  . = 0x00000000;

  .text : {
    *(.text.start)
    *(.text .text.*)
  } > RAM

  .rodata : {
    *(.rodata .rodata.*)
  } > RAM

  .data : {
    *(.data .data.*)
  } > RAM

  . = ALIGN(4);
  __bss_start = .;
  .bss : {
    *(.bss .bss.*)
    *(COMMON)
  } > RAM
  . = ALIGN(4);
  __bss_end = .;

  _stack_top = 0x4000;

  /DISCARD/ : { *(.comment) *(.riscv.attributes) *(.eh_frame) }
}

/* Reserve at least 1 KiB for the stack: program image must fit below
 * _stack_top - 0x400. */
ASSERT(__bss_end <= _stack_top - 0x400, "programs/link.ld: image exceeds 16KiB RAM minus 1KiB stack reserve")
