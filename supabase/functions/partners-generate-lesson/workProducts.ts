// Student work products: what students submit for feedback in a lesson's
// (or activity's) one assignment. An assignment has 1–4 work products, each
// with its own title, description, prompt for students, and required inputs,
// and each submitted, revised, and given AI feedback separately
// (student_artifacts.work_product_id).
//
// Saved in the version's content as its product list (a lesson's
// studentProducts, an activity's activity.collection): an item with `inputs`
// is a work product. Versions saved before work products (and the demo) have
// items without `inputs` — the Model and/or Explanation of one submission —
// and read as one work product with id null, exactly as before.
//
// Shared by the AI that suggests work products (lesson generation, upload
// review, practice activities) and by the Student Feedback Page and Class
// Feedback functions that read them.

export const workInputs = ['image', 'name', 'explanation'] as const
export type WorkInput = (typeof workInputs)[number]

export const maxWorkProducts = 4

export type WorkProduct = {
  // null: the version's one pre-work-product assignment.
  id: string | null
  title: string
  description: string
  prompt: string
  inputs: { image: boolean; name: boolean; explanation: boolean }
}

type SavedItem = { id?: unknown; name?: unknown; title?: unknown; description?: unknown; submission?: unknown; inputs?: unknown }

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '')

// A work product's inputs from a saved or suggested list: a model name only
// with a model image; at least an image or an explanation (else null).
export function readInputs(value: unknown): WorkProduct['inputs'] | null {
  if (!Array.isArray(value)) return null
  const image = value.includes('image')
  const explanation = value.includes('explanation')
  return image || explanation ? { image, name: image && value.includes('name'), explanation } : null
}

function savedItems(content: unknown): SavedItem[] {
  const saved = (content && typeof content === 'object' ? content : {}) as { format?: string; activity?: { collection?: unknown }; studentProducts?: unknown }
  const items = saved.format === 'partners-activity/v1' ? saved.activity?.collection : saved.studentProducts
  return (Array.isArray(items) ? items : []).filter((item): item is SavedItem => Boolean(item) && typeof item === 'object')
}

// The Model / Explanation a pre-work-product version asks for: by their ids,
// else by name; neither found means both (as before products could be removed).
export function requiredProducts(content: unknown): { model: boolean; explanation: boolean } {
  const list = savedItems(content)
  const has = (id: string, name: RegExp) => list.some((item) => item.id === id) || list.some((item) => !item.id && name.test(text(item.name, 200)))
  const model = has('model', /model/i)
  const explanation = has('explanation', /explanation/i)
  return model || explanation ? { model, explanation } : { model: true, explanation: true }
}

// The version's work products, in order.
export function workProductsOf(content: unknown): WorkProduct[] {
  const items = savedItems(content)
  if (items.some((item) => Array.isArray(item.inputs))) {
    const seen = new Set<string>()
    const products = items.flatMap((item): WorkProduct[] => {
      const id = text(item.id, 40)
      const inputs = readInputs(item.inputs)
      const prompt = text(item.submission, 2000)
      if (!id || seen.has(id) || !inputs || !prompt) return []
      seen.add(id)
      return [{ id, title: text(item.title, 120) || text(item.name, 120) || 'Work product', description: text(item.description, 1000), prompt, inputs }]
    })
    if (products.length > 0) return products.slice(0, maxWorkProducts)
  }
  const required = requiredProducts(content)
  const prompts = items.filter((item) => text(item.name, 200) && text(item.submission, 1000))
  return [
    {
      id: null,
      title: required.model && required.explanation ? 'Model and Explanation' : required.model ? 'Model' : 'Explanation',
      description: '',
      prompt: prompts.map((item) => `${text(item.name, 200)}: ${text(item.submission, 1000)}`).join('\n'),
      inputs: { image: required.model, name: required.model, explanation: required.explanation },
    },
  ]
}

// The work product a request names: by id, or (a pre-work-product version)
// none at all. null when the version has no such work product.
export function findWorkProduct(content: unknown, id: unknown): WorkProduct | null {
  const products = workProductsOf(content)
  if (products[0].id === null) return id == null ? products[0] : null
  return typeof id === 'string' ? (products.find((product) => product.id === id) ?? null) : null
}

// What a work product requires, in words (for the AI).
export function requiredWork(product: WorkProduct): string[] {
  return [product.inputs.image && 'model image', product.inputs.name && 'model name', product.inputs.explanation && 'written explanation'].filter(
    (item): item is string => Boolean(item),
  )
}

// ---------------------------------------------------------------------------
// AI suggestions (the teacher reviews and edits them before confirming)
// ---------------------------------------------------------------------------

export type SuggestedWorkProduct = { title: string; description: string; prompt: string; inputs: WorkInput[] }

export const workProductSuggestionSchema = {
  type: 'array',
  maxItems: maxWorkProducts,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'description', 'prompt', 'inputs'],
    properties: {
      title: { type: 'string' },
      description: { type: 'string' },
      prompt: { type: 'string' },
      inputs: { type: 'array', items: { type: 'string', enum: [...workInputs] } },
    },
  },
} as const

export const workProductSuggestionInstructions = [
  'Student work products:',
  `workProducts: the student work for the lesson's one assignment — what students submit, revise, and get feedback on. Choose the number (1 to ${maxWorkProducts}, usually 1 or 2) and kinds that fit the lesson's activities, practice-oriented learning objectives, and science practices. Each is a separate piece of work students submit and revise on its own (for example a Mechanistic Model and a Systemic Model), never just a field of another one.`,
  'title: a short name students see on its tab (for example "Mechanistic Model"). description: one sentence for the teacher on what this work shows. prompt: what students do, in 1–3 sentences for the grade level, grounded in the lesson’s phenomenon and activities — never the answer.',
  'inputs: what students submit for it: "image" (a photo of a model they drew), "name" (a title for that model; only with "image"), "explanation" (written text). Developing and using models: "image" and "name", usually with "explanation". Constructing explanations or arguing from evidence: "explanation".',
  'The teacher reviews and edits these before students see them.',
].join('\n')

// The AI's suggestions, kept only where they're usable; never fails the
// lesson (an empty list means the app's default).
export function readSuggestedWorkProducts(value: unknown): SuggestedWorkProduct[] {
  const seen = new Set<string>()
  return (Array.isArray(value) ? value : []).flatMap((item): SuggestedWorkProduct[] => {
    const title = text(item?.title, 120)
    const prompt = text(item?.prompt, 2000)
    const inputs = readInputs(item?.inputs)
    if (!title || !prompt || !inputs || seen.has(title.toLowerCase())) return []
    seen.add(title.toLowerCase())
    return [{ title, description: text(item?.description, 1000), prompt, inputs: workInputs.filter((input) => inputs[input]) }]
  }).slice(0, maxWorkProducts)
}
