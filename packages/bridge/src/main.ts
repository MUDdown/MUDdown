#!/usr/bin/env node

// Must run before ANY import so that chalk / supports-color (loaded by
// @muddown/client) picks up the override.  In Node ESM, static imports
// are resolved before the module body executes, so we use a dynamic
// import() below to guarantee ordering.
process.env.FORCE_COLOR ??= "3";

const { main } = await import("./bridge.js");
main();

export {};
