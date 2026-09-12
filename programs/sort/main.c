#include "llmcpu.h"

int main(void) {
    int values[5] = {5, 3, 4, 1, 2};
    int n = 5;
    for (int i = 0; i < n - 1; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (values[j] > values[j + 1]) {
                int tmp = values[j];
                values[j] = values[j + 1];
                values[j + 1] = tmp;
            }
        }
    }
    for (int i = 0; i < n; i++) {
        put_uint((unsigned int)values[i]);
        if (i != n - 1) {
            putc_(' ');
        }
    }
    putc_('\n');
    return 0;
}
