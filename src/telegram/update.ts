import { z } from "zod";

const id = z.number().int();

export const minimalUpdateSchema = z.object({
  update_id: id,
  message: z.object({ chat: z.object({ id }), from: z.object({ id }).optional() }).optional(),
  callback_query: z
    .object({
      from: z.object({ id }),
      message: z.object({ chat: z.object({ id }) }).optional(),
    })
    .optional(),
});

export type MinimalUpdate = z.infer<typeof minimalUpdateSchema>;

export function senderId(update: MinimalUpdate): number | undefined {
  return update.message?.from?.id ?? update.callback_query?.from.id;
}

export function chatId(update: MinimalUpdate): number | undefined {
  return update.message?.chat.id ?? update.callback_query?.message?.chat.id;
}
