#include "llmcpu.h"

/* Draws one straight line across the display with Bresenham's algorithm:
 * no multiply or divide, just adds, compares and one shift. The endpoints
 * are volatile so clang cannot draw the picture at compile time. */
int main(void) {
    volatile int x0 = 1;
    volatile int y0 = 28;
    volatile int x1 = 30;
    volatile int y1 = 6;
    int x = x0;
    int y = y0;
    int dx = x1 - x;
    int dy = y - y1;
    int err = dx - dy;
    for (;;) {
        plot(x, y, 11);
        if (x == x1 && y == y1) {
            break;
        }
        int e2 = err << 1;
        if (e2 > -dy) {
            err -= dy;
            x++;
        }
        if (e2 < dx) {
            err += dx;
            y--;
        }
    }
    return 0;
}
