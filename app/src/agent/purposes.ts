import type { z } from "zod";
import type { Purpose } from "../model/routes";
import { CompactionOutputSchema } from "./compaction";
import { TurnOutputSchema } from "./turn";

/** What each purpose's model call must return. */
export const OUTPUTS = { turn: TurnOutputSchema, compaction: CompactionOutputSchema } as const satisfies Readonly<Record<Purpose, z.ZodType>>;
export type Output<P extends Purpose> = z.infer<(typeof OUTPUTS)[P]>;

export const outputOf = <P extends Purpose>(p: P): z.ZodType<Output<P>> => OUTPUTS[p] as unknown as z.ZodType<Output<P>>;
