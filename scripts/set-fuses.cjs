/**
 * F-5: @electron/fuses — applied as electron-builder afterPack hook.
 *
 * Hardens the packaged .app binary by disabling dangerous runtime flags.
 * Runs AFTER electron-builder packs the app but BEFORE DMG creation.
 *
 * Enabled fuses:
 *   - EnableNodeCliInspectArguments: false  → disables --inspect / --inspect-brk in production
 *   - RunAsNode:                    false  → prevents ELECTRON_RUN_AS_NODE bypass
 *   - EnableCookieEncryption:       true   → encrypts persisted cookies at rest
 *   - OnlyLoadAppFromAsar:          true   → refuses to load app code from loose files
 *   - GrantFileProtocolExtraPrivileges: false → file:// loses extra Electron privileges
 *
 * Note: fuses are one-way; once flipped in a binary they cannot be unset without re-packing.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const path = require('path')

/**
 * @param {import('electron-builder').AfterPackContext} context
 */
async function afterPack(context) {
  const { appOutDir, packager } = context
  const productName = packager.appInfo.productName
  const platform = packager.platform.name

  let appPath
  if (platform === 'mac') {
    appPath = path.join(appOutDir, `${productName}.app`)
  } else if (platform === 'win') {
    appPath = path.join(appOutDir, `${productName}.exe`)
  } else {
    // Linux: executable without extension
    appPath = path.join(appOutDir, productName)
  }

  console.log(`[set-fuses] Flipping fuses for: ${appPath}`)

  await flipFuses(appPath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'mac', // re-sign ad-hoc after fuse flip
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
  })

  console.log('[set-fuses] Fuses applied successfully.')
}

module.exports = afterPack
