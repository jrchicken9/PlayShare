"""
Legacy entry point. Extension icons are built from shared/brand-mark.png.

  npm install   # ensures sharp
  npm run icons

This file kept for anyone who runs `python3 gen_icons.py` — it shells to npm run icons.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def main():
    try:
        subprocess.run(
            ['npm', 'run', 'icons'],
            cwd=ROOT,
            check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print('npm run icons failed:', e, file=sys.stderr)
        print('Install Node.js, run: cd', ROOT, '&& npm install && npm run icons', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
