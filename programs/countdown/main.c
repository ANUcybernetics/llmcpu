#include "llmcpu.h"

int main(void) {
    for (int i = 5; i >= 1; i--) {
        putc_((char)('0' + i));
        putc_(' ');
    }
    puts_("liftoff\n");
    return 0;
}
