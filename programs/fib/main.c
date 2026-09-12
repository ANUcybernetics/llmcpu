#include "llmcpu.h"

int main(void) {
    /* volatile keeps the compiler from computing the answer at compile time */
    volatile int n = 10;
    unsigned int a = 0;
    unsigned int b = 1;
    for (int i = 0; i < n; i++) {
        unsigned int next = a + b;
        a = b;
        b = next;
    }
    put_uint(a);
    putc_('\n');
    return 0;
}
