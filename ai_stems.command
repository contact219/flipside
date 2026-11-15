#!/bin/sh
# Starts the AI stem splitter (Demucs) for Flipside. Needs Python 3.10 or newer.
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up the AI splitter. This downloads about 1 GB."
  python3 -m venv .venv || { echo "Python 3 is needed. Install it from python.org."; exit 1; }
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install torch torchaudio numpy demucs || exit 1
fi
echo "Leave this window open while you use Flipside."
exec .venv/bin/python stem_server/server.py
