@echo off
rem Hubble: start the DSH web instance in its own console window (stays up
rem independently of the launching shell).
set DSH_HOME=%~dp0..\data\dsh-home
cd /d %~dp0..
if not exist temp mkdir temp
"C:\Program Files\nodejs\node.exe" "C:\Users\Rico\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js" web --no-open --port 3080 1>temp\dsh_boot.log 2>temp\dsh_err.log
