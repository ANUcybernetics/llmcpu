import { z } from "zod";

/** programs/<name>/program.json */
export const ProgramSchema = z.object({
  title: z.string().min(1),
  blurb: z.string().min(1),
  expected_output: z.string(),
  order: z.number().int().positive(),
});
export type ProgramMeta = z.infer<typeof ProgramSchema>;

/** programs/<name>/lines.json: DWARF line table rows, one per statement address */
export const LinesSchema = z.array(
  z.object({
    addr: z.number().int().nonnegative(),
    line: z.number().int().positive(),
    file: z.string().min(1),
  }),
);
export type LineRow = z.infer<typeof LinesSchema>[number];
