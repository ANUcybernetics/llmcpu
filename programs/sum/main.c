#include "llmcpu.h"

int main(void) {
    int values[5] = {3, 1, 4, 1, 5};
    int total = 0;
    for (int i = 0; i < 5; i++) {
        total += values[i];
    }
    put_uint((unsigned int)total);
    putc_('\n');
    return 0;
}
