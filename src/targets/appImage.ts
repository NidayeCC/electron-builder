import { TargetEx } from "../platformPackager"
import { Arch } from "../metadata"
import * as path from "path"
import { exec, unlinkIfExists } from "../util/util"
import { open, write, createReadStream, createWriteStream, close, chmod } from "fs-extra-p"
import { LinuxTargetHelper } from "./LinuxTargetHelper"
import { getBin } from "../util/binDownload"
import BluebirdPromise from "bluebird-lst-c"
import { v1 as uuid1 } from "uuid-1345"
import { LinuxPackager } from "../linuxPackager"

const appImageVersion = process.platform === "darwin" ? "AppImage-09-07-16-mac" : "AppImage-09-07-16-linux"
//noinspection SpellCheckingInspection
const appImageSha256 = process.platform === "darwin" ? "5d4a954876654403698a01ef5bd7f218f18826261332e7d31d93ab4432fa0312" : "ac324e90b502f4e995f6a169451dbfc911bb55c0077e897d746838e720ae0221"
//noinspection SpellCheckingInspection
const appImagePathPromise = getBin("AppImage", appImageVersion, `https://dl.bintray.com/electron-userland/bin/${appImageVersion}.7z`, appImageSha256)

export default class AppImageTarget extends TargetEx {
  private readonly options = Object.assign({}, this.packager.platformSpecificBuildOptions, (<any>this.packager.devMetadata.build)[this.name])
  private readonly desktopEntry: Promise<string>

  constructor(private packager: LinuxPackager, private helper: LinuxTargetHelper, private outDir: string) {
    super("appImage")

    // we add X-AppImage-BuildId to ensure that new desktop file will be installed
    this.desktopEntry = BluebirdPromise.promisify(uuid1)({mac: false})
      .then(uuid => helper.computeDesktopEntry(this.options, "AppRun", {
        "X-AppImage-Version": `${packager.appInfo.buildVersion}`,
        "X-AppImage-BuildId": uuid,
      }))
  }

  async build(appOutDir: string, arch: Arch): Promise<any> {
    const packager = this.packager

    // avoid spaces in the file name
    const image = path.join(this.outDir, packager.generateName("AppImage", arch, true))
    await unlinkIfExists(image)

    const appImagePath = await appImagePathPromise
    const args = [
      "-joliet", "on",
      "-volid", "AppImage",
      "-dev", image,
      "-padding", "0",
      "-map", appOutDir, "/usr/bin",
      "-map", path.join(__dirname, "..", "..", "templates", "linux", "AppRun.sh"), "/AppRun",
      // we get executable name in the AppRun by desktop file name, so, must be named as executable
      "-map", await this.desktopEntry, `/${this.packager.executableName}.desktop`,
    ]
    for (let [from, to] of (await this.helper.icons)) {
      args.push("-map", from, `/usr/share/icons/default/${to}`)
    }

    // must be after this.helper.icons call
    if (this.helper.maxIconPath == null) {
      throw new Error("Icon is not provided")
    }
    args.push("-map", this.helper.maxIconPath, "/.DirIcon")

    args.push("-chown_r", "0", "/", "--")
    args.push("-zisofs", `level=${packager.devMetadata.build.compression === "store" ? "0" : "9"}:block_size=128k:by_magic=off`)
    args.push("set_filter_r", "--zisofs", "/")

    await exec(process.env.USE_SYSTEM_FPM === "true" || process.arch !== "x64" ? "xorriso" : path.join(appImagePath, "xorriso"), args)

    await new BluebirdPromise((resolve, reject) => {
      const rd = createReadStream(path.join(appImagePath, arch === Arch.ia32 ? "32" : "64", "runtime"))
      rd.on("error", reject)
      const wr = createWriteStream(image, {flags: "r+"})
      wr.on("error", reject)
      wr.on("finish", resolve)
      rd.pipe(wr)
    })

    const fd = await open(image, "r+")
    try {
      const magicData = new Buffer([0x41, 0x49, 0x01])
      await write(fd, magicData, 0, magicData.length, 8)
    }
    finally {
      await close(fd)
    }

    await chmod(image, "0755")

    packager.dispatchArtifactCreated(image, packager.generateName("AppImage", arch, true))
  }
}