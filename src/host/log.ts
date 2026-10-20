const DEBUG = !!process.env.BETTERCODEX_DEBUG;

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

export const log = {
  info: (...args: unknown[]) => console.error(stamp(), '[info]', ...args),
  warn: (...args: unknown[]) => console.error(stamp(), '[warn]', ...args),
  error: (...args: unknown[]) => console.error(stamp(), '[error]', ...args),
  debug: (...args: unknown[]) => {
    if (DEBUG) console.error(stamp(), '[debug]', ...args);
  },
};

export function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
