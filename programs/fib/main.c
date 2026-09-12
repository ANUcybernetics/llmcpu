#include "llmcpu.h"

int main(void) {
    unsigned int a = 0;
    unsigned int b = 1;
    for (int i = 0; i < 10; i++) {
        unsigned int next = a + b;
        a = b;
        b = next;
    }
    put_uint(a);
    putc_('\n');
    return 0;
}
