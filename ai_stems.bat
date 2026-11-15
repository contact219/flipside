@echo off
rem Starts the AI stem splitter (Demucs) for Flipside. Needs Python 3.10 or newer.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo First run: setting up the AI splitter. This downloads about 1 GB.
  python -m venv .venv || goto :fail
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu || goto :fail
  .venv\Scripts\python -m pip install numpy demucs || goto :fail
)
echo Leave this window open while you use Flipside.
.venv\Scripts\python stem_server\server.py
goto :eof
:fail
echo Setup failed. Check that Python is installed and you are online.
pause
