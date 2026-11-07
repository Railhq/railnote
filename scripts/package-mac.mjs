// Builds Railnote.app into release/, with its own name and icon (npm run package), plus the
// files a release ships: a .dmg to download and a .zip for auto-update (npm run release:mac).
// The main process and pages are bundled, so the app carries only the build output.
//
// Signing: with APPLE_SIGN_IDENTITY set (e.g. "Developer ID Application: Name (TEAMID)") the app
// is signed with the hardened runtime, and with APPLE_KEYCHAIN_PROFILE also set (a profile saved
// by `xcrun notarytool store-credentials`) it is notarized. Without them it is signed ad hoc, which runs only on
// the Mac that built it.
import { packager } from "@electron/packager";
import { execFileSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const release = process.argv.includes("--release");
// A release builds one download each for Apple silicon and Intel (a universal app would carry
// Electron twice); a local build is just this Mac's.
const arches = (
  process.env.ARCH || (release ? "arm64,x64" : process.arch)
).split(",");
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const identity = process.env.APPLE_SIGN_IDENTITY;
const profile = process.env.APPLE_KEYCHAIN_PROFILE;
const notarize = identity && profile;
const keep =
  /^\/(package\.json|dist|dist-electron|dist-export|build\/icon\.png)(\/|$)/;

for (const arch of arches) await build(arch);

async function build(arch) {
  const [out] = await packager({
    dir: ".",
    out: "release",
    overwrite: true,
    name: "Railnote",
    executableName: "Railnote",
    appBundleId: "com.getrailhq.railnote",
    appCategoryType: "public.app-category.productivity",
    appVersion: version,
    icon: "build/icon.icns",
    electronVersion: require("electron/package.json").version,
    platform: "darwin",
    arch,
    prune: false,
    // Keep the parent folders of anything kept, or packager never walks into them.
    ignore: (p) => p !== "" && p !== "/build" && !keep.test(p),
    extendInfo: { NSHumanReadableCopyright: "MIT licensed" },
    ...(identity
      ? {
          osxSign: {
            identity,
            optionsForFile: () => ({ hardenedRuntime: true }),
          },
        }
      : {}),
    ...(notarize
      ? {
          osxNotarize: { keychainProfile: profile },
        }
      : {}),
  });
  const app = path.join(out, "Railnote.app");
  // Packaging changes the bundle, so without a real identity sign it again, ad hoc, or Apple
  // silicon refuses to open it.
  if (!identity)
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], {
      stdio: "inherit",
    });
  console.log(
    app,
    identity
      ? notarize
        ? "(signed and notarized)"
        : "(signed, not notarized)"
      : "(ad hoc: this Mac only)",
  );

  if (release) {
    const base = path.join("release", `Railnote-${version}-mac-${arch}`);
    fs.rmSync(`${base}.zip`, { force: true });
    fs.rmSync(`${base}.dmg`, { force: true });
    // Auto-update downloads the zip; ditto keeps the signature and symlinks intact.
    execFileSync(
      "ditto",
      ["-c", "-k", "--sequesterRsrc", "--keepParent", app, `${base}.zip`],
      { stdio: "inherit" },
    );
    // The disk image opens to the app beside a link to Applications, to drag across.
    const stage = fs.mkdtempSync(path.join("release", "dmg-"));
    execFileSync("ditto", [app, path.join(stage, "Railnote.app")]);
    fs.symlinkSync("/Applications", path.join(stage, "Applications"));
    execFileSync(
      "hdiutil",
      [
        "create",
        "-volname",
        "Railnote",
        "-srcfolder",
        stage,
        "-ov",
        "-format",
        "UDZO",
        "-fs",
        "HFS+",
        `${base}.dmg`,
      ],
      { stdio: "inherit" },
    );
    fs.rmSync(stage, { recursive: true, force: true });
    if (identity)
      execFileSync("codesign", ["--sign", identity, `${base}.dmg`], {
        stdio: "inherit",
      });
    if (notarize) {
      execFileSync(
        "xcrun",
        [
          "notarytool",
          "submit",
          `${base}.dmg`,
          "--keychain-profile",
          profile,
          "--wait",
        ],
        { stdio: "inherit" },
      );
      execFileSync("xcrun", ["stapler", "staple", `${base}.dmg`], {
        stdio: "inherit",
      });
    }
    for (const f of [`${base}.dmg`, `${base}.zip`])
      console.log(f, `${(fs.statSync(f).size / 1e6).toFixed(0)} MB`);
  }
}
