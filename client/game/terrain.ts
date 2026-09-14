import { hash, type Projection } from "./geometry";

export const MEADOW_GREEN = "#439b30";

/** Entire viewport is meadow. Paint once at a coarse raster size, then cache it. */
export function makeTerrain(projection: Projection, seed: number, _dpr: number): HTMLCanvasElement {
  const image = document.createElement("canvas");
  const pixel = Math.max(2, Math.round(projection.scale * 2));
  image.width = Math.max(1, Math.ceil(projection.width / pixel));
  image.height = Math.max(1, Math.ceil(projection.height / pixel));
  const c = image.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  c.fillStyle = MEADOW_GREEN;
  c.fillRect(0, 0, image.width, image.height);
  // Irregular, stepped patches. No tile outlines, horizon, vignette, or island sides.
  for (let y = -12; y < image.height + 12; y += 17) {
    for (let x = -12; x < image.width + 12; x += 21) {
      const n = hash(seed, x, y);
      if (n % 5 === 0) continue;
      const px = x + (n % 11),
        py = y + ((n >>> 5) % 9);
      const w = 8 + ((n >>> 9) % 15),
        h = 3 + ((n >>> 15) % 7);
      c.fillStyle = ["#39922b", "#3c952c", "#4aa334", "#40972c"][(n >>> 20) % 4]!;
      c.fillRect(px + 3, py, w - 6, h + 4);
      c.fillRect(px, py + 2, w, h);
      c.fillRect(px + w - 6, py + h + 2, 9, 2);
      c.fillStyle = "#378a29";
      if (n % 3 === 0) {
        c.fillRect(px + 2, py + h - 1, 5, 1);
        c.fillRect(px + 4, py + h - 3, 1, 3);
      }
    }
  }
  for (let y = 3; y < image.height; y += 7) {
    for (let x = 3; x < image.width; x += 9) {
      const n = hash(seed + 219, x, y);
      const px = x + (n % 6),
        py = y + ((n >>> 4) % 5);
      if (n % 3 === 0) {
        c.fillStyle = "#2d8127";
        c.fillRect(px, py, 1, 2);
        c.fillRect(px + 2, py + 1, 1, 2);
        c.fillStyle = "#58aa39";
        c.fillRect(px - 1, py + 1, 1, 1);
      } else if (n % 4 === 0) {
        c.fillStyle = "#55a936";
        c.fillRect(px, py, 2, 1);
      }
      if (n % 83 === 0) {
        c.fillStyle = "#255e24";
        c.fillRect(px, py, 1, 3);
        c.fillStyle = "#e2df69";
        c.fillRect(px - 1, py, 3, 1);
        c.fillStyle = "#fbf4b0";
        c.fillRect(px, py - 1, 1, 2);
      }
    }
  }
  return image;
}
