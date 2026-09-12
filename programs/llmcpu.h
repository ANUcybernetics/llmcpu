/* llmcpu.h -- MMIO helpers for programs running on the llmcpu RV32I machine.
 *
 * MMIO map:
 *   0x00004000-0x40ff  CONSOLE  a store prints the stored bytes, lowest first,
 *                               up to the first zero byte
 *   0x00004100         HALT     store a word -> machine halts, value is exit code
 *   0x00005000-0x53ff  DISPLAY  32 x 32 pixels, one byte each, row-major; the
 *                               low four bits of a byte pick a palette colour
 *
 * No *, /, or % on ints: this target has no M extension and no
 * compiler-rt, so those operators would emit calls to __mulsi3 /
 * __udivsi3 / etc., which do not exist and would fail to link.
 */

#ifndef LLMCPU_H
#define LLMCPU_H

#define LLMCPU_CONSOLE_ADDR 0x00004000u
#define LLMCPU_HALT_ADDR 0x00004100u
#define LLMCPU_DISPLAY_ADDR 0x00005000u
#define LLMCPU_DISPLAY_W 32
#define LLMCPU_DISPLAY_H 32

static inline void putc_(char c) {
    volatile unsigned int *console = (volatile unsigned int *)LLMCPU_CONSOLE_ADDR;
    *console = (unsigned int)(unsigned char)c;
}

static inline void puts_(const char *s) {
    while (*s != '\0') {
        putc_(*s);
        s++;
    }
}

/* Print n (< 10000) in decimal, via repeated subtraction of powers of ten.
 * The table stops at 1000 to keep traces short: every extra power costs a
 * loop iteration per call even when the digit is zero. */
static inline void put_uint(unsigned int n) {
    static const unsigned int pow10[4] = {1000u, 100u, 10u, 1u};
    int started = 0;
    for (int i = 0; i < 4; i++) {
        unsigned int p = pow10[i];
        unsigned int digit = 0;
        while (n >= p) {
            n -= p;
            digit++;
        }
        if (digit != 0 || started || p == 1u) {
            putc_((char)('0' + digit));
            started = 1;
        }
    }
}

/* Light the pixel at column x, row y (0..31 each) in palette colour c (0..15). */
static inline void plot(int x, int y, unsigned char c) {
    volatile unsigned char *display = (volatile unsigned char *)LLMCPU_DISPLAY_ADDR;
    display[(y << 5) + x] = c;
}

static inline void halt(unsigned int code) {
    volatile unsigned int *haltreg = (volatile unsigned int *)LLMCPU_HALT_ADDR;
    *haltreg = code;
}

#endif /* LLMCPU_H */
