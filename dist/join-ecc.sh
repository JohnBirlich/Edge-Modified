#!/usr/bin/env bash
cat ecc-part-00 ecc-part-01 ecc-part-02 ecc-part-03 ecc-part-04 > EdgeControlCenter-2.0.0.exe
sha256sum EdgeControlCenter-2.0.0.exe
# ожидается: c6f71bdef98cd2dd096d1c2405a1e89a7f55b8253010b7935c741942adc7465b
