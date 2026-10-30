import { ApiError, invokeFunction } from './core'
import type { GenerationUsage, SuggestedWorkProduct } from './lessonGeneration'

// AI review of an uploaded lesson through the partners-review-lesson Edge
// Function: where each section starts (revision suggestions come from the
// separate AI Review below). The lesson text itself is never rewritten. One
// call per upload, never retried here.

export type LessonReview = {
  title: string
  topic: string
  gradeLevel: string
  sections: { label: string; startsWith: string }[]
  suggestions: { section: string; flaggedText: string; suggestion: string; addedText: string; summary: string }[]
  // Empty or absent: the app's default student work.
  workProducts?: SuggestedWorkProduct[]
}

export async function reviewUploadedLesson(input: { lessonText: string; fileName: string; gradeLevel: string }): Promise<{
  output: LessonReview
  warnings: string[]
  usage: GenerationUsage
}> {
  const result = await invokeFunction<{ success?: boolean; output?: LessonReview; warnings?: string[]; usage?: GenerationUsage }>('partners-review-lesson', input)
  if (result?.success !== true || !result.output || !result.usage) throw new ApiError('The AI service returned no review.', { code: 'invalid_output' })
  return { output: result.output, warnings: Array.isArray(result.warnings) ? result.warnings : [], usage: result.usage }
}

// ---------------------------------------------------------------------------
// The AI Review: an independent evaluation of a saved lesson (after Form-Based
// Generation, Brainstorm Generation, or Upload, or on Run AI Review) through
// the same function, action "evaluate". At most one suggestion per section
// and five in all; none when nothing meaningful needs to change. One call,
// never retried here.
// ---------------------------------------------------------------------------

export type AiReviewInput = {
  title: string
  gradeLevel: string
  topic: string
  objectives: string[]
  sciencePractices: string[]
  standards: string[]
  sections: { label: string; text: string }[]
  workProducts: { title: string; prompt: string; inputs: string[] }[]
}

export type AiReviewSuggestion = { section: string; criterion: string; flaggedText: string; suggestion: string; addedText: string; summary: string }

export async function evaluateLesson(input: AiReviewInput): Promise<{ suggestions: AiReviewSuggestion[]; usage: GenerationUsage | null }> {
  const result = await invokeFunction<{ success?: boolean; output?: { suggestions?: AiReviewSuggestion[] }; usage?: GenerationUsage }>('partners-review-lesson', { action: 'evaluate', ...input })
  if (result?.success !== true || !Array.isArray(result.output?.suggestions)) throw new ApiError('The AI service returned no review.', { code: 'invalid_output' })
  return { suggestions: result.output.suggestions, usage: result.usage ?? null }
}
