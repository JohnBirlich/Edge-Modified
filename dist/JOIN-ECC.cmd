@echo off
title Join EdgeControlCenter parts
echo Склейка частей в EdgeControlCenter-2.0.0.exe ...
copy /b ecc-part-00+ecc-part-01+ecc-part-02+ecc-part-03+ecc-part-04 EdgeControlCenter-2.0.0.exe >nul
echo Проверка SHA-256 (должно быть c6f71bdef98cd2dd096d1c2405a1e89a7f55b8253010b7935c741942adc7465b):
certutil -hashfile EdgeControlCenter-2.0.0.exe SHA256
pause
