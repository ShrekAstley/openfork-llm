import { GameMapType } from "@openfront/engine-api/game/GameTypes";
import type { MapManifest } from "@openfront/engine-api/game/MapFiles";
import type { GameMapLoader, MapData } from "@openfront/shared/GameMapLoader";
import fs from "fs";
import path from "path";

/** Map files from a directory laid out like resources/maps (dev checkout). */
export class FsMapLoader implements GameMapLoader {
  constructor(private root: string) {}

  getMapData(map: GameMapType): MapData {
    const key = Object.keys(GameMapType).find(
      (k) => GameMapType[k as keyof typeof GameMapType] === map,
    );
    if (!key) throw new Error(`unknown map ${map}`);
    const dir = path.join(this.root, key.toLowerCase());
    const bin = (name: string) => async () =>
      new Uint8Array(fs.readFileSync(path.join(dir, name)));
    return {
      mapBin: bin("map.bin"),
      map4xBin: bin("map4x.bin"),
      map16xBin: bin("map16x.bin"),
      manifest: async () =>
        JSON.parse(
          fs.readFileSync(path.join(dir, "manifest.json"), "utf8"),
        ) as MapManifest,
      webpPath: "",
      layerPng: async () => {
        throw new Error("the Brain Host never renders map layers");
      },
    };
  }
}
