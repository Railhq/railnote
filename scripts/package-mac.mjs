// Builds Railnote.app into release/, with its own name and icon (npm run package).
// The main process and pages are bundled, so the app carries only the build output.
import { packager } from "@electron/packager";
import { execFileSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const keep = /^\/(package\.json|dist|dist-electron|dist-export|build\/icon\.png)(\/|$)/;

const [out] = await packager({
  dir: ".",
  out: "release",
  overwrite: true,
  name: "Railnote",
  executableName: "Railnote",
  appBundleId: "com.getrailhq.railnote",
  appCategoryType: "public.app-category.productivity",
  icon: "build/icon.icns",
  electronVersion: require("electron/package.json").version,
  platform: "darwin",
  arch: process.arch,
  prune: false,
  // Keep the parent folders of anything kept, or packager never walks into them.
  ignore: (p) => p !== "" && p !== "/build" && !keep.test(p),
  extendInfo: { NSHumanReadableCopyright: "MIT licensed" },
});
// Packaging changes the bundle, so sign it again: ad hoc, which runs on the Mac that built it.
// Sharing it with other Macs needs a Developer ID signature and notarization.
execFileSync("codesign", ["--force", "--deep", "--sign", "-", `${out}/Railnote.app`], { stdio: "inherit" });
console.log(`${out}/Railnote.app`);
