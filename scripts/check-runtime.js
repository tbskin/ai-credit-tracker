const major = Number(process.versions.node.split(".")[0]);
if (![22, 24].includes(major)) {
  console.error(
    `Stash supports Node.js 22 or 24 LTS. You are running ${process.version}.\n` +
      "Switch to Node.js 24 (nvm install && nvm use), then retry.\n" +
      "Chromium installation stalled during extraction with Node.js 26 in local validation.",
  );
  process.exitCode = 1;
}
