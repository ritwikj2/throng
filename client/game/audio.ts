import type { SceneState, Tool, StructureKind } from "../../shared/types";
import { hashId } from "./geometry";

interface Voice {
  oscillator: OscillatorNode;
  envelope: GainNode;
}

/** Original, quiet pentatonic tones. No context is created before an enabled gesture. */
export class HabitatAudio {
  private context: AudioContext | null = null;
  private enabled = false;
  private disposed = false;
  private voices = new Set<Voice>();
  private heard = new Map<string, number>();
  private lastTone = 0;
  private lastChoir = 0;
  private worldId = "";

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.silence();
      void this.context?.suspend().catch(() => {});
    }
  }

  gesture(tool: Tool | StructureKind): void {
    if (!this.enabled || this.disposed || String(tool) === "kill") return;
    const Constructor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return;
    try {
      this.context ??= new Constructor();
      void this.context
        .resume()
        .then(() => {
          if (this.disposed || !this.enabled) return;
          const pitches = {
            inspect: 330,
            feed: 440,
            wash: 523.25,
            play: 587.33,
            pet: 392,
            tree: 293.66,
            feeder: 392,
            bath: 440,
            carousel: 523.25,
            beacon: 659.25,
          };
          const pitch = pitches[tool as keyof typeof pitches];
          if (pitch) this.tone(pitch, 0.11, 0, 0.025);
        })
        .catch(() => {});
    } catch {
      /* Audio is optional when browser policy or devices refuse it. */
    }
  }

  update(world: SceneState, now: number): void {
    if (this.worldId !== world.id) {
      this.worldId = world.id;
      this.heard.clear();
      this.lastChoir = now;
      this.silence();
    }
    if (!this.enabled || this.context?.state !== "running" || world.paused || !world.hatched)
      return;
    if (world.collective.choirUntil > world.time && now - this.lastChoir > 2800) {
      this.lastChoir = now;
      [261.63, 329.63, 392].forEach((frequency, i) => this.tone(frequency, 0.48, i * 0.12, 0.017));
      return;
    }
    if (now - this.lastTone < 480) return;
    for (const creature of world.creatures) {
      const utterance = creature.utterance;
      if (
        !creature.alive ||
        !utterance ||
        utterance.until < world.time ||
        this.heard.get(creature.id) === utterance.at
      )
        continue;
      const note = [0, 3, 5, 7, 10][hashId(creature.id) % 5]!;
      const frequency = 220 * 2 ** ((note + creature.traits.pitch / 25) / 12);
      this.tone(frequency, 0.16, 0, 0.022);
      this.tone(frequency * 1.12246, 0.12, 0.12, 0.014);
      this.heard.set(creature.id, utterance.at);
      this.lastTone = now;
      break;
    }
    if (this.heard.size > 80) {
      const living = new Set(
        world.creatures.filter((creature) => creature.alive).map((creature) => creature.id),
      );
      for (const id of this.heard.keys()) if (!living.has(id)) this.heard.delete(id);
    }
  }

  private tone(frequency: number, duration: number, delay: number, volume: number): void {
    const context = this.context;
    if (
      !context ||
      !this.enabled ||
      this.disposed ||
      context.state !== "running" ||
      this.voices.size >= 8
    )
      return;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    const at = context.currentTime + delay;
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(frequency, at);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.985, at + duration);
    envelope.gain.setValueAtTime(0, at);
    envelope.gain.linearRampToValueAtTime(volume, at + 0.018);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    oscillator.connect(envelope);
    envelope.connect(context.destination);
    const voice = { oscillator, envelope };
    this.voices.add(voice);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      this.voices.delete(voice);
    };
    oscillator.start(at);
    oscillator.stop(at + duration + 0.025);
  }

  private silence(): void {
    for (const { oscillator, envelope } of this.voices) {
      try {
        oscillator.stop();
      } catch {
        /* An ended oscillator is already silent. */
      }
      oscillator.disconnect();
      envelope.disconnect();
    }
    this.voices.clear();
  }

  destroy(): void {
    this.disposed = true;
    this.enabled = false;
    this.silence();
    this.heard.clear();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
