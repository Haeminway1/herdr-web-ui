// Packs the shell for Windows and macOS into out/ (npm run package [-- platform arch]).
// A folder per target, nothing installed: copy it to the computer and run herdr(.exe/.app).
// On a Mac, an Apple Silicon build needs its ad-hoc signature again once copied:
//   codesign --force --deep --sign - herdr.app
import { packager } from "@electron/packager";

const [platform, arch] = process.argv.slice(2);
const targets = platform ? [[platform, arch ?? "x64"]] : [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"]];

for (const [targetPlatform, targetArch] of targets) {
  const [out] = await packager({
    dir: import.meta.dirname,
    out: `${import.meta.dirname}/out`,
    overwrite: true,
    platform: targetPlatform,
    arch: targetArch,
    name: "herdr",
    appBundleId: "dev.herdr.desktop",
    // the app's own icon: herdr's, not Electron's (icon.ico on Windows, icon.icns on a Mac;
    // a Windows build made elsewhere sets it through rcedit, which needs wine there)
    icon: `${import.meta.dirname}/icon`,
    asar: true,
    prune: true,
    ignore: [/^\/out($|\/)/, /\.test\.js$/, /^\/package\.mjs$/, /^\/e2e\.ts$/],
  });
  console.log(out);
}
