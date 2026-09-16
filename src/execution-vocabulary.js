// The per-harness effort sets are deliberately asymmetric. `ultra` is known
// cross-harness vocabulary, so review does not report it as structurally
// unknown; the Codex materializer accepts it as a native value, while the
// Claude materializer treats it as an explicit unresolved condition that an
// operator must settle with --claude-effort.
export const KNOWN_EFFORTS = Object.freeze(new Set(["low", "medium", "high", "xhigh", "max", "ultra"]));
export const CLAUDE_EFFORTS = Object.freeze(new Set(["low", "medium", "high", "xhigh", "max"]));
export const CODEX_EFFORTS = Object.freeze(new Set(["low", "medium", "high", "xhigh", "max", "ultra"]));
