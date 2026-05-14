// Tiny flag parser. Supports --key value and --key=value. No positional args
// after a flag. Repeated flags become arrays.

export function parseFlags(argv) {
  const out = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (eq > 0) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    }
    if (key in out) {
      out[key] = Array.isArray(out[key]) ? [...out[key], val] : [out[key], val];
    } else {
      out[key] = val;
    }
  }
  return { flags: out, positional };
}

export function requireFlag(flags, name) {
  if (flags[name] === undefined || flags[name] === true) {
    throw new Error(`--${name} required`);
  }
  return flags[name];
}
