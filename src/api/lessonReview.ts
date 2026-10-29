import { ApiError, invokeFunction } from './core'
import type { GenerationUsage, SuggestedWorkProduct } from './lessonGeneration'

// AI review of an uploaded lesson through the partners-review-lesson Edge
// Function: where each section starts, and revision suggestions. The lesson
// text itself is never rewritten. One call per upload, never retried here.

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
