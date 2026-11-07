#!/usr/bin/env python3
"""Append the ECC embedded-VFS payload to a SEA executable (v2.0.0).

Tail layout (must match control-center/sea/sea-bootstrap.js):
  ...payload bytes... | indexJSON | uint32LE(indexLen) | MAGIC(16)

Usage: make-payload.py <in.exe> <out.exe> <file1> [file2 ...]
Each input file is stored under its path relative to --root (default: bundle
root), keys are POSIX-style, e.g. app/server.js, Cfg.ini.
"""
import json
import struct
import sys
import os

MAGIC = b'ECC2EMBED_V200__'


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 3:
        print(__doc__)
        sys.exit(2)
    src, dst = args[0], args[1]
    root = os.path.commonpath([os.path.abspath(f) for f in args[2:]])
    # explicit root option
    if '--root' in args:
        i = args.index('--root')
        root = args[i + 1]
        files = [f for j, f in enumerate(args[2:]) if j not in (i - 2, i - 1)]
    else:
        files = args[2:]

    index, payload, off = {}, bytearray(), 0
    for f in sorted(files):
        rel = os.path.relpath(os.path.abspath(f), os.path.abspath(root)).replace(os.sep, '/')
        data = open(f, 'rb').read()
        index[rel] = [off, len(data)]
        payload += data
        off += len(data)

    idx = json.dumps(index, separators=(',', ':'), sort_keys=True).encode()
    with open(src, 'rb') as fh:
        base = fh.read()
    with open(dst, 'wb') as out:
        out.write(base)
        out.write(payload)
        out.write(idx)
        out.write(struct.pack('<I', len(idx)))
        out.write(MAGIC)
    print(f'payload: {len(index)} files, {len(payload)} bytes; index {len(idx)} B; '
          f'total {len(base) + len(payload) + len(idx) + 20} B -> {dst}')


if __name__ == '__main__':
    main()
