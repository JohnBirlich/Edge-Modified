#!/usr/bin/env python3
"""Append the ECC embedded-VFS payload to a SEA executable (v2.0.0).

Tail layout (must match control-center/sea/sea-bootstrap.js):
  ...payload bytes... | indexJSON | uint32LE(indexLen) | MAGIC(16)

Two trailer formats:
  default (VFS index):  …payload | indexJSON | u32 indexLen | "ECC2EMBED_V200__"
  --native (single blob): …blob | u64 blobLen | "ECCNATIVE1"

Usage: make-payload.py <in.exe> <out.exe> [--native] [--root DIR] <file1> [file2 ...]
Each input file is stored under its path relative to --root (default: bundle
root), keys are POSIX-style, e.g. app/server.js, Cfg.ini.
"""
import json
import struct
import sys
import os

MAGIC = b'ECC2EMBED_V200__'
MAGIC_NATIVE = b'ECCNATIVE1'


def main() -> None:
    args = sys.argv[1:]
    if len(args) < 3:
        print(__doc__)
        sys.exit(2)
    src, dst = args[0], args[1]
    native = '--native' in args
    if native:
        args = [a for a in args if a != '--native']
    rest = args[2:]
    root = os.path.commonpath([os.path.abspath(f) for f in rest]) if rest else os.getcwd()
    # explicit root option
    if '--root' in rest:
        i = rest.index('--root')
        root = rest[i + 1]
        files = [f for j, f in enumerate(rest) if j not in (i, i + 1)]
    else:
        files = rest

    if native:
        # single-blob trailer: first file is the blob (e.g. the engine exe)
        assert len(files) == 1, 'native mode takes exactly one file'
        blob = open(files[0], 'rb').read()
        base = open(src, 'rb').read()
        with open(dst, 'wb') as out:
            out.write(base)
            out.write(blob)
            out.write(struct.pack('<Q', len(blob)))
            out.write(MAGIC_NATIVE)
        print(f'native payload: blob {len(blob)} B -> {dst} ({len(base) + len(blob) + 18} B total)')
        return

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
