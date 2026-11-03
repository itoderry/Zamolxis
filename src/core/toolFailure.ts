/**
 * Tool results that report a failure. Tools answer in plain text ("Could not create the document:
 * ...", "File not found: ...", "App not found/supported: ..."), and the free models then told the user
 * "Word has been opened" anyway. A result whose first line reads like a failure is marked failed in
 * the turn report and, for the tool-using models, prefixed with an instruction to say it failed.
 */
const FAILURE = /^(could not|cannot|can't|unable to|file not found|app not found|not found|no such|pass [a-z]|error\b|(\S+\s){1,3}failed\b)/i;

export function isToolFailure(out: string): boolean {
  return FAILURE.test(String(out || '').trimStart());
}

/** The result as handed back to a tool-using model: failures are spelled out as failures. */
export function forModel(out: string): string {
  return isToolFailure(out) ? `TOOL FAILED: ${out}\nThis did NOT work. Tell the user plainly that it failed and why; do not say it was done.` : out;
}
