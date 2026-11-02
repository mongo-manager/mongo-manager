import { z } from 'zod'
import { TagsSchema } from './library'
import {
  PARAM_NAME,
  misplacedPlaceholders,
  paramLiteral,
  placeholdersOf,
  type SnippetParam,
} from '../shell/literals'

/**
 * Phase 3a-2 spec §3.5: a snippet — a shell code template with typed `{{name}}` parameters, private
 * or shared with everyone who may use the shell on the connection. The template and its parameters
 * must agree: every placeholder is declared once, and every default is valid for its type.
 */
export const MAX_SNIPPET_PARAMS = 20
export const MAX_SNIPPET_CODE = 64 * 1024

export const SnippetParamSchema = z.strictObject({
  name: z.string().regex(PARAM_NAME, 'A parameter name uses letters, digits and _ (64 at most)'),
  type: z.enum(['string', 'number', 'boolean', 'ejson']),
  default: z
    .string()
    .max(64 * 1024)
    .optional(),
  required: z.boolean().default(false),
})

const snippetFields = {
  name: z
    .string()
    .max(100)
    .refine((s) => s.trim().length > 0, 'A name is required'),
  tags: TagsSchema.default([]),
  code: z
    .string()
    .min(1, 'The snippet has no code')
    .max(MAX_SNIPPET_CODE, 'A snippet has 64 KiB of code at most'),
  params: z
    .array(SnippetParamSchema)
    .max(MAX_SNIPPET_PARAMS, 'A snippet has 20 parameters at most')
    .default([]),
  shared: z.boolean().default(false),
}

/** The template and its parameters agree (spec §3.5). */
function checkParams(
  value: { code: string; params: Array<z.infer<typeof SnippetParamSchema>> },
  ctx: z.RefinementCtx,
): void {
  const names = new Set<string>()
  value.params.forEach((p, i) => {
    if (names.has(p.name))
      ctx.addIssue({
        code: 'custom',
        path: ['params', i, 'name'],
        message: `The parameter ${p.name} is declared twice`,
      })
    names.add(p.name)
    if (p.default !== undefined && !paramLiteral(p.type, p.default).ok)
      ctx.addIssue({
        code: 'custom',
        path: ['params', i, 'default'],
        message: `The default of ${p.name} is not a valid ${p.type}`,
      })
  })
  for (const name of placeholdersOf(value.code)) {
    if (!names.has(name))
      ctx.addIssue({ code: 'custom', path: ['code'], message: `{{${name}}} is not a declared parameter` })
  }
  // A parameter inside a string, template, regex or comment could end that context (final review I1).
  for (const name of misplacedPlaceholders(value.code))
    ctx.addIssue({
      code: 'custom',
      path: ['code'],
      message: `{{${name}}} is inside a string, template, regular expression or comment; put it where a value goes (its value is quoted for you)`,
    })
}

export const SnippetBodySchema = z.strictObject(snippetFields).superRefine(checkParams)
export type SnippetBody = z.input<typeof SnippetBodySchema>

/** A change: tags left out stay as they are (as for favourites). */
export const SnippetUpdateSchema = z
  .strictObject({ ...snippetFields, tags: TagsSchema.optional() })
  .superRefine(checkParams)

export interface SnippetView {
  id: string
  name: string
  tags: string[]
  code: string
  params: SnippetParam[]
  shared: boolean
  mine: boolean
  owner: string | null
  updatedAt: string
}
