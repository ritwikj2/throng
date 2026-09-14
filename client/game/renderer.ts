import type {
  SceneState,
  SceneCreature,
  WorldObject,
  Vec,
  Tool,
  StructureKind,
} from "../../shared/types";
import { HabitatAudio } from "./audio";
import {
  clampToWorld,
  fitProjection,
  hashId,
  keyboardStep,
  pickCreature,
  pointerPoint,
  project,
  spriteScale,
  unproject,
  type Projection,
} from "./geometry";
import { DeathMarks, DEATH_MARK_MS } from "./death";
import { MotionBuffer } from "./interpolation";
import { drawSprite, SpriteAtlas } from "./sprites";
import { makeTerrain } from "./terrain";

export interface WorldCanvasProps {
  world: SceneState;
  selectedId: string | null;
  tool: Tool | StructureKind;
  onSelect: (id: string | null) => void;
  onInteract: (position: Vec, creatureId?: string) => void;
  sound: boolean;
  reducedMotion: boolean;
}
interface Pulse {
  position: Vec;
  at: number;
}
type Entity = { position: Vec; creature?: SceneCreature; object?: WorldObject; egg?: boolean };
const structures = new Set<string>(["feeder", "bath", "carousel", "beacon"]);
const creatureTools = new Set<string>(["feed", "wash", "play", "pet", "kill"]);

export class WorldRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly atlas = new SpriteAtlas();
  private readonly motion = new MotionBuffer();
  private readonly deaths = new DeathMarks();
  private readonly audio = new HabitatAudio();
  private readonly observer: ResizeObserver;
  private projection: Projection;
  private terrain: HTMLCanvasElement | null = null;
  private terrainKey = "";
  private dpr = 1;
  private props: WorldCanvasProps;
  private positions: ReadonlyMap<string, Vec> = new Map();
  private pointer: Vec | null = null;
  private keyboard: Vec | null = null;
  private down: { id: number; position: Vec } | null = null;
  private pulses: Pulse[] = [];
  private frameId = 0;
  private disposed = false;
  private animationTime = 0;
  private lastFrame = 0;
  private renderedTime = 0;
  private lastSnapshotAt = 0;
  private readonly coarse = window.matchMedia("(pointer: coarse)").matches;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly host: HTMLElement,
    props: WorldCanvasProps,
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("A 2D canvas is required to display this meadow.");
    this.context = context;
    this.props = props;
    this.projection = fitProjection(1, 320, props.world.width, props.world.height);
    this.lastSnapshotAt = performance.now();
    this.motion.push(props.world, this.lastSnapshotAt);
    this.deaths.update(props.world, this.lastSnapshotAt);
    this.audio.setEnabled(props.sound);
    this.resize();
    this.observer = new ResizeObserver(() => {
      if (!this.disposed) this.resize();
    });
    this.observer.observe(host);
    canvas.addEventListener("pointerdown", this.pointerDown);
    canvas.addEventListener("pointermove", this.pointerMove);
    canvas.addEventListener("pointerup", this.pointerUp);
    canvas.addEventListener("pointercancel", this.pointerCancel);
    canvas.addEventListener("pointerleave", this.pointerLeave);
    canvas.addEventListener("keydown", this.keyDown);
    canvas.addEventListener("blur", this.blur);
    this.frameId = requestAnimationFrame(this.frame);
  }

  update(props: WorldCanvasProps): void {
    if (this.disposed) return;
    const previous = this.props.world;
    this.props = props;
    if (props.world !== previous) {
      this.lastSnapshotAt = performance.now();
      this.motion.push(props.world, this.lastSnapshotAt);
      this.deaths.update(props.world, this.lastSnapshotAt);
      if (props.world.id !== previous.id || props.world.time < previous.time) {
        this.pulses = [];
        this.pointer = null;
        this.keyboard = null;
        this.down = null;
        this.animationTime = 0;
      }
      if (
        props.world.width !== previous.width ||
        props.world.height !== previous.height ||
        props.world.seed !== previous.seed
      )
        this.resize();
    }
    this.audio.setEnabled(props.sound);
  }

  private resize(): void {
    const box = this.host.getBoundingClientRect();
    const width = Math.max(1, box.width),
      height = Math.max(320, box.height);
    const world = this.props.world;
    this.projection = fitProjection(width, height, world.width, world.height);
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    const pixelsWide = Math.max(1, Math.round(width * this.dpr)),
      pixelsHigh = Math.max(1, Math.round(height * this.dpr));
    if (this.canvas.width !== pixelsWide) this.canvas.width = pixelsWide;
    if (this.canvas.height !== pixelsHigh) this.canvas.height = pixelsHigh;
    const key = `${world.seed}:${world.width}:${world.height}:${width}:${height}`;
    if (key !== this.terrainKey) {
      this.terrainKey = key;
      this.terrain = makeTerrain(this.projection, world.seed, this.dpr);
    }
    this.context.imageSmoothingEnabled = false;
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    // One paint per display frame. Network snapshots never restart this loop.
    this.frameId = requestAnimationFrame(this.frame);
    if (this.dpr !== Math.max(1, window.devicePixelRatio || 1)) this.resize();
    const { world, reducedMotion } = this.props;
    const dt = this.lastFrame ? Math.min(0.08, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (!world.paused && !reducedMotion && now - this.lastSnapshotAt < 1000)
      this.animationTime += dt;
    const sample = this.motion.sample(now);
    this.positions = sample.positions;
    this.renderedTime = sample.time;
    const c = this.context;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalAlpha = 1;
    c.imageSmoothingEnabled = false;
    if (this.terrain)
      c.drawImage(this.terrain, 0, 0, this.projection.width, this.projection.height);
    this.drawDeaths(now);
    const entities: Entity[] = [];
    for (const object of world.objects) {
      if ((object.kind === "apple" || object.kind === "rock") && object.amount <= 0) continue;
      entities.push({ position: object.position, object });
    }
    for (const creature of world.creatures)
      if (creature.alive)
        entities.push({ position: this.positions.get(creature.id) ?? creature.position, creature });
    if (!world.hatched) entities.push({ position: this.center(), egg: true });
    // Ground Y is depth in the rectangular view; X is no longer a depth axis.
    entities.sort(
      (a, b) =>
        a.position.y - b.position.y ||
        Number(Boolean(a.creature)) - Number(Boolean(b.creature)) ||
        (a.creature?.id ?? a.object?.id ?? "").localeCompare(b.creature?.id ?? b.object?.id ?? ""),
    );
    for (const entity of entities) this.shadow(entity);
    this.groundTarget();
    for (const entity of entities) {
      if (entity.creature) this.creature(entity.creature, entity.position);
      else if (entity.object) this.object(entity.object);
      else this.egg(entity.position);
    }
    this.selection();
    this.labels();
    this.preview();
    this.feedback(now);
    this.audio.update(world, now);
  };

  private center(): Vec {
    return { x: this.props.world.width / 2, y: this.props.world.height / 2 };
  }
  private point(position: Vec): Vec {
    return project(position, this.projection);
  }
  private inside(point: Vec): boolean {
    return (
      point.x >= 0 &&
      point.y >= 0 &&
      point.x <= this.projection.width &&
      point.y <= this.projection.height
    );
  }
  private shadow(entity: Entity): void {
    const c = this.context,
      p = this.point(entity.position),
      unit = spriteScale(this.projection);
    const radius = entity.creature
      ? 12
      : entity.object?.kind === "apple"
        ? 5
        : entity.object?.kind === "ball"
          ? 7
          : 17;
    c.fillStyle = "#286521";
    c.fillRect(
      Math.round(p.x - (radius - 3) * unit),
      Math.round(p.y - unit),
      (radius * 2 - 6) * unit,
      5 * unit,
    );
    c.fillRect(Math.round(p.x - radius * unit), Math.round(p.y), radius * 2 * unit, 3 * unit);
  }

  private brackets(position: Vec, color: string, body = false, alpha = 1): void {
    const c = this.context,
      p = this.point(position),
      unit = spriteScale(this.projection);
    const w = Math.round((body ? 33 : 24) * unit),
      h = Math.round((body ? 34 : 12) * unit);
    const left = Math.round(p.x - w / 2),
      top = Math.round(p.y - (body ? 32 : 5) * unit);
    const length = Math.round(5 * unit);
    c.save();
    c.globalAlpha = alpha;
    for (const [offset, stroke] of [
      [1, "#15361c"],
      [0, color],
    ] as const) {
      c.fillStyle = stroke;
      for (const [x, y, dx, dy] of [
        [left, top, 1, 1],
        [left + w, top, -1, 1],
        [left, top + h, 1, -1],
        [left + w, top + h, -1, -1],
      ]) {
        c.fillRect(x! + offset + (dx! < 0 ? -length + 1 : 0), y! + offset, length, 1);
        c.fillRect(x! + offset, y! + offset + (dy! < 0 ? -length + 1 : 0), 1, length);
      }
    }
    c.restore();
  }

  private selection(): void {
    const { world, selectedId, tool } = this.props;
    const selected = world.creatures.find(
      (creature) => creature.id === selectedId && creature.alive,
    );
    if (selected)
      this.brackets(this.positions.get(selected.id) ?? selected.position, "#ffffc9", true);
    if (!this.pointer) return;
    const hovered = pickCreature(this.pointer, world.creatures, this.projection, this.positions);
    if (hovered)
      this.brackets(
        this.positions.get(hovered.id) ?? hovered.position,
        String(tool) === "kill" ? "#ff7954" : "#edf7b4",
        true,
        0.9,
      );
  }

  private target(): Vec | null {
    if (this.keyboard) return this.keyboard;
    if (!this.pointer || !this.inside(this.pointer)) return null;
    if (creatureTools.has(this.props.tool)) {
      const hit = pickCreature(
        this.pointer,
        this.props.world.creatures,
        this.projection,
        this.positions,
      );
      if (hit) return this.positions.get(hit.id) ?? hit.position;
    }
    // The edge grass is interactive too; command positions keep the engine's one-unit margin.
    return clampToWorld(
      unproject(this.pointer, this.projection),
      this.props.world.width,
      this.props.world.height,
    );
  }

  private groundTarget(): void {
    const target = this.target();
    if (!target || !this.props.world.hatched || (!this.keyboard && this.props.tool === "inspect"))
      return;
    this.brackets(target, String(this.props.tool) === "kill" ? "#ff7954" : "#e0efbd", false, 0.8);
  }

  private creature(creature: SceneCreature, position: Vec): void {
    const c = this.context,
      p = this.point(position),
      unit = spriteScale(this.projection);
    const seed = hashId(creature.id),
      clock = this.animationTime + (seed % 101) / 23;
    const phase = Math.floor(clock * (creature.action === "walk" ? 8 : 4)) % 4;
    const animated = !this.props.reducedMotion && !this.props.world.paused;
    const hop = animated && creature.action === "play" ? Math.max(0, Math.sin(clock * 6)) * 3 : 0;
    const stride = animated && creature.action === "walk" ? phase % 2 : 0;
    const blink = clock % (3.5 + (seed % 5) * 0.13) < 0.13;
    drawSprite(
      c,
      this.atlas.creature(creature, phase, blink),
      p.x,
      p.y - (hop + stride) * unit,
      unit,
      creature.facing,
    );
    if (creature.action === "wash") {
      for (let i = 0; i < 3; i++) {
        const rise = animated ? (clock * 0.9 + i / 3) % 1 : i / 3;
        const x = Math.round(p.x + (i - 1) * 10 * unit),
          y = Math.round(p.y - (16 + rise * 19) * unit);
        c.fillStyle = "#b5ecdf";
        c.fillRect(x, y, 3 * unit, 3 * unit);
        c.fillStyle = "#3788ad";
        c.fillRect(x + unit, y + 2 * unit, 2 * unit, unit);
      }
    }
    if (creature.action === "rest")
      drawSprite(c, this.atlas.icon("sleep"), p.x + 13 * unit, p.y - 23 * unit, unit * 0.7);
    if (creature.action === "sing" || creature.action === "socialize") {
      const lift = animated ? (clock % 1.5) * 3 : 2;
      drawSprite(c, this.atlas.icon("note"), p.x - 17 * unit, p.y - (21 + lift) * unit, unit * 0.8);
    }
    if (creature.id === this.props.selectedId && creature.needs.food < 25)
      drawSprite(c, this.atlas.icon("feed"), p.x + 20 * unit, p.y - 13 * unit, unit * 0.7);
  }

  private object(object: WorldObject): void {
    const c = this.context,
      p = this.point(object.position),
      unit = spriteScale(this.projection);
    const active = this.renderedTime - object.lastUsedAt < 2;
    const phase = Math.floor(this.animationTime * (active ? 5 : 1)) % 4;
    const sprite = this.atlas.object(object.kind, phase, object.amount <= 0);
    if (!object.built && structures.has(object.kind)) {
      c.fillStyle = "#68713a";
      c.fillRect(Math.round(p.x - 20 * unit), Math.round(p.y - 8 * unit), 40 * unit, 14 * unit);
      c.save();
      c.globalAlpha = 0.2;
      drawSprite(c, sprite, p.x, p.y, unit);
      c.restore();
      const progress = Math.max(0, Math.min(1, object.progress));
      c.save();
      c.beginPath();
      c.rect(p.x - 25 * unit, p.y - 48 * unit * progress, 50 * unit, 48 * unit * progress + 2);
      c.clip();
      drawSprite(c, sprite, p.x, p.y, unit);
      c.restore();
      c.fillStyle = "#233b22";
      c.fillRect(Math.round(p.x - 18 * unit), Math.round(p.y + 7 * unit), 36 * unit, 4 * unit);
      c.fillStyle = "#e3d53d";
      c.fillRect(
        Math.round(p.x - 17 * unit),
        Math.round(p.y + 8 * unit),
        34 * unit * progress,
        2 * unit,
      );
      return;
    }
    drawSprite(c, sprite, p.x, p.y, unit);
    if (
      object.kind === "beacon" &&
      this.props.world.collective.choirUntil > this.props.world.time
    ) {
      const wave = this.props.reducedMotion ? 3 : Math.floor(this.animationTime * 5) % 5;
      c.fillStyle = "#e6ed99";
      for (const sign of [-1, 1]) {
        const x = Math.round(p.x + sign * (17 + wave * 2) * unit);
        const y = Math.round(p.y - (18 + wave) * unit);
        c.fillRect(x, y, unit, (5 + wave * 2) * unit);
        c.fillRect(x - sign * unit, y - unit, unit, unit);
        c.fillRect(x - sign * unit, y + (5 + wave * 2) * unit, unit, unit);
      }
    }
  }

  private egg(position: Vec): void {
    const p = this.point(position),
      unit = spriteScale(this.projection) * 1.15;
    const bob =
      !this.props.reducedMotion && !this.props.world.paused
        ? Math.floor(this.animationTime * 2) % 2
        : 0;
    drawSprite(this.context, this.atlas.egg(), p.x, p.y - bob * unit, unit);
    this.bubble(this.coarse ? "TAP TO HATCH" : "CLICK TO HATCH", p.x, p.y + 25 * unit, false);
  }

  private bubble(value: string, x: number, y: number, tail = true): void {
    const c = this.context;
    c.font = 'bold 11px "Courier New", monospace';
    const maxWidth = Math.max(24, Math.min(250, this.projection.width - 12));
    let label = value.replace(/\s+/g, " ").slice(0, 90);
    if (c.measureText(label).width > maxWidth - 12) {
      while (label.length && c.measureText(label + "...").width > maxWidth - 12)
        label = label.slice(0, -1);
      label += "...";
    }
    const w = Math.ceil(c.measureText(label).width) + 12;
    const left = Math.round(Math.max(3, Math.min(this.projection.width - w - 3, x - w / 2)));
    const top = Math.round(Math.max(3, Math.min(this.projection.height - 23, y - 20)));
    c.fillStyle = "#1c371c";
    c.fillRect(left + 2, top + 2, w, 20);
    c.fillRect(left, top, w, 20);
    c.fillStyle = "#e8efcf";
    c.fillRect(left + 1, top + 1, w - 2, 18);
    if (tail) {
      const tip = Math.round(Math.max(left + 4, Math.min(left + w - 4, x)));
      c.fillStyle = "#1c371c";
      c.fillRect(tip - 2, top + 20, 5, 2);
      c.fillRect(tip, top + 22, 1, 2);
      c.fillStyle = "#e8efcf";
      c.fillRect(tip - 1, top + 19, 3, 2);
    }
    c.fillStyle = "#1c311c";
    c.textBaseline = "middle";
    c.fillText(label, left + 6, top + 10);
    c.textBaseline = "alphabetic";
  }

  private labels(): void {
    const { world, selectedId } = this.props;
    const unit = spriteScale(this.projection);
    let utterances = 0;
    for (const creature of world.creatures) {
      if (!creature.alive) continue;
      const p = this.point(this.positions.get(creature.id) ?? creature.position);
      if (creature.id === selectedId) {
        const speech = creature.utterance && creature.utterance.until > world.time;
        this.bubble(
          speech
            ? `${creature.name}: ${creature.utterance!.text}`
            : `${creature.name} / ${creature.action}`,
          p.x,
          p.y - 36 * unit,
        );
      } else if (creature.utterance && creature.utterance.until > world.time && utterances < 3) {
        this.bubble(
          creature.utterance.translated ? creature.utterance.text : "♪ ♪",
          p.x,
          p.y - 35 * unit,
        );
        utterances++;
      }
    }
  }

  private preview(): void {
    const target = this.target();
    if (!target || !this.props.world.hatched || this.props.tool === "inspect") return;
    const c = this.context,
      p = this.point(target),
      unit = spriteScale(this.projection),
      tool = this.props.tool;
    c.save();
    c.globalAlpha = 0.65;
    if (structures.has(tool) || tool === "tree")
      drawSprite(c, this.atlas.object(tool as StructureKind | "tree"), p.x, p.y, unit);
    else drawSprite(c, this.atlas.icon(tool as Tool), p.x + 17 * unit, p.y - 12 * unit, unit);
    c.restore();
  }

  private drawDeaths(now: number): void {
    const c = this.context,
      unit = spriteScale(this.projection);
    for (const mark of this.deaths.sample(now)) {
      const age = now - mark.at,
        p = this.point(mark.position);
      c.save();
      c.globalAlpha = Math.min(1, (DEATH_MARK_MS - age) / 450);
      // Already flat and dark; a tiny settling motion can be disabled. No gore or speculative kills.
      const settle = this.props.reducedMotion ? 0 : Math.max(0, 1 - age / 180);
      drawSprite(c, this.atlas.flattened(), p.x, p.y - settle * 2 * unit, unit);
      c.restore();
    }
  }

  private feedback(now: number): void {
    this.pulses = this.pulses.filter((pulse) => now - pulse.at < 450);
    for (const pulse of this.pulses)
      this.brackets(pulse.position, "#f0f8c8", false, 1 - (now - pulse.at) / 450);
  }

  private localPoint(event: PointerEvent): Vec {
    return pointerPoint(
      { x: event.clientX, y: event.clientY },
      this.canvas.getBoundingClientRect(),
      this.projection,
    );
  }
  private pointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0) return;
    const position = this.localPoint(event);
    this.down = { id: event.pointerId, position };
    this.pointer = position;
    this.keyboard = null;
    if (event.pointerType !== "touch") this.canvas.focus({ preventScroll: true });
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* Synthetic events need not own capture. */
    }
  };
  private pointerMove = (event: PointerEvent): void => {
    if (event.isPrimary) {
      this.pointer = this.localPoint(event);
      this.keyboard = null;
    }
  };
  private pointerUp = (event: PointerEvent): void => {
    const down = this.down;
    this.down = null;
    if (!down || down.id !== event.pointerId) return;
    const point = this.localPoint(event);
    if (Math.hypot(point.x - down.position.x, point.y - down.position.y) <= 13)
      this.interact(point, event.pointerType === "touch");
    if (event.pointerType === "touch") this.pointer = null;
    try {
      if (this.canvas.hasPointerCapture(event.pointerId))
        this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* Browser may have released it. */
    }
  };
  private pointerCancel = (): void => {
    this.down = null;
    this.pointer = null;
  };
  private pointerLeave = (): void => {
    if (!this.down) this.pointer = null;
  };
  private blur = (): void => {
    this.keyboard = null;
  };

  private interact(point: Vec, touch: boolean): void {
    if (!this.inside(point)) return;
    const { world, tool, onSelect, onInteract } = this.props;
    const hit = pickCreature(point, world.creatures, this.projection, this.positions, touch);
    this.audio.gesture(tool);
    if (!world.hatched) {
      onInteract(this.center());
      return;
    }
    if (tool === "inspect") {
      onSelect(hit?.id ?? null);
      return;
    }
    const targetCreature = hit && creatureTools.has(tool) ? hit : null;
    const position = targetCreature
      ? (this.positions.get(targetCreature.id) ?? targetCreature.position)
      : clampToWorld(unproject(point, this.projection), world.width, world.height);
    if (targetCreature) onSelect(targetCreature.id);
    onInteract(position, targetCreature?.id);
    // Kill feedback must follow an authoritative alive->dead transition, not this input event.
    if (String(tool) !== "kill") {
      this.pulses.push({ position: { ...position }, at: performance.now() });
      if (this.pulses.length > 24) this.pulses.shift();
    }
  }

  private keyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const { world, selectedId } = this.props;
    if (event.key === "Escape") {
      this.keyboard = null;
      this.props.onSelect(null);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key))
      return;
    event.preventDefault();
    event.stopPropagation();
    const selected = world.creatures.find(
      (creature) => creature.id === selectedId && creature.alive,
    );
    this.keyboard ??= {
      ...(selected ? (this.positions.get(selected.id) ?? selected.position) : this.center()),
    };
    const delta = keyboardStep(event.key, event.shiftKey ? 1.5 : 0.5);
    if (delta)
      this.keyboard = clampToWorld(
        { x: this.keyboard.x + delta.x, y: this.keyboard.y + delta.y },
        world.width,
        world.height,
      );
    else if (!event.repeat) this.interact(this.point(this.keyboard), false);
    this.pointer = null;
  };

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.observer.disconnect();
    this.canvas.removeEventListener("pointerdown", this.pointerDown);
    this.canvas.removeEventListener("pointermove", this.pointerMove);
    this.canvas.removeEventListener("pointerup", this.pointerUp);
    this.canvas.removeEventListener("pointercancel", this.pointerCancel);
    this.canvas.removeEventListener("pointerleave", this.pointerLeave);
    this.canvas.removeEventListener("keydown", this.keyDown);
    this.canvas.removeEventListener("blur", this.blur);
    this.audio.destroy();
    this.atlas.clear();
    this.deaths.clear();
    this.terrain = null;
    this.pulses = [];
    this.positions = new Map();
  }
}
