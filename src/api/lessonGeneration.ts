import { ApiError, invokeFunction } from './core'

// AI Lesson Generation through the partners-generate-lesson Edge Function
// (OpenAI, server-side). The function holds the instructions, response
// schema, model, and cost limits; this sends only the lesson's planning form
// (already through the app's privacy gateway) and returns the structured
// lesson. One call per Generate — never retried here.

export type GeneratedObjective = { original: string; text: string; practices: string[] }

export type GeneratedLesson = {
  title: string
  learningObjectives: GeneratedObjective[]
  activities: { sequenceStep: string; title: string; minutes: number; description: string; practiceMoves: string[]; objectives: number[] }[]
  customization: { field: string; howUsed: string }[]
  suggestions: { section: string; flaggedText: string; suggestion: string; addedText: string; summary: string }[]
}

export type GenerationUsage = { model: string; inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null }

export type GenerateLessonResult = { output: GeneratedLesson; warnings: string[]; usage: GenerationUsage }

export async function generateLesson(lesson: unknown): Promise<GenerateLessonResult> {
  const result = await invokeFunction<{ success?: boolean } & Partial<GenerateLessonResult>>('partners-generate-lesson', { lesson })
  if (result?.success !== true || !result.output || !result.usage) {
    throw new ApiError('The AI service returned no lesson.', { code: 'invalid_output' })
  }
  return { output: result.output, warnings: Array.isArray(result.warnings) ? result.warnings : [], usage: result.usage }
}
