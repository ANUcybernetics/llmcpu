#include "llmcpu.h"

int main(void) {
    char s[] = "llmcpu";
    int len = 0;
    while (s[len] != '\0') {
        len++;
    }
    int i = 0;
    int j = len - 1;
    while (i < j) {
        char tmp = s[i];
        s[i] = s[j];
        s[j] = tmp;
        i++;
        j--;
    }
    puts_(s);
    putc_('\n');
    return 0;
}
