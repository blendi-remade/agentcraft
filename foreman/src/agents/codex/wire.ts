// Zod schemas for the Codex app-server wire format. The server adds fields between
// releases, so objects are loose (extra keys are kept, never trusted); every field
// this code reads is validated at the boundary instead of being cast to `any`.
import { z } from 'zod';

function loose<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).loose();
}

/** Parse a wire value with a default when the server sends something unexpected. */
export function parsed<T>(schema: z.ZodType<T>, value: unknown, fallback: NoInfer<T>): T {
  const result = schema.safeParse(value);
  return result.success ? result.data : fallback;
}

/** Parse a wire value that this code cannot continue without. */
export function required<T>(schema: z.ZodType<T>, value: unknown, method: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues.map((issue: { path: PropertyKey[] }) => issue.path.join('.') || 'input').join(', ');
    throw new Error(`codex ${method}: unexpected response (${fields})`);
  }
  return result.data;
}

export const ConfigReadSchema = loose({
  config: loose({
    model: z.string().nullish(),
    mcp_servers: z.record(z.string(), z.unknown()).nullish(),
    plugins: z.record(z.string(), z.unknown()).nullish(),
  }).nullish(),
});
export type UserConfig = NonNullable<z.infer<typeof ConfigReadSchema>['config']>;

export const AccountReadSchema = loose({
  account: loose({
    type: z.string().nullish(),
    planType: z.string().nullish(),
  }).nullish(),
  requiresOpenaiAuth: z.boolean().nullish(),
});

export const ThreadSchema = loose({
  thread: loose({ id: z.string() }),
  model: z.string().optional(),
});

export const TurnSchema = loose({
  turn: loose({ id: z.string().nullish() }).nullish(),
});

/** Fields read from app-server notifications. */
export const NotificationSchema = loose({
  threadId: z.string().nullish(),
  turn: loose({ id: z.string().nullish() }).nullish(),
});

/** Fields read from app-server requests (approvals, dynamic tools, elicitation). */
export const RequestSchema = loose({
  threadId: z.string().nullish(),
  kind: z.string().nullish(),
  command: z.string().nullish(),
  reason: z.string().nullish(),
  itemId: z.string().nullish(),
  grantRoot: z.string().nullish(),
  tool: z.string().nullish(),
  arguments: z.unknown().optional(),
  questions: z.array(loose({ id: z.string() })).nullish(),
});

export const ChangeSchema = loose({
  path: z.string(),
  diff: z.string().nullish(),
  kind: loose({ type: z.string().nullish() }).nullish(),
});

export const ContentItemSchema = loose({ text: z.string().nullish() });

/** A stream item. Unknown fields are preserved so logging stays faithful. */
export const ItemSchema = loose({
  type: z.string(),
  id: z.string(),
  command: z.string().nullish(),
  changes: z.array(ChangeSchema).nullish(),
  arguments: z.record(z.string(), z.unknown()).nullish(),
  text: z.string().nullish(),
  phase: z.string().nullish(),
  aggregatedOutput: z.string().nullish(),
  status: z.string().nullish(),
  exitCode: z.number().nullish(),
  contentItems: z.array(ContentItemSchema).nullish(),
  success: z.boolean().nullish(),
  summary: z.array(z.string()).nullish(),
  server: z.string().nullish(),
  tool: z.string().nullish(),
  query: z.string().nullish(),
});
export type Item = z.infer<typeof ItemSchema>;

/** Fields read from each app-server notification handled by the stream mapper. */
export const StreamParamsSchema = loose({
  item: ItemSchema.nullish(),
  tokenUsage: loose({ last: loose({ totalTokens: z.number().nullish() }).nullish() }).nullish(),
  error: loose({
    message: z.string().nullish(),
    codexErrorInfo: z.string().nullish(),
  }).nullish(),
  willRetry: z.boolean().nullish(),
  rateLimits: loose({ rateLimitReachedType: z.string().nullish() }).nullish(),
  turn: loose({
    status: z.string().nullish(),
    error: loose({
      message: z.string().nullish(),
      codexErrorInfo: z.string().nullish(),
    }).nullish(),
  }).nullish(),
});
