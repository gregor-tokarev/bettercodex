// Real X11 input and screen captures, for native browser views that the renderer cannot see.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const env = () => ({ ...process.env, DISPLAY: process.env.DISPLAY });

export function rootShot(out, name) {
  const file = path.join(out, `${name}.png`);
  execFileSync('import', ['-display', process.env.DISPLAY, '-window', 'root', file]);
  console.log('screen', file);
  return file;
}

/** Turns window content coordinates into screen coordinates. */
export function windowOrigin() {
  const id = execFileSync('xdotool', ['search', '--onlyvisible', '--name', '^BetterCodex$'], { env: env() }).toString().trim().split('\n')[0];
  const geo = Object.fromEntries(
    execFileSync('xdotool', ['getwindowgeometry', '--shell', id], { env: env() })
      .toString()
      .trim()
      .split('\n')
      .map((l) => l.split('=')),
  );
  return { x: Number(geo.X), y: Number(geo.Y) };
}

export function click(x, y) {
  const o = windowOrigin();
  execFileSync('xdotool', ['mousemove', String(Math.round(o.x + x)), String(Math.round(o.y + y)), 'click', '1'], { env: env() });
}

export function type(text) {
  execFileSync('xdotool', ['type', '--delay', '20', text], { env: env() });
}
