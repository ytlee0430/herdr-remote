/* Test-only agent: rejects Enter delivered in the same burst as pasted text. */
#include <termios.h>
#include <unistd.h>
#include <time.h>
#include <string.h>

static double now(void) {
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec + value.tv_nsec / 1e9;
}

int main(void) {
    struct termios original, raw;
    tcgetattr(0, &original); raw = original; cfmakeraw(&raw);
    tcsetattr(0, TCSANOW, &raw);
    const char *ready = "\033[?2004hAGENT_READY\r\n";
    write(1, ready, strlen(ready));
    char buffer[20000], byte; size_t count = 0; double paste_ended = 0;
    while (read(0, &byte, 1) == 1 && byte != 3) {
        if (byte == '\r') {
            if (now() - paste_ended < .2) {
                const char *error = "EARLY_ENTER_IGNORED\r\n";
                write(1, error, strlen(error));
            } else {
                write(1, "SUBMITTED:", 10);
                for (size_t i = 0; i < count; i++) {
                    if (i + 6 <= count && (!memcmp(buffer + i, "\033[200~", 6) || !memcmp(buffer + i, "\033[201~", 6))) i += 5;
                    else write(1, buffer + i, 1);
                }
                write(1, "\r\n", 2); count = 0;
            }
        } else if (count < sizeof(buffer)) {
            buffer[count++] = byte;
            if (count >= 6 && !memcmp(buffer + count - 6, "\033[201~", 6)) paste_ended = now();
        }
    }
    tcsetattr(0, TCSANOW, &original);
    return 0;
}
