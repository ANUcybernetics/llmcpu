#include "llmcpu.h"

int main(void) {
    /* volatile keeps the compiler from unrolling the whole countdown */
    volatile int start = 5;
    for (int i = start; i >= 1; i--) {
        putc_((char)('0' + i));
        putc_(' ');
    }
    puts_("liftoff\n");
    return 0;
}
