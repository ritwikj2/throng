import { z } from "zod";
const position = z
  .object({ x: z.number().finite().min(0).max(32), y: z.number().finite().min(0).max(24) })
  .strict();
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hatch") }).strict(),
  z
    .object({
      type: z.literal("care"),
      tool: z.enum(["feed", "wash", "play", "pet", "tree", "kill"]),
      position,
      creatureId: z.string().max(100).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("speed"),
      speed: z.union([z.literal(1), z.literal(4), z.literal(12)]),
    })
    .strict(),
  z.object({ type: z.literal("pause"), paused: z.boolean() }).strict(),
  z
    .object({
      type: z.literal("build"),
      kind: z.enum(["feeder", "bath", "carousel", "beacon"]),
      position,
    })
    .strict(),
  z.object({ type: z.literal("capacity") }).strict(),
  z.object({ type: z.literal("message"), text: z.string().trim().min(1).max(280) }).strict(),
]);
export const newColonySchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    seed: z.number().int().min(0).max(2147483647).optional(),
  })
  .strict();
