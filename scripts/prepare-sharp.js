// scripts/prepare-sharp.js
// Ensures the sharp binary is installed for linux/x64 inside the container.
// Runs prebuild-install, then npm rebuild, then a final npm install as fallback.

const { execSync } = require('child_process');

function run(cmd, envExtra = {}) {
  console.log('> ' + cmd);
  try {
    execSync(cmd, {
      stdio: 'inherit',
      env: Object.assign({}, process.env, envExtra)
    });
    return true;
  } catch (err) {
    console.error('Command failed:', cmd);
    return false;
  }
}

(async function main() {
  console.log('prepare-sharp: starting platform-targeted sharp install/rebuild...');
  const env = { npm_config_platform: 'linux', npm_config_arch: 'x64', npm_config_target_arch: 'x64' };

  // 1) Try prebuilt binary fetch (preferred)
  const prebuildCmd = 'npx prebuild-install --platform=linux --arch=x64 --force --verbose sharp';
  if (run(prebuildCmd, env)) {
    console.log('prepare-sharp: prebuild-install succeeded.');
    process.exit(0);
  }

  // 2) Try npm rebuild with update-binary flag
  const rebuildCmd = 'npm rebuild sharp --update-binary';
  if (run(rebuildCmd, env)) {
    console.log('prepare-sharp: npm rebuild succeeded.');
    process.exit(0);
  }

  // 3) Final fallback: reinstall sharp forcing arch/platform and unsafe-perm
  const installCmd = 'npm install --arch=x64 --platform=linux --unsafe-perm --verbose sharp';
  if (run(installCmd, env)) {
    console.log('prepare-sharp: npm install fallback succeeded.');
    process.exit(0);
  }

  console.error('prepare-sharp: all attempts failed. See logs above. You may need to verify node-gyp/build tools in the environment.');
  process.exit(1);
})();
