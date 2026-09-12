/* _start: the machine's entry point, placed at address 0x0 via .text.start.
 * Sets up the stack, zeroes .bss, calls main, then halts with main's return
 * value (a0) as the exit code and spins forever.
 */

    .section .text.start
    .global _start
    .type _start, @function

_start:
    la      sp, _stack_top

    la      a0, __bss_start
    la      a1, __bss_end
1:
    bge     a0, a1, 2f
    sw      zero, 0(a0)
    addi    a0, a0, 4
    j       1b
2:

    call    main

    li      a1, 0x4004
    sw      a0, 0(a1)

3:
    j       3b

    .size _start, . - _start
