/** Split text into chunks no larger than `limit`, preferring line boundaries. */
export function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (buf) {
        out.push(buf);
        buf = '';
      }
      for (let i = 0; i < line.length; i += limit) out.push(line.slice(i, i + limit));
      continue;
    }
    if (buf.length + line.length + 1 > limit) {
      out.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** Read a required env var or throw a clear error naming the channel. */
export function requireEnv(name: string, channel: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${channel} channel enabled but ${name} is not set.`);
  return v;
}
