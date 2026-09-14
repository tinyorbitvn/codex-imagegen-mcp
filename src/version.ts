// The version this server reports to MCP clients over `initialize`.
//
// It is a plain constant rather than a read of package.json, because the
// built image has a different directory layout to the source tree and a
// path that resolves in one does not always resolve in the other. The cost
// is that two files have to agree, so tests/version.test.ts fails the build
// when they drift.
export const VERSION = "0.5.0";
