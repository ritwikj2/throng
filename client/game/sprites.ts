import type { ObjectKind, SceneCreature, Tool } from "../../shared/types";
import { hashId } from "./geometry";

type Paint = CanvasRenderingContext2D;
export interface Sprite {
  image: HTMLCanvasElement;
  anchorX: number;
  anchorY: number;
}
const INK = "#24351c";
const YELLOW = "#ffd52e";
const SHADE = "#d69d19";

function rect(c: Paint, color: string, x: number, y: number, width: number, height: number): void {
  c.fillStyle = color;
  c.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
}
function line(
  c: Paint,
  color: string,
  x: number,
  y: number,
  endX: number,
  endY: number,
  width = 1,
): void {
  x = Math.round(x);
  y = Math.round(y);
  endX = Math.round(endX);
  endY = Math.round(endY);
  const dx = Math.abs(endX - x),
    dy = -Math.abs(endY - y);
  const sx = x < endX ? 1 : -1,
    sy = y < endY ? 1 : -1;
  let error = dx + dy;
  for (;;) {
    rect(c, color, x, y, width, width);
    if (x === endX && y === endY) break;
    const twice = error * 2;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
}
/** Raster ellipses have deliberate hard stair steps, with no canvas antialiasing. */
function oval(c: Paint, color: string, x: number, y: number, width: number, height: number): void {
  for (let row = 0; row < height; row++) {
    const latitude = ((row + 0.5) / height) * 2 - 1;
    const half = (Math.sqrt(Math.max(0, 1 - latitude * latitude)) * width) / 2;
    const left = Math.floor(width / 2 - half),
      right = Math.ceil(width / 2 + half);
    rect(c, color, x + left, y + row, right - left, 1);
  }
}
function make(
  width: number,
  height: number,
  anchorX: number,
  anchorY: number,
  draw: (c: Paint) => void,
): Sprite {
  const image = document.createElement("canvas");
  image.width = width;
  image.height = height;
  const c = image.getContext("2d")!;
  c.imageSmoothingEnabled = false;
  draw(c);
  return { image, anchorX, anchorY };
}
function apple(c: Paint, x: number, y: number): void {
  rect(c, "#473a1c", x + 5, y, 1, 4);
  rect(c, "#204e20", x + 6, y + 1, 4, 2);
  rect(c, "#67b831", x + 6, y + 1, 2, 1);
  oval(c, "#792313", x, y + 3, 11, 10);
  rect(c, "#792313", x + 2, y + 2, 3, 2);
  rect(c, "#792313", x + 6, y + 2, 3, 2);
  oval(c, "#df3420", x + 1, y + 3, 8, 8);
  rect(c, "#f6572b", x + 2, y + 4, 3, 2);
  rect(c, "#ffd8a0", x + 2, y + 4, 1, 2);
  rect(c, "#ab2819", x + 5, y + 10, 3, 2);
}
function ball(c: Paint, x: number, y: number, phase = 0): void {
  oval(c, "#253749", x, y, 14, 14);
  oval(c, "#eceadc", x + 1, y + 1, 12, 12);
  if (phase % 2) {
    rect(c, "#d52b23", x + 2, y + 6, 10, 3);
    rect(c, "#2476cb", x + 6, y + 1, 3, 11);
    rect(c, "#f2c62c", x + 2, y + 3, 4, 3);
  } else {
    rect(c, "#d52b23", x + 6, y + 1, 3, 12);
    rect(c, "#2476cb", x + 2, y + 7, 10, 3);
    rect(c, "#f2c62c", x + 3, y + 2, 3, 4);
  }
  rect(c, "#ffffff", x + 3, y + 2, 2, 2);
}
function heart(c: Paint, x: number, y: number): void {
  rect(c, "#76201f", x + 1, y, 3, 2);
  rect(c, "#76201f", x + 6, y, 3, 2);
  rect(c, "#76201f", x, y + 2, 10, 3);
  rect(c, "#df4541", x + 1, y + 2, 8, 3);
  rect(c, "#df4541", x + 2, y + 5, 6, 1);
  rect(c, "#df4541", x + 3, y + 6, 4, 1);
  rect(c, "#76201f", x + 4, y + 7, 2, 1);
}
function tree(c: Paint, empty: boolean): void {
  rect(c, "#34401e", 19, 28, 10, 19);
  rect(c, "#835322", 20, 29, 8, 18);
  rect(c, "#af7733", 21, 31, 2, 14);
  line(c, "#594322", 22, 43, 15, 47, 2);
  line(c, "#594322", 26, 42, 33, 47, 2);
  if (empty) {
    rect(c, "#27361b", 18, 36, 12, 3);
    rect(c, "#b58a47", 19, 36, 10, 2);
    rect(c, "#493919", 22, 36, 4, 1);
    c.clearRect(18, 0, 12, 36);
    return;
  }
  oval(c, "#193f1b", 4, 8, 39, 29);
  oval(c, "#24551b", 8, 3, 30, 32);
  oval(c, "#337d23", 6, 7, 33, 25);
  oval(c, "#4b9628", 11, 4, 24, 22);
  oval(c, "#58a832", 13, 5, 14, 11);
  oval(c, "#3d9027", 5, 14, 19, 13);
  oval(c, "#276c22", 26, 18, 14, 13);
  rect(c, "#6bbb36", 14, 8, 5, 2);
  rect(c, "#317b23", 19, 17, 4, 3);
  rect(c, "#265d1e", 10, 29, 7, 3);
  rect(c, "#609e29", 31, 12, 4, 2);
}

/** Original artwork drawn at native pixel resolution. No episode assets are bundled. */
export class SpriteAtlas {
  private sprites = new Map<string, Sprite>();
  private get(key: string, create: () => Sprite): Sprite {
    const old = this.sprites.get(key);
    if (old) return old;
    const sprite = create();
    if (this.sprites.size >= 256) this.sprites.delete(this.sprites.keys().next().value!);
    this.sprites.set(key, sprite);
    return sprite;
  }
  clear(): void {
    this.sprites.clear();
  }

  creature(creature: SceneCreature, frame: number, blink: boolean): Sprite {
    const action = creature.action;
    const worried =
      creature.health < 30 ||
      Math.min(creature.needs.food, creature.needs.rest, creature.needs.joy) < 22;
    const dirty = creature.needs.clean < 30;
    const variant = hashId(creature.id) % 2;
    const carried = creature.carried?.kind ?? "";
    frame &= 3;
    return this.get(
      `creature:${action}:${frame}:${blink}:${worried}:${dirty}:${variant}:${carried}`,
      () =>
        make(34, 34, 17, 31, (c) => {
          const color = variant ? "#f5cd2b" : YELLOW;
          const sleeping = action === "rest";
          const bob = !sleeping && frame === 3 && action === "idle" ? 1 : 0;
          const up = action === "sing" || action === "play" || action === "socialize";
          const arms = up ? 11 - (frame % 2) : 19;
          const stride = action === "walk" ? (frame % 2 ? 1 : -1) : 0;
          // Small feet and mitten arms give this sprite a new, compact silhouette.
          rect(c, INK, 8 + stride, 28, 7, 3);
          rect(c, INK, 20 - stride, 28, 7, 3);
          rect(c, SHADE, 9 + stride, 28, 5, 2);
          rect(c, SHADE, 21 - stride, 28, 5, 2);
          if (sleeping) {
            oval(c, INK, 5, 14, 26, 16);
            oval(c, color, 6, 15, 24, 13);
            rect(c, "#ffe761", 10, 16, 14, 2);
            line(c, INK, 10, 22, 14, 23);
            line(c, INK, 20, 23, 24, 22);
            rect(c, SHADE, 15, 26, 5, 1);
            return;
          }
          rect(c, INK, 3, arms, 6, 6);
          rect(c, color, 4, arms + 1, 5, 4);
          rect(c, INK, 26, arms, 5, 6);
          rect(c, color, 26, arms + 1, 4, 4);
          oval(c, INK, 6, 3 + bob, 23, 27 - bob);
          oval(c, color, 7, 4 + bob, 21, 24 - bob);
          rect(c, "#ffe85f", 12, 5 + bob, 10, 2);
          rect(c, "#ffe254", 8, 10 + bob, 2, 8);
          rect(c, SHADE, 26, 13, 1, 10);
          rect(c, SHADE, 23, 24, 3, 2);
          if (blink) {
            rect(c, INK, 10, 16, 6, 1);
            rect(c, INK, 19, 16, 6, 1);
          } else {
            oval(c, "#9f811f", 9, 10 + bob, 8, 11);
            oval(c, "#9f811f", 18, 10 + bob, 8, 11);
            oval(c, "#ffffeb", 9, 10 + bob, 8, 9);
            oval(c, "#ffffeb", 18, 10 + bob, 8, 9);
            rect(c, INK, 13, (worried ? 14 : 12) + bob, 3, 5);
            rect(c, INK, 22, (worried ? 14 : 12) + bob, 3, 5);
            if (worried) {
              line(c, INK, 10, 9, 15, 11);
              line(c, INK, 20, 11, 24, 9);
            }
          }
          if (action === "sing" || action === "socialize") oval(c, INK, 16, 22, 4, 4);
          else if (worried) {
            rect(c, INK, 15, 24, 6, 1);
            rect(c, INK, 16, 23, 4, 1);
          } else {
            rect(c, INK, 16, 24, 4, 1);
            rect(c, INK, 20, 23, 1, 1);
          }
          if (dirty) {
            rect(c, "#827028", 9, 23, 2, 2);
            rect(c, "#827028", 24, 8, 2, 1);
          }
          if (action === "eat") apple(c, 22, 20);
          if (action === "build") {
            rect(c, "#6b481f", 29, 19 - (frame % 2), 2, 9);
            rect(c, "#384444", 25, 17 - (frame % 2), 8, 4);
            rect(c, "#a5b5ad", 26, 17 - (frame % 2), 6, 2);
          }
          if (carried === "wood") {
            rect(c, "#4a3118", 8, 25, 20, 6);
            rect(c, "#ab7231", 9, 26, 18, 4);
            rect(c, "#d8a650", 10, 26, 2, 3);
          } else if (carried === "stone") {
            oval(c, "#3c4b48", 12, 24, 14, 8);
            rect(c, "#98a49c", 15, 25, 8, 3);
          }
        }),
    );
  }

  object(kind: ObjectKind, phase = 0, empty = false): Sprite {
    const frame =
      kind === "ball" || kind === "bath" || kind === "carousel" || kind === "beacon"
        ? phase % 4
        : 0;
    return this.get(`object:${kind}:${frame}:${empty}`, () => {
      if (kind === "apple")
        return make(16, 18, 8, 16, (c) => {
          if (!empty) apple(c, 2, 2);
        });
      if (kind === "ball") return make(18, 18, 9, 16, (c) => ball(c, 2, 2, frame));
      return make(48, 52, 24, 48, (c) => {
        if (kind === "tree") {
          tree(c, empty);
          return;
        }
        if (kind === "rock") {
          rect(c, "#3a4d41", 10, 39, 29, 9);
          rect(c, "#3a4d41", 14, 34, 21, 14);
          rect(c, "#808c83", 12, 39, 24, 7);
          rect(c, "#a3afa3", 15, 35, 18, 7);
          rect(c, "#b8c1ac", 16, 35, 10, 2);
          rect(c, "#657b6b", 30, 39, 6, 7);
          line(c, "#4d6254", 24, 38, 20, 44);
          rect(c, "#385c29", 11, 45, 8, 2);
          return;
        }
        if (kind === "feeder") {
          rect(c, "#413619", 7, 30, 35, 17);
          rect(c, "#8a5927", 8, 32, 33, 14);
          rect(c, "#bf8b42", 8, 30, 33, 4);
          rect(c, "#4f361e", 11, 27, 27, 4);
          rect(c, "#d3a853", 10, 31, 2, 15);
          rect(c, "#d3a853", 36, 31, 2, 15);
          line(c, "#5f401d", 13, 41, 34, 41);
          if (!empty) {
            apple(c, 11, 18);
            apple(c, 26, 19);
          }
          rect(c, "#2b5025", 11, 16, 6, 2);
          rect(c, "#43852a", 15, 15, 3, 2);
          return;
        }
        if (kind === "bath") {
          rect(c, "#314446", 7, 32, 35, 13);
          rect(c, "#314446", 11, 28, 27, 19);
          rect(c, "#8ca5a4", 9, 31, 31, 12);
          rect(c, "#657f80", 12, 41, 26, 5);
          rect(c, "#c9d9cc", 11, 29, 27, 3);
          rect(c, "#1c568a", 12, 32, 25, 9);
          rect(c, "#1b95c4", 13, 33, 23, 7);
          rect(c, "#74d6df", 15 + frame, 34, 9, 1);
          rect(c, "#b2f0ed", 27 - frame, 37, 7, 1);
          rect(c, "#cadbd8", 9, 32, 2, 8);
          rect(c, "#385754", 15, 43, 1, 3);
          rect(c, "#385754", 31, 43, 1, 3);
          return;
        }
        if (kind === "carousel") {
          oval(c, "#354039", 5, 34, 39, 14);
          oval(c, "#bc5729", 6, 33, 37, 12);
          oval(c, "#de7531", 9, 34, 30, 8);
          for (let i = 0; i < 4; i++) {
            const angle = (Math.PI / 2) * i + (frame * Math.PI) / 4;
            const x = Math.round(24 + Math.cos(angle) * 15),
              y = Math.round(39 + Math.sin(angle) * 5);
            line(c, "#275985", 24, 38, x, y, 2);
            line(c, "#223e4f", x, y, x, y - 13, 2);
            line(c, "#dadbb7", x, y - 13, 24, 23, 2);
          }
          rect(c, "#384344", 22, 21, 4, 21);
          rect(c, "#b6c7ad", 23, 21, 2, 17);
          rect(c, "#dedbac", 21, 19, 6, 3);
          return;
        }
        // A built wooden loudspeaker makes colony harmonics visible without a magic crystal.
        rect(c, "#3b331d", 12, 10, 25, 37);
        rect(c, "#875c2d", 13, 11, 23, 34);
        rect(c, "#c18b41", 14, 11, 21, 2);
        rect(c, "#543f25", 33, 13, 3, 32);
        oval(c, "#203434", 16, 24, 16, 16);
        oval(c, "#4c6662", 18, 26, 12, 12);
        oval(c, "#273d3c", 20, 28, 8, 8);
        oval(c, "#a0ac8d", 22, 30, 4, 4);
        rect(c, "#1c3436", 16, 16, 14, 5);
        rect(c, frame % 2 ? "#d5db64" : "#abbc57", 18, 17, 9, 2);
        rect(c, "#293b2f", 12, 46, 6, 3);
        rect(c, "#293b2f", 30, 46, 6, 3);
      });
    });
  }

  egg(): Sprite {
    return this.get("egg", () =>
      make(30, 35, 15, 32, (c) => {
        oval(c, "#29471d", 4, 27, 23, 6);
        oval(c, "#686d36", 5, 3, 21, 28);
        oval(c, "#e8e9cb", 6, 4, 19, 26);
        oval(c, "#ffffdf", 8, 5, 13, 21);
        rect(c, "#b5ba8d", 21, 19, 3, 7);
        rect(c, "#d5a932", 12, 12, 3, 2);
        rect(c, "#ddbc50", 16, 22, 4, 2);
        rect(c, "#c3a23f", 9, 25, 2, 2);
        line(c, "#73794c", 14, 4, 16, 8);
        line(c, "#73794c", 16, 8, 13, 11);
      }),
    );
  }

  flattened(): Sprite {
    return this.get("flattened", () =>
      make(38, 14, 19, 10, (c) => {
        oval(c, "#233f20", 1, 6, 36, 6);
        oval(c, "#55581e", 4, 3, 30, 8);
        rect(c, "#797522", 8, 4, 21, 3);
        rect(c, "#9c9229", 10, 4, 14, 1);
        line(c, "#303c1b", 12, 7, 15, 7);
        line(c, "#303c1b", 22, 7, 25, 7);
        rect(c, "#636122", 2, 7, 6, 2);
        rect(c, "#636122", 30, 7, 6, 2);
      }),
    );
  }

  icon(tool: Tool | "kill" | "note" | "sleep" | "spark" | "heart"): Sprite {
    return this.get(`icon:${tool}`, () =>
      make(22, 24, 11, 21, (c) => {
        if (tool === "feed") apple(c, 5, 5);
        else if (tool === "play") ball(c, 4, 5);
        else if (tool === "pet" || tool === "heart") heart(c, 6, 8);
        else if (tool === "wash") {
          rect(c, "#203b56", 5, 10, 13, 11);
          rect(c, "#9db9c2", 6, 11, 11, 9);
          rect(c, "#ddede5", 6, 11, 2, 8);
          rect(c, "#1779b6", 7, 10, 9, 3);
          line(c, "#50656c", 5, 13, 4, 6);
          line(c, "#50656c", 4, 6, 15, 3);
          rect(c, "#85d7ef", 13, 4, 2, 3);
        } else if (tool === "kill") {
          line(c, "#17231b", 4, 4, 16, 16, 4);
          line(c, "#17231b", 16, 4, 4, 16, 4);
          line(c, "#ee5941", 5, 5, 17, 17, 2);
          line(c, "#ee5941", 17, 5, 5, 17, 2);
        } else if (tool === "note") {
          oval(c, "#173e2d", 5, 16, 6, 4);
          rect(c, "#ecf3a0", 10, 5, 2, 13);
          rect(c, "#ecf3a0", 12, 5, 5, 3);
          rect(c, "#ecf3a0", 16, 8, 2, 2);
        } else if (tool === "sleep") {
          rect(c, "#1e4454", 5, 6, 11, 3);
          line(c, "#1e4454", 13, 9, 5, 17, 3);
          rect(c, "#1e4454", 5, 17, 11, 3);
          rect(c, "#c7e6cf", 6, 6, 8, 1);
        } else {
          rect(c, "#edf5ae", 10, 6, 2, 12);
          rect(c, "#edf5ae", 5, 11, 12, 2);
        }
      }),
    );
  }
}

export function drawSprite(
  c: Paint,
  sprite: Sprite,
  x: number,
  y: number,
  scale: number,
  facing = 1,
): void {
  c.save();
  c.translate(Math.round(x), Math.round(y));
  c.scale(facing, 1);
  c.drawImage(
    sprite.image,
    -sprite.anchorX * scale,
    -sprite.anchorY * scale,
    sprite.image.width * scale,
    sprite.image.height * scale,
  );
  c.restore();
}
