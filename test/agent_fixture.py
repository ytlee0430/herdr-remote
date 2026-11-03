"""A terminal agent fixture that rejects Enter in the same paste burst."""
import os
import sys
import termios
import time
import tty

original = termios.tcgetattr(0)
tty.setraw(0)
os.write(1, b'\x1b[?2004hAGENT_READY\r\n')
buffer = b''
paste_ended = 0
try:
    while True:
        byte = os.read(0, 1)
        if byte == b'\x03':
            break
        if byte == b'\r':
            if time.monotonic() - paste_ended < .2:
                os.write(1, b'EARLY_ENTER_IGNORED\r\n')
            else:
                os.write(1, b'SUBMITTED:' + buffer.replace(b'\x1b[200~', b'').replace(b'\x1b[201~', b'') + b'\r\n')
                buffer = b''
            continue
        buffer += byte
        if buffer.endswith(b'\x1b[201~'):
            paste_ended = time.monotonic()
finally:
    termios.tcsetattr(0, termios.TCSANOW, original)
