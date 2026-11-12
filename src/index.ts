// node:sqlite is available without a flag from Node 22.13.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`minimi chat needs Node >= 22.13 (you have ${process.versions.node}). Install the current LTS from https://nodejs.org`);
  process.exit(1);
}

// node:sqlite prints an ExperimentalWarning on Node 22. Hide only that one, then boot.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(typeof w === "string" ? w : w.message).includes("SQLite")) return;
  return (emitWarning as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;

const { start } = await import("./server.js");
start();
