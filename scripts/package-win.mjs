// Builds Railnote for Windows (npm run release:win): an x64 Setup.exe that installs per user with
// a Start menu shortcut, plus the RELEASES and .nupkg files that installed copies update from.
// Run it on Windows; the release workflow does, on GitHub's Windows machines. It isn't signed yet,
// so SmartScreen asks first-time users to confirm.
import { packager } from "@electron/packager";
import { createWindowsInstaller } from "electron-winstaller";
import fs from "fs";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const { version, description } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const keep = /^\/(package\.json|dist|dist-electron|dist-export|build\/icon\.png)(\/|$)/;
const arch = "x64";

const [out] = await packager({
  dir: ".",
  out: "release",
  overwrite: true,
  name: "Railnote",
  executableName: "railnote",
  appVersion: version,
  icon: "build/icon.ico",
  electronVersion: require("electron/package.json").version,
  platform: "win32",
  arch,
  prune: false,
  // Keep the parent folders of anything kept, or packager never walks into them.
  ignore: (p) => p !== "" && p !== "/build" && !keep.test(p),
  win32metadata: { CompanyName: "Railhq", FileDescription: "Railnote", ProductName: "Railnote" },
});

const dir = path.join("release", `win-${arch}`);
fs.rmSync(dir, { recursive: true, force: true });
await createWindowsInstaller({
  appDirectory: out,
  outputDirectory: dir,
  name: "railnote",
  title: "Railnote",
  exe: "railnote.exe",
  authors: "Railhq",
  description,
  version,
  setupExe: `Railnote-${version}-win-${arch}-setup.exe`,
  setupIcon: "build/icon.ico",
  iconUrl: "https://raw.githubusercontent.com/Railhq/railnote/main/build/icon.ico",
  noMsi: true,
});
for (const f of fs.readdirSync(dir)) console.log(path.join(dir, f), `${(fs.statSync(path.join(dir, f)).size / 1e6).toFixed(0)} MB`);
