// ============================================================
// Run this locally whenever you change agent.js, sonoff-th.js,
// or lanli-rs485.js — before pushing to GitHub.
// It recalculates checksums and bumps the version so every farm
// PC's updater picks up the change automatically.
//
// Usage:  node build-manifest.js [patch|minor|major]
// Default bump type is "patch" if not specified.
// ============================================================
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const FILES = ['agent.js', 'sonoff-th.js', 'lanli-rs485.js'];

function sha256File(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function bumpVersion(version, kind) {
  const [maj, min, pat] = version.split('.').map(Number);
  if (kind === 'major') return `${maj+1}.0.0`;
  if (kind === 'minor') return `${maj}.${min+1}.0`;
  return `${maj}.${min}.${pat+1}`;
}

function main() {
  const bumpKind = process.argv[2] || 'patch';
  let manifest = { version: '1.0.0', files: [] };
  if (fs.existsSync(MANIFEST_PATH)) {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  }

  const newFiles = FILES.filter(f => fs.existsSync(path.join(__dirname, f))).map(f => ({
    name: f,
    sha256: sha256File(path.join(__dirname, f)),
    size: fs.statSync(path.join(__dirname, f)).size,
  }));

  // Did anything actually change?
  const changed = JSON.stringify(newFiles) !== JSON.stringify(manifest.files);
  if (!changed) {
    console.log('No file changes detected — manifest.json left as-is.');
    return;
  }

  const newVersion = bumpVersion(manifest.version, bumpKind);
  console.log(`Version: ${manifest.version} → ${newVersion}`);

  const changelog = [];
  process.stdout.write('Changelog line for this release (Enter to skip): ');
  process.stdin.once('data', data => {
    const line = data.toString().trim();
    if (line) changelog.push(line);

    const newManifest = {
      version: newVersion,
      released_at: new Date().toISOString(),
      min_node_version: manifest.min_node_version || '16.0.0',
      changelog: changelog.length ? changelog : (manifest.changelog || []),
      files: newFiles,
    };

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(newManifest, null, 2));
    console.log(`\n✓ manifest.json updated to v${newVersion}`);
    console.log('Now commit and push manifest.json + the changed file(s) to GitHub.');
    process.exit(0);
  });
}

main();
