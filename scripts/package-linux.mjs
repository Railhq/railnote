// Builds Railnote for Linux (npm run release:linux): an AppImage and a .deb for x64 and arm64,
// in release/. The app is packaged here; the installers are made by linux-installers.sh, run
// directly on Linux or in a Debian container (Docker) anywhere else.
import { packager } from "@electron/packager";
import { execFileSync } from "child_process";
import fs from "fs";
import { createRequire } from "module";
import path from "path";

const require = createRequire(import.meta.url);
const arches = (process.env.ARCH || "x64,arm64").split(",");
const { version } = JSON.parse(fs.readFileSync("package.json", "utf8"));
const keep = /^\/(package\.json|dist|dist-electron|dist-export|build\/icon\.png)(\/|$)/;

for (const arch of arches) {
  const [out] = await packager({
    dir: ".",
    out: "release",
    overwrite: true,
    name: "Railnote",
    executableName: "railnote",
    appVersion: version,
    electronVersion: require("electron/package.json").version,
    platform: "linux",
    arch,
    prune: false,
    // Keep the parent folders of anything kept, or packager never walks into them.
    ignore: (p) => p !== "" && p !== "/build" && !keep.test(p),
  });
  const args = [version, arch, out];
  if (process.platform === "linux") execFileSync("sh", ["scripts/linux-installers.sh", ...args], { stdio: "inherit" });
  else
    execFileSync(
      "docker",
      ["run", "--rm", "-v", `${process.cwd()}:/src`, "-w", "/src", "debian:bookworm-slim", "sh", "scripts/linux-installers.sh", ...args],
      { stdio: "inherit" },
    );
  for (const f of [`Railnote-${version}-linux-${arch}.AppImage`, `railnote_${version}_${arch === "x64" ? "amd64" : arch}.deb`])
    console.log(path.join("release", f), `${(fs.statSync(path.join("release", f)).size / 1e6).toFixed(0)} MB`);
}
