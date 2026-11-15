import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

/** Starts the local Demucs stem server next to the dev server, when its Python environment exists. */
function stemServer(): Plugin {
  let child: ChildProcess | null = null;
  const stop = () => {
    child?.kill();
    child = null;
  };
  return {
    name: 'flipside-stem-server',
    apply: 'serve',
    configureServer(server) {
      const py = resolve('.venv/Scripts/python.exe');
      const alt = resolve('.venv/bin/python');
      const exe = existsSync(py) ? py : existsSync(alt) ? alt : null;
      if (!exe) {
        console.log('[stems] no .venv found, AI stem split is off (the quick split still works)');
        return;
      }
      child = spawn(exe, [resolve('stem_server/server.py')], { stdio: 'inherit' });
      child.on('exit', () => (child = null));
      server.httpServer?.once('close', stop);
      process.once('exit', stop);
    },
  };
}

// relative base so the build works from any folder, including GitHub Pages
export default defineConfig({ base: './', plugins: [stemServer()] });
