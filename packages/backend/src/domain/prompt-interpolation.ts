/**
 * Pure string-interpolation utilities for prompt templates.
 *
 * Graph fallback prompts use `{single-brace}` syntax (interpolated by
 * `interpolate()`). Langfuse uses `{{double-brace}}` Mustache syntax, so
 * `toMustache()` converts before passing fallbacks to the SDK.
 */

export function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string): string => {
    if (key in variables) return variables[key]!
    return match
  })
}

export function toMustache(template: string): string {
  return template.replace(/(?<!\{)\{(\w+)\}(?!\})/g, '{{$1}}')
}
