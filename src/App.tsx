import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
  type SetStateAction,
} from 'react'
import './App.css'

type PageId =
  | 'login'
  | 'class-setup'
  | 'library'
  | 'lesson-generator'
  | 'student-feedback'
  | 'class-feedback-dashboard'

// The lesson workspace (generated lesson, AI suggestions, revisions, Edit
// Lesson) lives inside Lesson Planning — there's no separate nav page for it.
// `title` overrides `label` for the page heading when the two differ. The
// mock Login page renders full-screen (no header or page heading), but stays
// in the nav so demos can get back to it.
const PAGE_CONFIG: readonly { id: PageId; label: string; title?: string }[] = [
  { id: 'login', label: 'Mock Login' },
  { id: 'class-setup', label: 'Class Setup' },
  { id: 'lesson-generator', label: 'Lesson Planning' },
  { id: 'student-feedback', label: 'Student Feedback' },
  { id: 'class-feedback-dashboard', label: 'Class Feedback' },
  { id: 'library', label: 'Library', title: 'My Lesson Library' },
]

// Mock teacher accounts — no real authentication. The demo account is a
// returning teacher who already has classes; any other email is a new
// account that goes through onboarding first.
const DEMO_TEACHER_EMAIL = 'demo@partners.edu'

// The states PARTNERS currently serves; each has its own standards framework.
type TeacherState = 'MO' | 'NC'

const teacherStateOptions: { id: TeacherState; name: string }[] = [
  { id: 'MO', name: 'Missouri' },
  { id: 'NC', name: 'North Carolina' },
]

// `state` and `district` are captured when the account is created; an
// account made by a first login (no Create Account form) has neither yet.
type TeacherAccount = { email: string; onboardingComplete: boolean; state: TeacherState | null; district: string }

type MockLoginCredentials = {
  email: string
  password: string
  mode: 'login' | 'create'
  state?: TeacherState | ''
  district?: string
}

// Where a teacher lands after logging in: always Class Setup. First-time
// teachers get the onboarding guide there (class → roster → Lesson
// Planning); returning teachers see their classes and can go anywhere from
// the sidebar.
function getPostLoginPage(): PageId {
  return 'class-setup'
}

function getInitialPage(): PageId {
  // A Student Feedback link carries its assignment after "?".
  const hash = window.location.hash.replace('#', '').split('?')[0]
  // Old links to the retired standalone Lesson Workspace page land on
  // Lesson Planning, where that workspace now lives.
  if (hash === 'lesson-workspace') return 'lesson-generator'
  // Class Setup was briefly called Class Management.
  if (hash === 'class-management') return 'class-setup'
  const match = PAGE_CONFIG.find((page) => page.id === hash)
  return match ? match.id : 'login'
}

// The three ways to start a lesson on the left of Lesson Planning.
type PlanningMethod = 'create' | 'upload' | 'brainstorm'

// What the left panel shows under its three buttons: nothing yet ('none'),
// one of the methods, or — while a lesson section's revision conversation
// is open from the lesson on the right — that conversation ('revision').
type PlanningTab = 'none' | PlanningMethod | 'revision'

const planningMethods: { id: PlanningMethod; label: string; description: string; icon: string }[] = [
  { id: 'create', label: 'Create a new lesson', description: 'Fill in the lesson form', icon: '✎' },
  { id: 'upload', label: 'Upload an existing lesson', description: 'Get AI-supported review', icon: '⇪' },
  { id: 'brainstorm', label: 'Brainstorm with AI', description: 'Answer questions to fill the form', icon: '✦' },
]

// Teacher-facing practice options for the planning Form. Labels and
// descriptions are deliberately plain-language ("Do not require teachers to
// understand the term 'epistemic practice'") — the id is how the prototype
// still represents each one conceptually as an epistemic practice elsewhere
// (e.g. lessonPractices, the bold terms inside the generated lesson).
type PracticeOption = { id: string; label: string; description: string }

const practiceOptions: PracticeOption[] = [
  {
    id: 'modeling',
    label: 'Develop and Use Models',
    description: 'Students build a model to represent their current thinking, then test and revise it as they learn more.',
  },
  {
    id: 'explanation',
    label: 'Construct Explanations',
    description: 'Students connect a claim to evidence with clear reasoning about why it’s true.',
  },
  {
    id: 'argumentation',
    label: 'Engage in Argument from Evidence',
    description: 'Students defend their thinking and weigh alternative ideas using evidence.',
  },
]

const pacingOptions = [
  { id: '45', label: '45 min' },
  { id: '60', label: '60 min' },
  { id: '90', label: '90 min' },
  { id: 'custom', label: 'Custom' },
] as const

// The lesson length in minutes for a Pacing / Duration choice: a preset's
// own value, or the teacher's custom minutes (null until it's a positive
// number).
function durationMinutes(selection: string, customMinutes: string): number | null {
  const minutes = selection === 'custom' ? Number(customMinutes) : Number(selection)
  return selection !== '' && Number.isFinite(minutes) && minutes > 0 ? minutes : null
}

// The attached authentic student model — used as the primary example
// student artifact throughout Class Feedback. Lives in /public so a
// missing file degrades to a broken-image icon instead of failing the
// build; drop the real file at public/zombie-fires-student-model.png.
const ZOMBIE_FIRES_STUDENT_MODEL_IMAGE = '/zombie-fires-student-model.png'

// Science standards for the Standards field and its suggestions.
//
// Only verified standards belong here: each entry's code and description
// match the official text at `sourceUrl` word for word (checked on
// `verifiedOn`). A framework without verified data yet (Missouri, North
// Carolina) simply has no entries, and the form says so rather than showing
// guessed standards. In production this list comes from the standards
// database (see docs/proposed/), which is loaded only through a reviewed,
// source-cited import — never AI-generated.
type StandardsFrameworkId = 'NGSS' | 'MO' | 'NC'

const standardsFrameworks: { id: StandardsFrameworkId; name: string; fullName: string }[] = [
  { id: 'NGSS', name: 'NGSS', fullName: 'Next Generation Science Standards' },
  { id: 'MO', name: 'Missouri', fullName: 'Missouri Learning Standards (Science)' },
  { id: 'NC', name: 'North Carolina', fullName: 'North Carolina Standard Course of Study (Science)' },
]

const standardsFrameworkName = (id: StandardsFrameworkId) => standardsFrameworks.find((framework) => framework.id === id)?.name ?? id

// Middle and high school only.
type StandardsGradeBand = '6-8' | '9-12'

type ScienceStandard = {
  code: string
  description: string
  framework: StandardsFrameworkId
  gradeBand: StandardsGradeBand
  // Extra plain-language search terms beyond the code/description.
  keywords: readonly string[]
  sourceUrl: string
  verifiedOn: string
}

// Maps the Lesson Planning form's own "Grade level" options onto the grade
// band standards are filtered by — so the teacher is never asked to pick a
// grade level a second time.
const gradeLevelToStandardsBand: Partial<Record<string, StandardsGradeBand>> = {
  '6-8': '6-8',
  '9-12': '9-12',
}

const ngssSource = (slug: string) => `https://www.nextgenscience.org/pe/${slug}`

const scienceStandardsBank: ScienceStandard[] = [
  {
    code: 'MS-LS2-1',
    description:
      'Analyze and interpret data to provide evidence for the effects of resource availability on organisms and populations of organisms in an ecosystem.',
    framework: 'NGSS',
    gradeBand: '6-8',
    keywords: ['ecosystem', 'population', 'resources', 'data'],
    sourceUrl: ngssSource('ms-ls2-1-ecosystems-interactions-energy-and-dynamics'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'MS-LS2-3',
    description: 'Develop a model to describe the cycling of matter and flow of energy among living and nonliving parts of an ecosystem.',
    framework: 'NGSS',
    gradeBand: '6-8',
    keywords: ['ecosystem', 'energy', 'matter', 'model', 'cycling'],
    sourceUrl: ngssSource('ms-ls2-3-ecosystems-interactions-energy-and-dynamics'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'MS-PS3-3',
    description: 'Apply scientific principles to design, construct, and test a device that either minimizes or maximizes thermal energy transfer.',
    framework: 'NGSS',
    gradeBand: '6-8',
    keywords: ['energy', 'heat', 'design', 'engineering'],
    sourceUrl: ngssSource('ms-ps3-3-energy'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'MS-ESS3-3',
    description: 'Apply scientific principles to design a method for monitoring and minimizing a human impact on the environment.',
    framework: 'NGSS',
    gradeBand: '6-8',
    keywords: ['environment', 'human impact', 'sustainability'],
    sourceUrl: ngssSource('ms-ess3-3-earth-and-human-activity'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-LS2-3',
    description:
      'Construct and revise an explanation based on evidence for the cycling of matter and flow of energy in aerobic and anaerobic conditions.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['ecosystem', 'energy', 'matter', 'cycling', 'evidence', 'peat', 'permafrost', 'zombie fire'],
    sourceUrl: ngssSource('hs-ls2-3-ecosystems-interactions-energy-and-dynamics'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-LS2-4',
    description: 'Use mathematical representations to support claims for the cycling of matter and flow of energy among organisms in an ecosystem.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['ecosystem', 'energy', 'matter', 'mathematical', 'zombie fire'],
    sourceUrl: ngssSource('hs-ls2-4-ecosystems-interactions-energy-and-dynamics'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-LS2-5',
    description:
      'Develop a model to illustrate the role of photosynthesis and cellular respiration in the cycling of carbon among the biosphere, atmosphere, hydrosphere, and geosphere.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['carbon cycle', 'biosphere', 'atmosphere', 'model', 'zombie fire'],
    sourceUrl: ngssSource('hs-ls2-5-ecosystems-interactions-energy-and-dynamics'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-LS1-5',
    description: 'Use a model to illustrate how photosynthesis transforms light energy into stored chemical energy.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['photosynthesis', 'energy', 'model', 'cells', 'matter'],
    sourceUrl: ngssSource('hs-ls1-5-molecules-organisms-structures-and-processes'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-LS1-6',
    description:
      'Construct and revise an explanation based on evidence for how carbon, hydrogen, and oxygen from sugar molecules may combine with other elements to form amino acids and/or other large carbon-based molecules.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['carbon', 'matter', 'molecules', 'explanation', 'peat'],
    sourceUrl: ngssSource('hs-ls1-6-molecules-organisms-structures-and-processes'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-LS1-7',
    description:
      'Use a model to illustrate that cellular respiration is a chemical process whereby the bonds of food molecules and oxygen molecules are broken and the bonds in new compounds are formed resulting in a net transfer of energy.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['respiration', 'combustion', 'energy transfer', 'model', 'matter'],
    sourceUrl: ngssSource('hs-ls1-7-molecules-organisms-structures-and-processes'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-PS3-1',
    description:
      'Create a computational model to calculate the change in the energy of one component in a system when the change in energy of the other component(s) and energy flows in and out of the system are known.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['energy', 'system', 'computational', 'model'],
    sourceUrl: ngssSource('hs-ps3-1-energy'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-ESS2-6',
    description: 'Develop a quantitative model to describe the cycling of carbon among the hydrosphere, atmosphere, geosphere, and biosphere.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['carbon', 'cycling', 'earth', 'model', 'permafrost', 'zombie fire', 'wildfire'],
    sourceUrl: ngssSource('hs-ess2-6-earths-systems'),
    verifiedOn: '2026-10-13',
  },
  {
    code: 'HS-ETS1-2',
    description:
      'Design a solution to a complex real-world problem by breaking it down into smaller, more manageable problems that can be solved through engineering.',
    framework: 'NGSS',
    gradeBand: '9-12',
    keywords: ['engineering', 'design', 'problem-solving', 'real-world', 'human impact'],
    sourceUrl: ngssSource('hs-ets1-2-engineering-design'),
    verifiedOn: '2026-10-13',
  },
]

// A standard's description cut to about one line for the suggestions
// dropdown; the full text is in the option's tooltip.
function shortenStandardDescription(description: string, max = 110): string {
  if (description.length <= max) return description
  const cut = description.slice(0, max)
  return `${cut.slice(0, cut.lastIndexOf(' '))}…`
}

function standardsFor(framework: StandardsFrameworkId, gradeLevel: string): ScienceStandard[] {
  const band = gradeLevelToStandardsBand[gradeLevel]
  return band ? scienceStandardsBank.filter((standard) => standard.framework === framework && standard.gradeBand === band) : []
}

const topicStopWords = new Set([
  'about', 'activity', 'after', 'also', 'from', 'have', 'into', 'lesson', 'more', 'students', 'such', 'that', 'their',
  'them', 'then', 'they', 'this', 'unit', 'using', 'what', 'when', 'with', 'will', 'your',
])

function topicTerms(topic: string): string[] {
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !topicStopWords.has(word))
    .map((word) => (word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))
  return Array.from(new Set(words))
}

// Standards related to the lesson topic, for the chosen framework and grade
// band, ranked by how many topic terms they share (keyword matches count
// double). A standard that shares nothing with the topic is never suggested.
function suggestStandards(
  framework: StandardsFrameworkId,
  gradeLevel: string,
  topic: string,
  exclude: readonly string[],
  limit = 4,
): ScienceStandard[] {
  const terms = topicTerms(topic)
  if (terms.length === 0) return []
  return standardsFor(framework, gradeLevel)
    .filter((standard) => !exclude.includes(standard.code))
    .map((standard) => ({
      standard,
      score: terms.reduce(
        (total, term) =>
          total +
          (standard.keywords.some((keyword) => keyword.toLowerCase().includes(term)) ? 2 : 0) +
          (standard.description.toLowerCase().includes(term) ? 1 : 0),
        0,
      ),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.standard)
}

// A standard attached to a lesson: a verified one by its code, or text the
// teacher entered themselves (kept separate — it never enters the
// standards database).
type LessonStandardRef = { code: string; framework: StandardsFrameworkId; custom: boolean }

function matchesStandardsQuery(standard: ScienceStandard, query: string): boolean {
  if (!query) return true
  const normalizedQuery = query.toLowerCase()
  return (
    standard.code.toLowerCase().includes(normalizedQuery) ||
    standard.description.toLowerCase().includes(normalizedQuery) ||
    standard.keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery))
  )
}

const metricCards = [
  { label: 'Submissions', value: '128', trend: '+14%' },
  { label: 'Average Time on Task', value: '27 min', trend: '+5 min' },
  { label: 'Resubmissions', value: '24', trend: '+7' },
  { label: 'AI Feedback Requests', value: '41', trend: '+9' },
]

const dashboardTask = {
  topic: 'Zombie Fires: Matter and Energy Flow',
  question:
    'Prompt: Develop a model that helps explain how zombie fires are burning under ice and releasing so much carbon. Your model should show how matter (peat) and energy (fire) flow between the biosphere and atmosphere, and what questions you still need to answer.',
}

// Individual student evidence behind one class-level pattern row. `response`
// is the student's written words; `artifact` is a short plain-language
// description of their drawn model/diagram (this prototype has no real
// image assets, so a model is represented as a descriptive caption rather
// than an image). Either can be present alone, or both together.
type StudentEvidence = {
  name: string
  response?: string
  artifact?: string
  // Path/URL to a real scanned student artifact (e.g. the attached zombie
  // fires model). Distinct from `artifact`, which is always a plain-text
  // caption — a student can have either, both, or neither.
  artifactImage?: string
}

// One clickable row in any of the three summary sections. `kind` drives
// which field (artifact vs. written response) the individual-evidence panel
// leads with once a row is selected — Engagement in Science Practices
// prioritizes the model/artifact; the other two lead with the response.
type PatternRow = {
  id: string
  label: string
  count: number
  kind: 'objective' | 'practice' | 'misconception'
  students: StudentEvidence[]
}

// Section A — Learning Objective Overlap. One group per learning objective
// entered on the Lesson Planning page (see `lessonSteps` — "Learning
// Objective 1/2/3"); each group lists the distinct student ideas the class
// produced in response to it, most-common first, with no percentage score.
type LearningObjectiveGroup = { objective: string; ideas: PatternRow[] }

const learningObjectiveOverlap: LearningObjectiveGroup[] = [
  {
    objective:
      '1.A Obtain information about zombie fires to identify potential cause-and-effect relationships that lead to changes in the biosphere and atmosphere.',
    ideas: [
      {
        id: 'lo1a-permafrost-thawing',
        label: 'Identifies permafrost thawing as what lets the underground fire keep burning',
        count: 16,
        kind: 'objective',
        students: [
          {
            name: 'Jordan P.',
            response:
              'My model shows the fire moving underground into the peat as the permafrost thaws. During winter, I think the fire keeps burning in the peat underneath the snow and ice, and then it can come back to the surface in spring.',
            artifact:
              'Seasonal diagram (Summer/Fall, Winter, Spring) showing an underground fire in peat/permafrost beneath snow, smoke/CO₂ rising to the atmosphere, and a fire scar from the previous season.',
            artifactImage: ZOMBIE_FIRES_STUDENT_MODEL_IMAGE,
          },
          {
            name: 'Lena M.',
            response:
              'I noticed warmer-than-average summer and fall temperatures come right before the fires start, so I drew an arrow connecting those two boxes in my model.',
            artifact: 'Diagram with a labeled "warmer than average temperatures" box arrowed into a "fire" box.',
          },
        ],
      },
      {
        id: 'lo1a-earlier-spring-fires',
        label: 'Connects earlier-than-usual spring temperatures to new fires flaring up',
        count: 11,
        kind: 'objective',
        students: [
          {
            name: 'Sofia R.',
            response: 'When spring comes earlier than usual, the snow melts sooner and a fire flares back up in the same spot as last year.',
            artifact: 'Model with a "Spring (earlier than usual)" panel showing fire flaring up from the same burn scar.',
          },
          {
            name: 'Ethan R.',
            response: 'I connected the earlier spring warming to the fire becoming visible again above ground.',
          },
        ],
      },
      {
        id: 'lo1a-no-mechanism',
        label: 'Notes zombie fires are unusual without identifying a cause',
        count: 7,
        kind: 'objective',
        students: [
          {
            name: 'Noah T.',
            response: 'These fires are weird because they don’t go out in the winter like normal fires do.',
          },
          { name: 'Grace L.', response: 'I just noted that this doesn’t happen with regular wildfires.' },
        ],
      },
    ],
  },
  {
    objective: '1.B Develop a model to explain how matter (peat) and energy (fire) flow in the zombie fire system.',
    ideas: [
      {
        id: 'lo1b-matter-energy-labeled',
        label: 'Model explicitly labels peat/permafrost as matter and fire as energy, both flowing to the atmosphere',
        count: 12,
        kind: 'objective',
        students: [
          {
            name: 'Jordan P.',
            response:
              'I labeled the peat and permafrost as matter and the fire as energy, and drew arrows from both of them up into the smoke and CO₂ leaving through the atmosphere.',
            artifact: 'Diagram with "(matter)" labeled next to peat/permafrost and "(energy)" labeled next to the underground fire, both arrowed up to smoke/CO₂.',
            artifactImage: ZOMBIE_FIRES_STUDENT_MODEL_IMAGE,
          },
          {
            name: 'Maya T.',
            response: 'My model shows smoke coming out of the ground, but I didn’t say what part was matter and what part was energy.',
          },
        ],
      },
      {
        id: 'lo1b-underground-persists',
        label: 'Model shows fire burning underground beneath snow/ice throughout winter',
        count: 13,
        kind: 'objective',
        students: [
          {
            name: 'Diego H.',
            response: 'My model has a separate box for winter showing the fire still burning underground even though the surface is covered in snow.',
            artifact: 'Model with a "Winter (very cold temperatures)" panel showing an underground fire icon beneath a snow layer.',
          },
          {
            name: 'Priya S.',
            response: 'I drew the snow on top and the fire underneath it, connected with a note saying the fire keeps going all winter.',
          },
        ],
      },
      {
        id: 'lo1b-above-ground-only',
        label: 'Model draws fire only above ground, without showing it persisting underground',
        count: 6,
        kind: 'objective',
        students: [
          {
            name: 'Carlos M.',
            response: 'I just drew flames and smoke coming from the ground without showing what was happening underneath.',
          },
          { name: 'Hannah W.', response: 'My model shows the fire, the smoke, and the snow, but not how they connect underground.' },
        ],
      },
    ],
  },
  {
    objective:
      '1.C Ask questions to clarify how the flow of energy and matter in the atmosphere (CO₂/smoke) and biosphere (peat/permafrost) allows zombie fires to burn, including the role of humans.',
    ideas: [
      {
        id: 'lo1c-human-role',
        label: 'Asks how human activity might be making zombie fires more frequent',
        count: 12,
        kind: 'objective',
        students: [
          {
            name: 'Zoe F.',
            response: 'Is it something humans are doing that’s making the permafrost thaw more, or would this happen anyway?',
          },
          {
            name: 'Liam O.',
            response: 'Do zombie fires happen more in places where people log or build roads, or is it purely about temperature?',
          },
        ],
      },
      {
        id: 'lo1c-carbon-amount',
        label: 'Asks how much carbon zombie fires actually release compared to normal wildfires',
        count: 9,
        kind: 'objective',
        students: [
          {
            name: 'Aisha K.',
            response: 'How much CO₂ does a zombie fire release compared to a regular wildfire that burns and goes out?',
          },
          {
            name: 'Marcus J.',
            response: 'Does the carbon come mostly from the peat itself, or from something else in the permafrost?',
          },
        ],
      },
      {
        id: 'lo1c-restated-fact',
        label: 'Restates what’s already known rather than posing a new question',
        count: 6,
        kind: 'objective',
        students: [
          { name: 'Emma K.', response: 'Zombie fires burn underground in the winter and start again in spring.' },
          { name: 'Grace L.', response: 'They release smoke and carbon dioxide into the air.' },
        ],
      },
    ],
  },
]

// Section B — Engagement in Science Practices. One group per practice
// offered on the Lesson Planning form (see `practiceOptions`), each listing
// the specific ways students' models and responses demonstrated it. Only
// "Develop and Use Models" is included — this lesson didn't yet ask
// students to Construct Explanations or Engage in Argument from Evidence,
// so those groups were removed rather than left showing patterns for
// practices students were never actually asked to do.
type PracticeGroup = { practice: string; patterns: PatternRow[] }

const scienceInPracticePatterns: PracticeGroup[] = [
  {
    practice: 'Develop and Use Models',
    patterns: [
      {
        id: 'practice-models-system-components',
        label: 'Models include key system components: peat/permafrost, underground fire, snow/ice, and smoke/CO₂',
        count: 15,
        kind: 'practice',
        students: [
          {
            name: 'Jordan P.',
            artifact:
              'Diagram with seasonal panels (Summer/Fall, Winter, Spring) showing underground fire in peat/permafrost beneath snow, smoke/CO₂ rising to the atmosphere, and a fire scar from the previous season.',
            artifactImage: ZOMBIE_FIRES_STUDENT_MODEL_IMAGE,
            response: 'I made sure to include the peat, the permafrost, the underground fire, the snow, and the smoke/CO₂, since those are the main parts of the system.',
          },
          {
            name: 'Marcus J.',
            artifact: 'Diagram showing an underground fire box connected by arrows to a smoke/CO₂ cloud, with a separate snow layer on top.',
          },
        ],
      },
      {
        id: 'practice-models-matter-energy-flows',
        label: 'Models distinguish matter (peat) from energy (fire) and show both flowing to the atmosphere',
        count: 11,
        kind: 'practice',
        students: [
          {
            name: 'Lena M.',
            artifact: 'Model with arrows from a labeled "peat (matter)" box and a labeled "fire (energy)" box, both pointing up to the atmosphere.',
            response: 'I labeled which parts of my model were matter and which were energy so it’s clear how each one moves.',
          },
          {
            name: 'Priya S.',
            artifact: 'Diagram showing separate arrows for matter and energy leaving the underground fire.',
          },
        ],
      },
      {
        id: 'practice-models-seasonal-change',
        label: 'Models represent how conditions change across seasons while the fire persists underground',
        count: 8,
        kind: 'practice',
        students: [
          {
            name: 'Diego H.',
            artifact: 'Model with three side-by-side panels for summer/fall, winter, and spring, each showing the underground fire in a different state.',
            response: 'My model shows the same fire underground in every panel, just with different amounts of snow on top depending on the season.',
          },
          {
            name: 'Sofia R.',
            artifact: 'Model with a "Spring (earlier than usual)" panel showing the fire flaring back up above ground.',
          },
        ],
      },
    ],
  },
]

// Section C — Misconceptions found across student responses and models.
const misconceptionPatterns: PatternRow[] = [
  {
    id: 'misconception-new-fire-each-spring',
    label: 'Believes the spring fire is a brand-new fire rather than the same fire continuing underground',
    count: 8,
    kind: 'misconception',
    students: [
      { name: 'Emma K.', response: 'A new fire probably starts in spring once things dry out again.' },
      { name: 'Carlos M.', response: 'I think the winter fire goes out, and then a different fire starts in the same spot later.' },
    ],
  },
  {
    id: 'misconception-no-matter-energy-distinction',
    label: 'Treats peat and fire as the same thing rather than distinguishing matter (peat) from energy (fire)',
    count: 6,
    kind: 'misconception',
    students: [
      { name: 'Liam O.', response: 'The peat and the fire are kind of the same thing — the peat is just the fire underground.' },
      { name: 'Priya S.', response: 'I didn’t really separate the peat from the fire in my model, they’re both just “the fire part.”' },
    ],
  },
  {
    id: 'misconception-common-everywhere',
    label: 'Assumes zombie fires are common wherever wildfires occur, not a specific, increasing permafrost phenomenon',
    count: 4,
    kind: 'misconception',
    students: [
      {
        name: 'Noah T.',
        response: 'I figured most wildfires probably keep smoldering underground like this once the surface fire is out.',
        artifact: 'Model showing underground burning beneath a generic forest, with no reference to permafrost or peat.',
      },
      { name: 'Hannah W.', response: 'I thought this happens with basically any big fire, not just fires in icy areas.' },
    ],
  },
]

// A flat lookup across all three sections, keyed by row id, so the
// individual-evidence panel can resolve whichever row the teacher last
// clicked regardless of which section it came from.
const allPatternRows: Record<string, PatternRow> = Object.fromEntries(
  [
    ...learningObjectiveOverlap.flatMap((group) => group.ideas),
    ...scienceInPracticePatterns.flatMap((group) => group.patterns),
    ...misconceptionPatterns,
  ].map((row) => [row.id, row]),
)

// Suggested Facilitation Questions are generated as exactly two per
// category — whole-class prompts, peer-to-peer discussion, and debrief —
// from the lesson context and the class analysis (patterns, counts, and the
// learning needs in Areas for Improvement; never student names or work).
// Regenerate asks for a fresh set, passing the questions already shown so
// they aren't repeated.
type FacilitationCategory = 'Whole-class prompts' | 'Peer-to-peer discussion' | 'Debrief'
type FacilitationQuestion = { text: string; category: FacilitationCategory }

const facilitationCategories: FacilitationCategory[] = ['Whole-class prompts', 'Peer-to-peer discussion', 'Debrief']
const questionsPerCategory = 2

const facilitationQuestionInstructions = [
  'You write facilitation questions a teacher can use with the class after reviewing its submitted work for the lesson in "lesson".',
  `Return exactly ${questionsPerCategory * facilitationCategories.length} questions: exactly ${questionsPerCategory} for each category in ${facilitationCategories.map((category) => `"${category}"`).join(', ')}.`,
  'Whole-class prompts: questions the teacher poses to the whole class to surface and test shared ideas. Peer-to-peer discussion: questions students discuss in pairs or small groups about each other’s models and explanations. Debrief: reflective questions for the end of the lesson about what changed in students’ thinking and what they still need to figure out.',
  'Base every question on "classAnalysis": prioritize the learning needs in areasForImprovement (largest student counts first), build on strengths in overlap, and keep the lesson’s practice-oriented objectives in view. In basedOn, list the pattern ids each question responds to.',
  'Within a category, the two questions must address different needs or objectives — not two wordings of the same question.',
  'Do not repeat any question in "previousQuestions". Address students directly, and never mention individual students.',
].join('\n')

const facilitationQuestionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      minItems: questionsPerCategory * facilitationCategories.length,
      maxItems: questionsPerCategory * facilitationCategories.length,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'text', 'basedOn'],
        properties: {
          category: { type: 'string', enum: facilitationCategories },
          text: { type: 'string' },
          basedOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const

type FacilitationQuestionRequest = {
  lesson: ClassFeedbackLessonContext
  classAnalysis: {
    overlap: { objective: string; summary: string; patterns: { id: string; label: string; studentCount: number }[] }[]
    areasForImprovement: { objective: string; summary: string; nextStep?: string; patterns: { id: string; label: string; studentCount: number }[] }[]
  }
  previousQuestions: string[]
}

// The demo model's question ideas for the Zombie Fires lesson, each tied to
// the patterns it responds to. The mock ranks them by the class's learning
// needs; a real model writes its own from the same request.
const mockFacilitationQuestionBank: (FacilitationQuestion & { basedOn: string[] })[] = [
  {
    category: 'Whole-class prompts',
    text: 'What evidence in your model best supports the claim that the underground fire keeps burning all winter?',
    basedOn: ['lo1b-underground-persists', 'lo1b-above-ground-only'],
  },
  {
    category: 'Whole-class prompts',
    text: 'Some of our models show the fire only above ground — what would we need to add to show what’s happening underneath in winter?',
    basedOn: ['lo1b-above-ground-only'],
  },
  {
    category: 'Whole-class prompts',
    text: 'Which group used a specific piece of evidence, rather than a general statement, to explain how the fire persists?',
    basedOn: ['lo1a-no-mechanism', 'lo1a-permafrost-thawing'],
  },
  {
    category: 'Whole-class prompts',
    text: 'Our models mostly agree that the fire burns underground in winter — what evidence would make that claim more precise?',
    basedOn: ['lo1b-underground-persists'],
  },
  {
    category: 'Whole-class prompts',
    text: 'If the peat is the matter and the fire is the energy, where does each one actually end up?',
    basedOn: ['misconception-no-matter-energy-distinction', 'lo1b-matter-energy-labeled'],
  },
  {
    category: 'Whole-class prompts',
    text: 'What part of your model used the zombie fire images or readings most directly as evidence?',
    basedOn: ['lo1a-no-mechanism'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'How does your model show the difference between the peat (matter) and the fire (energy)?',
    basedOn: ['misconception-no-matter-energy-distinction', 'practice-models-matter-energy-flows'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'How could you explain your model to a classmate who thinks the spring fire is a brand-new fire?',
    basedOn: ['misconception-new-fire-each-spring'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'Compare your models: what evidence from the fire scars would tell you whether the spring fire is new or the same one?',
    basedOn: ['misconception-new-fire-each-spring', 'practice-models-seasonal-change'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'What would it take for a classmate to convince you their model is more accurate than yours?',
    basedOn: ['practice-models-system-components'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'What question would you ask a group whose model doesn’t distinguish matter from energy at all?',
    basedOn: ['misconception-no-matter-energy-distinction'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'Where might someone confuse “the fire went out” with “the fire is still smoldering underground” in your explanation?',
    basedOn: ['lo1b-above-ground-only', 'misconception-new-fire-each-spring'],
  },
  {
    category: 'Debrief',
    text: 'Which part of your model could be tested or revised with more information?',
    basedOn: ['practice-models-seasonal-change'],
  },
  {
    category: 'Debrief',
    text: 'Where in your model did you revise something because of new evidence, rather than just to make it look neater?',
    basedOn: ['lo1a-no-mechanism'],
  },
  {
    category: 'Debrief',
    text: 'Which learning objective from today do you think your model addresses least well right now?',
    basedOn: ['lo1c-restated-fact', 'lo1a-no-mechanism'],
  },
  {
    category: 'Debrief',
    text: 'What is one question you’d add to the Driving Question Board if you had five more minutes?',
    basedOn: ['lo1c-restated-fact', 'lo1c-human-role'],
  },
  {
    category: 'Debrief',
    text: 'Which idea in your model changed the most today, and what evidence changed it?',
    basedOn: ['lo1b-matter-energy-labeled'],
  },
  {
    category: 'Debrief',
    text: 'What is one thing your model still can’t explain about how the fire survives the winter?',
    basedOn: ['misconception-new-fire-each-spring', 'lo1b-above-ground-only'],
  },
]

// How strongly a question responds to the class's needs: learning gaps
// count double, strengths once.
function facilitationNeedScore(basedOn: readonly string[], analysis: FacilitationQuestionRequest['classAnalysis']): number {
  const counts = (findings: { patterns: { id: string; studentCount: number }[] }[]) =>
    Object.fromEntries(findings.flatMap((finding) => finding.patterns.map((pattern) => [pattern.id, pattern.studentCount])))
  const gaps = counts(analysis.areasForImprovement)
  const strengths = counts(analysis.overlap)
  return basedOn.reduce((score, id) => score + (gaps[id] ?? 0) * 2 + (strengths[id] ?? 0), 0)
}

// Two per category, highest need first, the second addressing a different
// need from the first; questions already shown are used only if a category
// runs out.
function pickFacilitationQuestions(
  candidates: readonly (FacilitationQuestion & { basedOn: string[] })[],
  analysis: FacilitationQuestionRequest['classAnalysis'],
  previous: readonly string[],
): (FacilitationQuestion & { basedOn: string[] })[] {
  return facilitationCategories.flatMap((category) => {
    const ranked = candidates
      .filter((question) => question.category === category)
      .sort((a, b) => facilitationNeedScore(b.basedOn, analysis) - facilitationNeedScore(a.basedOn, analysis))
    const fresh = ranked.filter((question) => !previous.includes(question.text))
    const pool = fresh.length >= questionsPerCategory ? fresh : [...fresh, ...ranked.filter((question) => !fresh.includes(question))]
    const first = pool[0]
    if (!first) return []
    const second = pool.find((question) => question !== first && question.basedOn[0] !== first.basedOn[0]) ?? pool.find((question) => question !== first)
    return second ? [first, second] : [first]
  })
}

function mockFacilitationQuestionReply(request: FacilitationQuestionRequest): string {
  return JSON.stringify({
    questions: pickFacilitationQuestions(mockFacilitationQuestionBank, request.classAnalysis, request.previousQuestions).map(
      ({ category, text, basedOn }) => ({ category, text, basedOn }),
    ),
  })
}

// Keeps the response to exactly two well-formed, distinct questions per
// category, in category order. If the model returns too few for a
// category, the rest are filled from the demo question ideas.
function readFacilitationQuestions(
  raw: string,
  analysis: FacilitationQuestionRequest['classAnalysis'],
  previous: readonly string[],
): FacilitationQuestion[] {
  let items: unknown[] = []
  try {
    const data = JSON.parse(raw) as { questions?: unknown }
    if (Array.isArray(data.questions)) items = data.questions
  } catch {
    // Handled as an empty response.
  }
  const seen = new Set<string>()
  const valid = items
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({ category: item.category as FacilitationCategory, text: typeof item.text === 'string' ? item.text.trim() : '' }))
    .filter((item) => {
      const key = item.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
      if (!item.text || !facilitationCategories.includes(item.category) || seen.has(key)) return false
      seen.add(key)
      return true
    })
  return facilitationCategories.flatMap((category) => {
    const chosen = valid.filter((item) => item.category === category).slice(0, questionsPerCategory)
    if (chosen.length < questionsPerCategory) {
      const fill = pickFacilitationQuestions(
        mockFacilitationQuestionBank.filter((question) => question.category === category && !seen.has(question.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())),
        analysis,
        previous,
      )
      chosen.push(...fill.slice(0, questionsPerCategory - chosen.length).map(({ category: fillCategory, text }) => ({ category: fillCategory, text })))
    }
    return chosen
  })
}

function generateFacilitationQuestions(
  lesson: ClassFeedbackLessonContext,
  summary: ClassSummaryOutput,
  previousQuestions: string[],
): FacilitationQuestion[] {
  const patternsFor = (ids: readonly string[]) =>
    ids.map((id) => ({ id, label: allPatternRows[id].label, studentCount: allPatternRows[id].count }))
  const objectiveFor = (index: number) => lesson.objectives[index] ?? `Objective ${index + 1}`
  const classAnalysis: FacilitationQuestionRequest['classAnalysis'] = {
    overlap: summary.overlap.map((finding) => ({ objective: objectiveFor(finding.objectiveIndex), summary: finding.summary, patterns: patternsFor(finding.patternIds) })),
    areasForImprovement: summary.areasForImprovement.map((finding) => ({
      objective: objectiveFor(finding.objectiveIndex),
      summary: finding.summary,
      nextStep: finding.nextStep,
      patterns: patternsFor(finding.patternIds),
    })),
  }
  const raw = callAiModel(
    'facilitation-questions',
    { instructions: facilitationQuestionInstructions, responseSchema: facilitationQuestionSchema, lesson, classAnalysis, previousQuestions },
    (request) => mockFacilitationQuestionReply(request),
  )
  return readFacilitationQuestions(raw, classAnalysis, previousQuestions)
}

// Example questions shown above the Deeper AI Analysis input.
const deeperAnalysisStarterQuestions = [
  'What misconceptions are common?',
  'How do students\u2019 models differ?',
  'Which students need additional support?',
  'What should I focus on next?',
]

// The class analysis Deeper AI Analysis answers class-wide questions from:
// the Class Summary's findings with each pattern's label, student count,
// and the students behind it (names are replaced by the AI gateway before
// anything is sent, and restored only in the reply shown here).
type ClassAnalysisPattern = { label: string; count: number; kind: PatternRow['kind']; students: string[] }
type ClassAnalysisForAi = {
  overlap: { objective: string; practices: string[]; summary: string; patterns: ClassAnalysisPattern[] }[]
  areasForImprovement: { objective: string; practices: string[]; summary: string; nextStep?: string; patterns: ClassAnalysisPattern[] }[]
}

function classAnalysisPattern(row: PatternRow): ClassAnalysisPattern {
  return { label: row.label, count: row.count, kind: row.kind, students: row.students.map((student) => student.name) }
}

const joinNames = (names: readonly string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

// Class-wide questions (the starter questions, or anything like them) are
// answered from the class analysis; null when the question isn't one.
function mockClassWideReply(question: string, analysis: ClassAnalysisForAi | null): string | null {
  const lower = question.toLowerCase()
  const isMisconceptions = lower.includes('misconception')
  const isModels = lower.includes('model') && (lower.includes('differ') || lower.includes('compare'))
  const isSupport = lower.includes('support') || lower.includes('struggl') || lower.includes('help')
  const isNext = lower.includes('focus') || lower.includes('next')
  if (!isMisconceptions && !isModels && !isSupport && !isNext) return null
  if (!analysis) return 'This lesson doesn’t have analyzed student submissions yet, so I can’t answer that from class data.'

  const gaps = analysis.areasForImprovement.flatMap((finding) => finding.patterns.map((pattern) => ({ ...pattern, finding })))
  if (isMisconceptions) {
    const misconceptions = gaps.filter((pattern) => pattern.kind === 'misconception').sort((a, b) => b.count - a.count)
    if (misconceptions.length === 0) return 'No misconceptions were found in the submitted work.'
    const [top, ...rest] = misconceptions
    return `The most common misconception is “${top.label}” (${top.count} students). ${rest
      .map((pattern) => `“${pattern.label}” (${pattern.count})`)
      .join(' and ')}${rest.length ? ' also come up. ' : ''}Start with the first: it affects objective ${top.finding.objective.split(' ')[0]}, and ${top.finding.nextStep ? `a good next step is to ${top.finding.nextStep.charAt(0).toLowerCase()}${top.finding.nextStep.slice(1)}` : 'it’s worth a whole-class check-in'}`
  }
  if (isModels) {
    const strengths = analysis.overlap.flatMap((finding) => finding.patterns).filter((pattern) => pattern.kind === 'practice' || /model/i.test(pattern.label))
    const modelGaps = gaps.filter((pattern) => /model/i.test(pattern.label))
    const describe = (list: ClassAnalysisPattern[]) => list.map((pattern) => `${pattern.label.charAt(0).toLowerCase()}${pattern.label.slice(1)} (${pattern.count})`).join('; ')
    return `Most models share the same strengths — ${describe(strengths.sort((a, b) => b.count - a.count).slice(0, 3))}. They differ most in ${modelGaps.length ? describe(modelGaps) : 'how much detail they show'}, so that’s where comparing two models side by side would be most useful.`
  }
  if (isSupport) {
    const groups = [...gaps].sort((a, b) => b.count - a.count).slice(0, 3)
    return `Based on the Areas for Improvement: ${groups
      .map((pattern) => `${joinNames(pattern.students)} (${pattern.label.charAt(0).toLowerCase()}${pattern.label.slice(1)} — ${pattern.count} students in all)`)
      .join('; ')}. These are example students from each group, so check the full group in Student Evidence before planning support.`
  }
  const ranked = [...analysis.areasForImprovement].sort(
    (a, b) => b.patterns.reduce((sum, pattern) => sum + pattern.count, 0) - a.patterns.reduce((sum, pattern) => sum + pattern.count, 0),
  )
  const first = ranked[0]
  if (!first) return 'The submitted work doesn’t show any gaps to prioritize.'
  const total = first.patterns.reduce((sum, pattern) => sum + pattern.count, 0)
  return `Focus next on objective ${first.objective.split(' ')[0]} (${first.practices.join(', ') || 'its targeted practices'}), where most of the gaps are (${pluralize(first.patterns.length, 'pattern')}, ${total} student responses) — ${first.summary.charAt(0).toLowerCase()}${first.summary.slice(1)} ${first.nextStep ? `Next step: ${first.nextStep}` : ''}`.trim()
}

// Stands in for a real AI call: a canned reply that still reads as grounded
// in the *currently selected* pattern — its label, student count, and a
// couple of the actual student names — so switching patterns visibly
// changes what "Deeper AI Analysis" talks about. When the teacher has
// focused a specific student (via the comment action on their evidence
// card), the reply narrows to that one student's actual words instead of
// generalizing across the pattern.
function mockDeeperAnalysisReply(
  pattern: PatternRow,
  question: string,
  focusedStudent?: StudentEvidence | null,
  classAnalysis: ClassAnalysisForAi | null = null,
): string {
  const classWide = mockClassWideReply(question, classAnalysis)
  if (classWide) return classWide
  const lower = question.toLowerCase()

  if (focusedStudent) {
    const excerpt = focusedStudent.response ?? focusedStudent.artifact ?? 'their submission'
    if (lower.includes('differ')) {
      return `${focusedStudent.name}'s work stands out from the rest of “${pattern.label}” mainly in how directly it commits to one idea — “${excerpt}” — rather than hedging between two explanations the way several classmates do.`
    }
    if (lower.includes('investigate')) {
      return `I'd ask ${focusedStudent.name} to walk through “${excerpt}” out loud — that will tell you whether the idea is fully reasoned through or just phrased confidently.`
    }
    if (lower.includes('pattern')) {
      return `${focusedStudent.name}'s response — “${excerpt}” — is a clean example of the pattern behind “${pattern.label},” stated more explicitly than most of the group.`
    }
    return `Looking specifically at ${focusedStudent.name}'s work — “${excerpt}” — that's worth following up on directly with them rather than generalizing to the rest of “${pattern.label}.”`
  }

  const sampleNames = pattern.students.slice(0, 2).map((student) => student.name)
  const namesText = sampleNames.length === 2 ? `${sampleNames[0]} and ${sampleNames[1]}` : sampleNames[0] ?? 'this group'

  if (lower.includes('differ')) {
    return `Within “${pattern.label},” most of the ${pattern.count} students converge on the same core idea, but ${namesText} show the clearest gap in how they justify it — some lean on the data table, others on the model's arrows alone. That's the axis I'd probe first.`
  }
  if (lower.includes('investigate')) {
    return `I'd start with whether the ${pattern.count} students behind “${pattern.label}” can defend their idea with evidence, not just state it — try that with ${namesText} first and see how far the reasoning actually goes.`
  }
  if (lower.includes('pattern')) {
    return `Across the ${pattern.count} students here, the strongest pattern is how closely their language echoes the class reading — ${namesText}, for example, reuse almost the same phrasing, which suggests the idea may be memorized rather than reasoned through yet.`
  }
  return `Based on the ${pattern.count} responses behind “${pattern.label}” — including ${namesText} — that's a good question for a small-group check-in rather than whole-class discussion, since the pattern isn't shared by everyone.`
}

// Shown as an AI-authored line in the conversation itself, right after the
// teacher clicks the comment/"Ask AI" action on one student's evidence card
// — this is the "indication" that Deeper AI Analysis has narrowed its
// context to that one student rather than the whole pattern.
function buildStudentFocusNote(student: StudentEvidence): string {
  const excerpt = student.response ?? student.artifact ?? 'their submission'
  const kind = student.response ? 'response' : 'model'
  return `🔍 Now focusing on ${student.name}'s ${kind}: “${excerpt}” Ask a follow-up and I'll center the answer on this one student.`
}

// `bold` marks an epistemic-practice term (existing convention). `added`
// marks text that AI actually inserted or substantially reworded in the AI
// Revised baseline — only segments with `added: true` get the yellow
// AI-highlight; everything else renders as the teacher's normal, unhighlighted
// text, even inside an otherwise-"revised" section. A segment can be both
// (e.g. a newly-introduced practice term like "Initial Model"). `flagged`
// marks the specific sentence/phrase in the ORIGINAL baseline text that the
// AI Suggestions tab points to as an opportunity — only that phrase becomes
// the clickable/highlighted trigger there, not the whole section, and it's
// chosen to line up with whatever lessonRevisionSegments later adds or
// changes for that same section (same pedagogical opportunity, two states).
type LessonSegment = { text: string; bold?: boolean; added?: boolean; flagged?: boolean }

type LessonSource = 'ai-generated' | 'uploaded'

const lessonSourceLabels: Record<LessonSource, string> = {
  'ai-generated': 'AI Generated',
  uploaded: 'Teacher Uploaded',
}

// There is one lesson, shown in one view — driven entirely by
// editor.revisedLesson, which only ever changes in response to the teacher
// explicitly clicking Apply in the conversational chat (or an Edit Lesson
// manual edit, which always wins regardless of any AI track). Pending AI
// suggestions appear right under their section, where the teacher can open
// the review chat (and apply from there) or dismiss them; dismissing keeps
// the original text.

const lessonPractices = [
  'Obtaining Information',
  'Cause-and-Effect Reasoning',
  'Initial Modeling',
  'Matter and Energy Flow',
  'Asking Questions',
]

// One section of a lesson plan — each is one of the "major editable
// sections" a teacher can edit directly (Edit Lesson) or revise with AI
// (Revise Lesson). Every lesson, generated or the demo, follows the Lesson
// Planning form's order: Grade Level, Topic, Standards, Science Practices to
// Emphasize, Learning Objectives, Driving Question, Instructional Sequence
// (each activity carrying its own `duration` in minutes, shown inline next
// to its name), Lesson Duration, then Additional Customization.
//
// `sectionHeading` renders a group heading above a step (used once per
// group, at the group's first entry). `leadIn` renders a plain, static,
// non-editable line above a step's own content (used for the "By the end
// of the lesson..." lead-in above the first learning objective).
// `displayPrefix` overrides the default "Label:" text shown before a
// step's content (used for "1."/"2."/"3." on individual, independently
// editable learning objectives instead of their internal label). `afterSection`
// marks the step after which the "Science Practices to Emphasize" chip block
// renders. `listStyle: 'bullet'` renders the step's segments as individual
// bullet list items instead of one flowing paragraph — the same per-segment
// `flagged`/`added` highlighting still applies per item.
type LessonStep = {
  label: string
  duration?: number
  segments: readonly LessonSegment[]
  sectionHeading?: string
  leadIn?: string
  displayPrefix?: string
  afterSection?: 'practices'
  listStyle?: 'bullet'
  // Learning objectives (1-based) an activity works toward.
  objectives?: readonly number[]
}

// A lesson shown in the workspace: its sections in order, the practices to
// emphasize, and its AI suggestions keyed by section label — each with the
// proposed revision, the summary the revision chat opens with, and
// (optionally) a canned follow-up exchange.
type LessonDocument = {
  // Identifies this lesson in its Student Feedback link.
  id: string
  title: string
  steps: readonly LessonStep[]
  practices: readonly string[]
  suggestions: Record<string, string>
  suggestionSummaries: Record<string, string>
  revisionSegments: Record<string, readonly LessonSegment[]>
  workflows: Record<string, { teacherFollowUp: string; aiProposal: string }>
}

// The prototype's demo lesson (Zombie Fires) — shown for uploaded lessons
// and the Library's demo lesson.
const demoLessonSteps: LessonStep[] = [
  {
    label: 'Topic',
    segments: [{ text: 'Zombie fires: how matter and energy flow between the biosphere and atmosphere' }],
  },
  {
    label: 'Grade Level',
    segments: [{ text: 'Grades 9–12' }],
  },
  {
    label: 'Lesson Duration',
    segments: [{ text: '60 minutes (5 + 15 + 10 + 15 + 5 + 10 min across 6 activities)' }],
  },
  {
    label: 'Standards',
    sectionHeading: 'Standards',
    segments: [
      {
        text: 'NGSS HS-LS2-3, HS-LS2-4, HS-LS2-5, HS-ESS2-6 — Construct and revise explanations, and develop models, for the cycling of matter and flow of energy between the biosphere and atmosphere.',
      },
    ],
  },
  {
    label: 'Crosscutting Concept',
    afterSection: 'practices',
    segments: [{ text: 'Energy and Matter: Flows, Cycles, and Conservation.', flagged: true }],
  },
  {
    label: 'Learning Objective 1',
    sectionHeading: 'Learning Objectives',
    leadIn: 'By the end of the lesson, students will be able to:',
    displayPrefix: '1.A',
    segments: [
      {
        text: 'Obtain information about zombie fires to identify potential cause-and-effect relationships that lead to changes in the biosphere and atmosphere.',
      },
    ],
  },
  {
    label: 'Learning Objective 2',
    displayPrefix: '1.B',
    segments: [{ text: 'Develop a model to explain how matter (peat) and energy (fire) flow in the zombie fire system.' }],
  },
  {
    label: 'Learning Objective 3',
    displayPrefix: '1.C',
    segments: [
      {
        text: 'Ask questions to clarify how the flow of energy and matter in the atmosphere (CO₂/smoke) and biosphere (peat/permafrost) allows zombie fires to burn, including the role of humans.',
      },
    ],
  },
  {
    label: 'Driving Question',
    sectionHeading: 'Driving Question',
    displayPrefix: '',
    segments: [{ text: 'How are zombie fires burning under ice and releasing so much carbon?' }],
  },
  {
    label: 'Engage',
    sectionHeading: 'Instructional Sequence',
    duration: 5,
    segments: [
      { text: 'Teacher shows ' },
      { text: 'photographs and a short video clip of zombie fires burning under snow and ice', flagged: true },
      {
        text: ', then poses the driving question students will investigate throughout the lesson: How are zombie fires burning under ice and releasing so much carbon?',
      },
    ],
  },
  {
    label: 'Explore',
    duration: 15,
    segments: [
      { text: 'In small groups, students ' },
      { text: 'obtain information', bold: true, flagged: true },
      {
        text: ' about zombie fires — including satellite images, burn scars, and short readings about when and where they occur — and identify possible ',
      },
      { text: 'cause-and-effect relationships', bold: true },
      {
        text: ' involving changes in the biosphere and atmosphere, such as what seasonal conditions seem to come before a zombie fire appears.',
      },
    ],
  },
  {
    label: 'Explain',
    duration: 10,
    segments: [
      { text: 'Students construct an ' },
      { text: 'initial model', bold: true, flagged: true },
      {
        text: ' of the zombie fire system that may include peat/permafrost, underground fire, snow/ice, smoke/CO₂, and the seasons in which each part is active — representing their current thinking about how matter and energy move through the system, not yet the finished explanation.',
      },
    ],
  },
  {
    label: 'Elaborate',
    duration: 15,
    segments: [
      { text: 'In small groups, students share their initial models and ' },
      { text: 'reason', bold: true },
      {
        text: ' about how matter (peat) and energy (fire) flow through the system and how an underground fire could persist through winter beneath snow and ice. Students then ',
      },
      { text: 'revise their models', bold: true },
      { text: ' to reflect this reasoning and ' },
      { text: 'annotate at least one change explaining why they made it.', flagged: true },
    ],
  },
  {
    label: 'Evaluate',
    duration: 5,
    segments: [
      {
        text: 'Teacher circulates during group work with a short checklist, listening for two things: whether a student distinguishes matter (peat) from energy (fire) in their reasoning, and whether they can explain how the underground fire persists through winter. ',
      },
      {
        text: 'Two or three groups briefly share one part of their model and the reasoning behind it with the whole class before moving on.',
        flagged: true,
      },
    ],
  },
  {
    label: 'Assessment',
    duration: 10,
    segments: [
      { text: 'Students ' },
      { text: 'ask questions', bold: true },
      {
        text: ' to clarify what they still need to understand about the flow of energy and matter between the atmosphere (CO₂/smoke) and biosphere (peat/permafrost), including the role of humans in zombie fires becoming more common. ',
      },
      { text: 'These questions are collected and added to a class Driving Question Board to guide the lessons that follow.', flagged: true },
      {
        text: ' Look for: at least one question connected to matter or energy flow, and one question about cause and effect (including human influence).',
      },
    ],
  },
  {
    label: 'Materials',
    sectionHeading: 'Additional Customization',
    listStyle: 'bullet',
    segments: [
      { text: 'Zombie fire photographs and a short video clip (satellite imagery, burn scars, smoke plumes)' },
      { text: 'Student handout: "How are zombie fires burning under ice and releasing so much carbon?"' },
      { text: 'Poster paper or a modeling worksheet for initial models' },
      { text: 'Colored markers' },
      { text: 'Sticky notes for cause-and-effect claims and questions' },
    ],
  },
  {
    label: 'Equipment & Technology',
    listStyle: 'bullet',
    segments: [
      { text: 'Document camera or projector to share zombie fire images and student models' },
      { text: 'Class set of tablets or laptops for groups to research zombie fire images and video', flagged: true },
    ],
  },
  {
    label: 'Safety Considerations',
    segments: [{ text: 'None — no lab materials are used in this activity.' }],
  },
]

function segmentsToText(segments: readonly LessonSegment[]): string {
  return segments.map((segment) => segment.text).join('')
}

// A 5E phase shows its duration as a small pill/badge next to the heading
// (not written into the sentence as "— 15 min") — there's no separate
// Pacing & Duration section. `step.label` itself remains the key used for
// every data lookup (lessonSuggestions, stepWorkflow, manualEditsByVersion).
function DurationBadge({ duration, objectives }: { duration?: number; objectives?: readonly number[] }) {
  return (
    <>
      {duration !== undefined && <span className="badge duration-badge">{duration} min</span>}
      {objectives && objectives.length > 0 && (
        <span className="badge objective-badge" title="Learning objectives this activity works toward">
          {objectives.length === 1 ? 'Objective' : 'Objectives'} {objectives.join(', ')}
        </span>
      )}
    </>
  )
}

const lessonSuggestions: Record<string, string> = {
  'Crosscutting Concept':
    'This names the crosscutting concept but doesn’t yet say why it matters here. Consider adding a short line connecting it to the specific distinction this lesson hinges on — that peat is the matter that fuels the fire, while the fire itself releases energy — so students see the concept as a lens for their model, not just a label.',
  'Equipment & Technology':
    'Listing tablets or laptops as a requirement could leave the activity inaccessible if your classroom doesn’t have reliable device access. Consider offering a low-tech alternative — printed zombie fire photos and poster paper — as the default, with digital research tools as an optional upgrade rather than a requirement.',
  Engage:
    'Right now, this moves straight from the images to the driving question, so students may treat the model as reproducing what they see rather than investigating a genuine mystery. Consider opening instead by first asking students what they notice and wonder about the images and video, before revealing the driving question — this positions the phenomenon as something to investigate, not simply illustrate.',
  Explore:
    'As written, this could become a quick fact-gathering exercise rather than real cause-and-effect reasoning. Consider having each group record their cause-and-effect claims on sticky notes, so those claims can be tested and revisited once students build and reason through their model.',
  Explain:
    'Consider framing this explicitly as an Initial Model representing students’ current ideas, which they will return to and revise later in the lesson once they’ve reasoned through matter and energy — positioning them as knowledge builders, not just diagram-makers.',
  Elaborate:
    'This already asks students to reason and then revise, which is exactly the progression you want — but the annotation could be more specific. Consider asking students to name whether each revision is about matter, energy, or a cause-and-effect relationship, so the connection to the learning objectives is explicit and easy to assess.',
  Evaluate:
    'This check is a good instinct, but without something specific to listen for, it’s easy to default to checking whether the diagram looks complete rather than whether students distinguish matter from energy. Consider giving yourself a short checklist of exactly two things to listen for as you circulate.',
  Assessment:
    'As written, this lesson ends without resolving the phenomenon — which is appropriate for Lesson 1, but make sure the questions students generate are specific enough to act on. Consider having each group post their top question to a shared Driving Question Board so the class can track which ones get answered as the unit progresses.',
}

// The AI Revised baseline for each section. This is the teacher's ORIGINAL
// wording (see lessonSteps above) with only targeted AI edits layered in —
// most segments here are plain, unmarked, and textually identical to the
// original; only the specific phrase(s) AI actually added or substantially
// reworded carry `added: true`, which is the only thing LessonRichText
// renders with the yellow AI-highlight. This is deliberate: AI Revised
// should read as "existing teacher lesson + targeted AI improvements," not
// as a lesson AI generated from scratch. segmentsToText(...) below still
// concatenates to one continuous string for chat-apply / preview / the
// Original-vs-Revised diff plain-text uses, exactly as before.
const lessonRevisionSegments: Record<string, readonly LessonSegment[]> = {
  'Crosscutting Concept': [
    { text: 'Energy and Matter: Flows, Cycles, and Conservation.' },
    {
      text: ' This lesson asks students to distinguish peat as the matter that fuels the fire from the energy the fire releases as heat, smoke, and CO₂.',
      added: true,
    },
  ],
  'Equipment & Technology': [
    { text: 'Document camera or projector to share zombie fire images and student models' },
    { text: 'Class set of tablets or laptops for groups to research zombie fire images and video' },
    {
      text: 'Printed zombie fire photos and poster paper are a sufficient low-tech alternative to the tablets/laptops above — treat digital research tools as optional, not required.',
      added: true,
    },
  ],
  Engage: [
    { text: 'Teacher shows photographs and a short video clip of zombie fires burning under snow and ice' },
    { text: ', first asking students what they notice and wonder,', added: true },
    {
      text: ' then poses the driving question students will investigate throughout the lesson: How are zombie fires burning under ice and releasing so much carbon?',
    },
  ],
  Explore: [
    { text: 'In small groups, students ' },
    { text: 'obtain information', bold: true },
    {
      text: ' about zombie fires — including satellite images, burn scars, and short readings about when and where they occur — and identify possible ',
    },
    { text: 'cause-and-effect relationships', bold: true },
    {
      text: ' involving changes in the biosphere and atmosphere, such as what seasonal conditions seem to come before a zombie fire appears.',
    },
    {
      text: ' Each group records its cause-and-effect claims on sticky notes to revisit once they build their model.',
      added: true,
    },
  ],
  Explain: [
    { text: 'Students construct an ' },
    { text: 'Initial Model', bold: true, added: true },
    {
      text: ' of the zombie fire system that may include peat/permafrost, underground fire, snow/ice, smoke/CO₂, and the seasons in which each part is active — representing their current thinking about how matter and energy move through the system, not yet the finished explanation.',
    },
  ],
  Elaborate: [
    { text: 'In small groups, students share their initial models and ' },
    { text: 'reason', bold: true },
    {
      text: ' about how matter (peat) and energy (fire) flow through the system and how an underground fire could persist through winter beneath snow and ice. Students then ',
    },
    { text: 'revise their models', bold: true },
    { text: ' to reflect this reasoning' },
    {
      text: ', annotating each change with the sentence starter "I changed ___ because it explains ___ (matter / energy / a cause-and-effect relationship)" so the connection is explicit.',
      added: true,
    },
  ],
  Evaluate: [
    {
      text: 'Teacher circulates during group work with a short checklist, listening for two things: whether a student distinguishes matter (peat) from energy (fire) in their reasoning, and whether they can explain how the underground fire persists through winter. Two or three groups briefly share one part of their model and the reasoning behind it with the whole class before moving on.',
    },
    {
      text: ' This quick check flags who may need support before generating their questions.',
      added: true,
    },
  ],
  Assessment: [
    { text: 'Students ' },
    {
      text: 'exchange their initial model with a partner for a quick round of feedback, then ',
      added: true,
    },
    { text: 'ask questions', bold: true },
    {
      text: ' to clarify what they still need to understand about the flow of energy and matter between the atmosphere (CO₂/smoke) and biosphere (peat/permafrost), including the role of humans in zombie fires becoming more common. These questions are collected and added to a class Driving Question Board to guide the lessons that follow.',
    },
    {
      text: ' Each group posts its top question to the board so the class can track which ones get answered as the unit progresses.',
      added: true,
    },
    {
      text: ' Look for: at least one question connected to matter or energy flow, and one question about cause and effect (including human influence).',
    },
  ],
}

const chatSuggestionSummary: Record<string, string> = {
  'Crosscutting Concept':
    'connecting the crosscutting concept explicitly to the peat-as-matter vs. fire-as-energy distinction this lesson hinges on',
  'Equipment & Technology':
    'offering printed zombie fire photos and poster paper as the default instead of requiring tablets or laptops',
  Engage:
    'opening with what students notice and wonder about the images and video, before revealing the driving question',
  Explore: 'having groups record their cause-and-effect claims on sticky notes to revisit once they build their model',
  Explain: 'framing this as an Initial Model students will revisit later, once they’ve reasoned through matter and energy',
  Elaborate: 'asking students to name whether each revision is about matter, energy, or a cause-and-effect relationship',
  Evaluate: 'giving yourself a short two-item checklist — matter vs. energy, and how the fire persists — to listen for while circulating',
  Assessment: 'adding a peer round of feedback on the initial model before students generate and post their questions to a Driving Question Board',
}

const stepWorkflow: Record<string, { teacherFollowUp: string; aiProposal: string }> = {
  'Crosscutting Concept': {
    teacherFollowUp: 'Can you connect this to why matter and energy behave differently in this lesson?',
    aiProposal:
      'Add a line noting that this lesson asks students to distinguish peat, the matter that fuels the fire, from the energy the fire releases as heat, smoke, and CO₂ — that’s the core idea the crosscutting concept is pointing at here.',
  },
  'Equipment & Technology': {
    teacherFollowUp: "I don't have access to this equipment.",
    aiProposal:
      'No problem — printed zombie fire photos, poster paper, and markers are enough to run the full activity. Skip the digital research tools entirely; a document camera, or just holding models up to the class, works fine for sharing.',
  },
  Engage: {
    teacherFollowUp: "I like that, but I want students to really investigate, not just watch. How do I make that happen?",
    aiProposal:
      'Before revealing the driving question, ask students to turn and talk about what they notice and wonder from the images and video — that gives them ownership of the mystery before you name it.',
  },
  Explore: {
    teacherFollowUp: 'Some groups jump straight to conclusions without real evidence — can I slow that down?',
    aiProposal:
      'Yes — have each group write their cause-and-effect claims on sticky notes, one claim per note, before moving on. That makes their thinking visible and easy to revisit once they build their model.',
  },
  Explain: {
    teacherFollowUp: "That's a good idea, but I don't want it to feel like a worksheet. Can it stay lightweight?",
    aiProposal:
      'We can keep it simple — students just need three labeled boxes (peat/permafrost, underground fire, atmosphere) and arrows showing what they think moves between them. It doesn’t need to be polished yet.',
  },
  Elaborate: {
    teacherFollowUp: 'How can I make sure the annotation actually connects to matter or energy, not just describe what changed?',
    aiProposal:
      'Have students finish the sentence "I changed ___ because it explains ___" and require them to name whether that blank is about matter, energy, or a cause-and-effect relationship — that structure forces the connection.',
  },
  Evaluate: {
    teacherFollowUp: 'I like that, but I only have about 5 minutes for this. What should I actually listen for?',
    aiProposal:
      'Listen for two things: whether a student can say which part of their model is matter and which is energy, and whether they can explain how the fire keeps burning underground through winter. That’s enough to flag who needs support before they generate their questions.',
  },
  Assessment: {
    teacherFollowUp: 'Make sure this ends with real, usable questions instead of vague ones.',
    aiProposal:
      'Have each group narrow to their single best question and post it to a class Driving Question Board — framing it as "what we still need to figure out" keeps it open rather than asking students to restate what they already know.',
  },
}

const demoLessonDocument: LessonDocument = {
  id: 'zombie-fires-demo',
  title: 'Zombie Fires: Matter and Energy Flow (Lesson 1)',
  steps: demoLessonSteps,
  practices: lessonPractices,
  suggestions: lessonSuggestions,
  suggestionSummaries: chatSuggestionSummary,
  revisionSegments: lessonRevisionSegments,
  workflows: stepWorkflow,
}

function LessonRichText({ segments }: { segments: readonly LessonSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => {
        const content = segment.bold ? <strong>{segment.text}</strong> : segment.text
        return segment.added ? (
          <span key={index} className="ai-highlight">
            {content}
          </span>
        ) : (
          <span key={index}>{content}</span>
        )
      })}
    </>
  )
}

// Stands in for a real AI call when the teacher types a follow-up into the
// revision chat (e.g. "Can you make this more focused on matter and energy
// flow?"). The default behavior is to translate the teacher's stated intent
// straight into a concrete revision — a statement, not another question —
// so the interaction reads as a lesson-revision assistant rather than a
// tutoring back-and-forth. A clarifying question is the exception, reserved
// for input too thin to act on (see isTooVagueToActOn below), not the norm.
// The returned proposal always replaces whatever Preview/Apply Change would
// act on next, so a follow-up never silently changes the lesson itself —
// the teacher must still explicitly Preview and/or Apply the new version.
function isTooVagueToActOn(trimmedQuestion: string): boolean {
  const lower = trimmedQuestion.toLowerCase().replace(/[.!?]+$/, '')
  const wordCount = trimmedQuestion.split(/\s+/).filter(Boolean).length
  const fillerPhrases = ['ok', 'okay', 'sure', 'yes', 'no', 'maybe', 'idk', 'hmm', 'help', 'i dont know', "i don't know"]
  return wordCount <= 2 && fillerPhrases.includes(lower)
}

function mockRevisionFollowUpReply(
  label: string,
  question: string,
  currentProposal: string,
): { reply: string; newProposal: string } {
  const trimmed = question.trim()
  const lower = trimmed.toLowerCase()
  const base = currentProposal || `a revision to ${label}`

  // Genuinely too ambiguous to turn into a revision — ask one clarifying
  // question instead of fabricating a change from nothing. This is the
  // exception, not the default: everything below this responds with a
  // concrete proposal.
  if (isTooVagueToActOn(trimmed)) {
    return {
      reply: `Can you say a bit more about what you'd like to change about ${label} — the wording, the activity itself, or how students work through it?`,
      newProposal: currentProposal,
    }
  }

  if (lower.includes('matter') && lower.includes('energy')) {
    return {
      reply:
        'Good catch — here’s a version that’s more explicit about matter and energy. I added a line asking students to label which part of their revision is about matter (peat) moving and which is about energy (heat) being transferred, so that distinction can’t get lost in the wording alone. Preview it below, or keep refining.',
      newProposal: `${base} Label each addition as either matter (what moves) or energy (what transfers), so the distinction is explicit in the model itself, not just implied by the wording.`,
    }
  }

  if (lower.includes('student') && (lower.includes('led') || lower.includes('choice') || lower.includes('ownership'))) {
    return {
      reply:
        'Updated to put more of the decision in students’ hands: instead of you naming the focus upfront, groups decide for themselves what to investigate first, with your original framing available only if a group gets stuck.',
      newProposal: `${base} Let students decide as a group what to investigate first, rather than the teacher naming it — offer your original framing only if a group needs a nudge.`,
    }
  }

  if (lower.includes('open') && lower.includes('end')) {
    return {
      reply:
        'Here’s a more open-ended version — instead of specifying exactly what to add, it asks students to decide for themselves what the new evidence changes about their thinking, which leaves more room for their own reasoning to show through.',
      newProposal: `${base} Rather than specifying exactly what to add, ask students to decide for themselves what the new evidence changes about their thinking, and to explain why.`,
    }
  }

  if (lower.includes('short') || lower.includes('concise') || lower.includes('brief')) {
    const firstSentence = base.split(/(?<=[.?!])\s+/)[0]
    return {
      reply: 'Here’s a shorter version that keeps just the core instructional move.',
      newProposal: firstSentence,
    }
  }

  if (lower.includes('evidence')) {
    return {
      reply:
        'I tied the revision more directly to evidence — students now have to point to something specific from the lesson’s images, data, or readings, not just describe their thinking in general terms.',
      newProposal: `${base} Ask students to point to one specific piece of evidence from the lesson’s images, data, or readings that led to this change.`,
    }
  }

  return {
    reply: `Here’s an updated version of the “${label}” revision that reflects that. Preview it below, or keep refining.`,
    newProposal: `${base} This revision also reflects: “${trimmed}.”`,
  }
}

function buildSectionConversation(
  text: string,
  sectionKey: string | null,
  viaSuggestion: boolean,
  lesson: LessonDocument,
): ChatMessage[] {
  const summary = sectionKey ? lesson.suggestionSummaries[sectionKey] : undefined
  const opener: ChatMessage =
    viaSuggestion && summary
      ? {
          role: 'ai',
          text: `You selected: “${text}” I suggested ${summary}. How would you like to develop this activity?`,
        }
      : {
          role: 'ai',
          text: `You selected: “${text}” What would you like to explore or change about this part of the lesson?`,
        }

  const workflow = sectionKey ? lesson.workflows[sectionKey] : undefined
  if (!workflow) return [opener]

  return [opener, { role: 'teacher', text: workflow.teacherFollowUp }, { role: 'ai', text: workflow.aiProposal }]
}

function useSelectionPopup(containerRef: RefObject<HTMLElement | null>) {
  const [popup, setPopup] = useState<{ text: string; top: number; left: number; sectionKey: string | null } | null>(
    null,
  )

  useEffect(() => {
    const handleMouseUp = () => {
      const container = containerRef.current
      const selection = window.getSelection()
      const text = selection?.toString().trim() ?? ''

      if (!container || !text || !selection || selection.rangeCount === 0) {
        return
      }

      const range = selection.getRangeAt(0)
      const anchorNode = range.commonAncestorContainer
      const anchorElement =
        anchorNode.nodeType === Node.ELEMENT_NODE ? (anchorNode as Element) : anchorNode.parentElement

      if (!container.contains(anchorNode) || anchorElement?.closest('.suggestion-popover')) {
        return
      }

      const sectionKey = anchorElement?.closest('[data-section-key]')?.getAttribute('data-section-key') ?? null
      const rect = range.getBoundingClientRect()
      setPopup({ text, top: rect.top, left: rect.left + rect.width / 2, sectionKey })
    }

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (target?.closest('.selection-ask-popup')) return
      setPopup(null)
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('mousedown', handleMouseDown)
    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('mousedown', handleMouseDown)
    }
  }, [containerRef])

  const clear = () => setPopup(null)

  return { popup, clear }
}

function SelectionAskAIPopup({
  popup,
  onAskAI,
}: {
  popup: { text: string; top: number; left: number; sectionKey: string | null } | null
  onAskAI: (text: string, sectionKey: string | null) => void
}) {
  if (!popup) return null

  return (
    <div className="selection-ask-popup" style={{ top: popup.top, left: popup.left }}>
      <button type="button" className="ask-ai-chip" onClick={() => onAskAI(popup.text, popup.sectionKey)}>
        See AI Suggestions
      </button>
    </div>
  )
}

type EditStage = 'chatting' | 'applied'

// One section's revision conversation: its chat history, its current stage,
// and the concrete proposal text that Apply Change acts on. `proposalSegments`
// carries the rich (bold/added) formatting for the canned first proposal
// (see lessonRevisionSegments) so the proposed-change card can highlight
// exactly what's new; once the teacher asks a follow-up, the new proposal is
// a plain string and this is cleared.
type SectionRevisionState = {
  stage: EditStage
  messages: ChatMessage[]
  proposal: string
  proposalSegments?: readonly LessonSegment[]
}

// Drives the whole "See AI Suggestions / Apply Change" workflow for every
// lesson section, in one place, regardless of whether a section's
// suggestion came from a pre-flagged AI Suggestion or a manual text-
// selection. There is exactly one lesson (no separate Original / AI
// Suggestions / AI Revised versions) — `revisedLesson` is the only place a
// section's permanent text changes, and only in response to an explicit
// Apply Change. As soon as the AI has a concrete proposal it's shown in
// full in the proposed-change card — there's no separate "preview" step to
// trigger first; Apply Change is available immediately.
// `onApply` lets the lesson's manual-edit state (lifted to App) react to an
// Apply Change, so an applied AI revision becomes the section's ordinary
// current text — see its definition in App.
function useRevisionWorkflow(onApply?: (label: string, text: string) => void) {
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [statesByLabel, setStatesByLabel] = useState<Record<string, SectionRevisionState>>({})
  const [revisedLesson, setRevisedLesson] = useState<Record<string, string>>({})
  // Rich (bold/added) segments for an APPLIED section on the working lesson
  // (Generated/Suggestions), kept separately from revisedLesson's flat text
  // so only the part AI actually contributed gets the yellow highlight —
  // never the section's original wording. Present only when we can be
  // confident which part is new (see apply() below); otherwise the plain
  // flat text falls back to a whole-section highlight.
  const [revisedLessonSegments, setRevisedLessonSegments] = useState<Record<string, readonly LessonSegment[] | undefined>>({})
  const [isThinking, setIsThinking] = useState(false)
  const thinkingTimeoutRef = useRef<number | null>(null)
  // Briefly marks whichever section was just applied, so the lesson plan
  // can flash a short success highlight there before it fades — see
  // .section-just-applied.
  const [justAppliedLabel, setJustAppliedLabel] = useState<string | null>(null)
  const justAppliedTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (thinkingTimeoutRef.current !== null) window.clearTimeout(thinkingTimeoutRef.current)
      if (justAppliedTimeoutRef.current !== null) window.clearTimeout(justAppliedTimeoutRef.current)
    }
  }, [])

  // Opens (or restarts) a section's conversation and switches the left
  // workspace to it — via a flagged AI suggestion ("See AI Suggestions") or a
  // freeform text selection. `proposal` seeds the proposed-change card;
  // freeform selections have none, so they get a conversation with no
  // apply step until one exists.
  const ask = (label: string, messages: ChatMessage[], proposal?: string, proposalSegments?: readonly LessonSegment[]) => {
    setStatesByLabel((prev) => ({
      ...prev,
      [label]: { stage: 'chatting', messages, proposal: proposal ?? '', proposalSegments },
    }))
    setActiveLabel(label)
  }

  const closeChat = () => setActiveLabel(null)

  // Clears every section's conversation and applied revision — for when a
  // different lesson replaces this one.
  const reset = () => {
    if (thinkingTimeoutRef.current !== null) window.clearTimeout(thinkingTimeoutRef.current)
    setIsThinking(false)
    setActiveLabel(null)
    setStatesByLabel({})
    setRevisedLesson({})
    setRevisedLessonSegments({})
    setJustAppliedLabel(null)
  }

  const reopen = (label: string) => setActiveLabel(label)

  // `editedText` is the teacher's own edit of the proposed change (via the
  // card's Edit button), when they made one — whatever they applied becomes
  // the section's text, and the conversation's proposal from then on.
  const apply = (label: string, editedText?: string) => {
    // Reads the current section's state from the hook's own closure rather
    // than a setState updater's `prev` — deliberately. Nesting one setState
    // call inside another updater looks convenient, but under React 18
    // StrictMode that outer updater gets invoked twice, so the nested call
    // fires twice too; for a non-idempotent computation like "extend these
    // segments by a suffix" that double-fire corrupts the result (the
    // second pass ends up diffing the already-extended array against
    // itself). Reading `state` here and issuing every setState call
    // independently — each a pure function of its own prior value — avoids
    // that entirely.
    const current = statesByLabel[label]
    if (!current) return
    // A teacher-edited proposal no longer matches the canned segment
    // boundaries or the follow-up "previous text + suffix" shape, so it
    // drops its segments and takes the whole-section highlight fallback.
    const teacherEdited = editedText !== undefined && editedText !== current.proposal
    const state: SectionRevisionState = teacherEdited
      ? { ...current, proposal: editedText, proposalSegments: undefined }
      : current

    setRevisedLesson((revised) => ({ ...revised, [label]: state.proposal }))

    setRevisedLessonSegments((prevSegments) => {
      if (teacherEdited) return { ...prevSegments, [label]: undefined }
      if (state.proposalSegments) {
        // Applying the canned first proposal — its added/plain segment
        // boundaries are already exact (see lessonRevisionSegments), so
        // use them directly rather than trying to re-derive them.
        return { ...prevSegments, [label]: state.proposalSegments }
      }
      // A follow-up round: mockRevisionFollowUpReply always builds its new
      // proposal as `${previous proposal text} <new text>`, so the text
      // that was already applied (whatever its own added/plain makeup was)
      // is still a literal prefix of this one — extend those existing
      // segments with just the new suffix, rather than losing earlier
      // rounds' highlighting or re-highlighting the whole thing.
      const previousSegments = prevSegments[label]
      const previousText = previousSegments ? segmentsToText(previousSegments) : undefined
      if (previousText !== undefined && state.proposal.startsWith(previousText) && state.proposal.length > previousText.length) {
        return {
          ...prevSegments,
          [label]: [...previousSegments!, { text: state.proposal.slice(previousText.length), added: true }],
        }
      }
      // No usable prior segments to extend (first-ever apply for this
      // section came from a follow-up, not the canned proposal; or the new
      // text isn't a simple extension of the old) — we genuinely can't tell
      // which part is new, so fall back to highlighting the whole thing.
      return { ...prevSegments, [label]: undefined }
    })

    setStatesByLabel((prev) =>
      prev[label]
        ? {
            ...prev,
            [label]: {
              ...prev[label],
              stage: 'applied',
              proposal: state.proposal,
              proposalSegments: state.proposalSegments,
            },
          }
        : prev,
    )

    onApply?.(label, state.proposal)

    setJustAppliedLabel(label)
    if (justAppliedTimeoutRef.current !== null) window.clearTimeout(justAppliedTimeoutRef.current)
    justAppliedTimeoutRef.current = window.setTimeout(() => setJustAppliedLabel(null), 1200)
  }

  // A follow-up typed into the left chat: push the teacher's message, wait
  // briefly (mirrors the "AI is thinking…" pattern used elsewhere in the
  // app), then push a reply. When the reply carries an actual new proposal,
  // stage resets to 'chatting' even if the section was already applied, so
  // the teacher must explicitly Apply the new proposal too — a follow-up
  // never silently overwrites an already-applied section. When the
  // teacher's message was too vague to act on, the mock reply's proposal
  // comes back unchanged (see isTooVagueToActOn) and this leaves
  // stage/proposalSegments untouched rather than discarding a perfectly
  // good pending or already-applied proposal just because the teacher asked
  // a clarifying follow-up.
  const sendFollowUp = (label: string, question: string) => {
    setStatesByLabel((prev) => {
      const state = prev[label]
      if (!state) return prev
      return { ...prev, [label]: { ...state, messages: [...state.messages, { role: 'teacher', text: question }] } }
    })
    setIsThinking(true)
    if (thinkingTimeoutRef.current !== null) window.clearTimeout(thinkingTimeoutRef.current)
    thinkingTimeoutRef.current = window.setTimeout(() => {
      setStatesByLabel((prev) => {
        const state = prev[label]
        if (!state) return prev
        const { reply, newProposal } = callAiModel(
          'lesson-revision',
          { label, question, currentProposal: state.proposal },
          (request) => mockRevisionFollowUpReply(request.label, request.question, request.currentProposal),
        )
        const proposalChanged = newProposal !== state.proposal
        return {
          ...prev,
          [label]: {
            stage: proposalChanged ? 'chatting' : state.stage,
            messages: [...state.messages, { role: 'ai', text: reply }],
            proposal: newProposal,
            proposalSegments: proposalChanged ? undefined : state.proposalSegments,
          },
        }
      })
      setIsThinking(false)
    }, 700)
  }

  return {
    activeLabel,
    statesByLabel,
    revisedLesson,
    revisedLessonSegments,
    isThinking,
    justAppliedLabel,
    ask,
    closeChat,
    reset,
    reopen,
    apply,
    sendFollowUp,
  }
}

type RevisionWorkflow = ReturnType<typeof useRevisionWorkflow>

// Shared rendering for every chatbot/AI conversation thread in the app, so
// the AI-left / Teacher-right alignment and "AI"/"You" speaker labels stay
// consistent everywhere — including messages added later during an
// interaction, since they all flow through this same render path.
// `renderAfterMessage` adds something right under a message (e.g. the
// Student Feedback rating buttons), inside the same scrolling thread.
function ChatThread({
  messages,
  className,
  renderAfterMessage,
}: {
  messages: readonly ChatMessage[]
  className?: string
  renderAfterMessage?: (message: ChatMessage, index: number) => ReactNode
}) {
  return (
    <div className={className ? `chat-thread ${className}` : 'chat-thread'}>
      {messages.map((message, index) => (
        <Fragment key={index}>
          <div className={`chat-message ${message.role === 'teacher' ? 'teacher-message' : 'ai-message'}`}>
            <p className="chat-message-label">{message.role === 'teacher' ? 'You' : 'AI'}</p>
            {message.text}
          </div>
          {renderAfterMessage?.(message, index)}
        </Fragment>
      ))}
    </div>
  )
}

type FeedbackRating = 'up' | 'down'

function ThumbIcon({ down = false }: { down?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
      style={down ? { transform: 'rotate(180deg)' } : undefined}
    >
      <path
        fill="currentColor"
        d="M2 21h3V9H2v12Zm19.6-9.7c.3-.4.4-.9.4-1.3 0-1.1-.9-2-2-2h-5.3l.8-3.8v-.3c0-.4-.2-.8-.4-1.1L14.1 2 7.6 8.6c-.4.4-.6.9-.6 1.4V19c0 1.1.9 2 2 2h8.1c.8 0 1.5-.5 1.8-1.2l2.6-6.1c.1-.2.1-.5.1-.7v-1.7Z"
      />
    </svg>
  )
}

// Optional thumbs up/down on one AI message. Clicking the selected rating
// again removes it.
function FeedbackRatingButtons({ rating, onChange }: { rating?: FeedbackRating; onChange: (next: FeedbackRating | undefined) => void }) {
  return (
    <div className="feedback-rating" role="group" aria-label="Rate this feedback">
      {(['up', 'down'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={`feedback-rating-button${rating === value ? ` selected-${value}` : ''}`}
          aria-label={value === 'up' ? 'Helpful' : 'Not helpful'}
          aria-pressed={rating === value}
          title={value === 'up' ? 'Helpful' : 'Not helpful'}
          onClick={() => onChange(rating === value ? undefined : value)}
        >
          <ThumbIcon down={value === 'down'} />
        </button>
      ))}
    </div>
  )
}

// Renders in the LEFT workspace (Form / AI Chat panel), not inline in the
// lesson content — the right side stays the lesson plan itself. One panel
// covers the whole "See AI Suggestions → Apply Change" workflow for
// whichever section is currently active.
function RevisionChatPanel({
  label,
  state,
  isThinking,
  draft,
  onDraftChange,
  onSend,
  onApply,
  onClose,
}: {
  label: string
  state: SectionRevisionState
  isThinking: boolean
  draft: string
  onDraftChange: (value: string) => void
  onSend: () => void
  onApply: (editedText?: string) => void
  onClose: () => void
}) {
  const hasProposal = Boolean(state.proposal)
  // The teacher's working copy of the proposal while its Edit mode is open
  // (null = showing the AI's proposal as-is). Dropped whenever the section
  // or the proposal itself changes, so a stale edit never gets applied to
  // a different proposal.
  const [proposalDraft, setProposalDraft] = useState<string | null>(null)
  const isEditingProposal = proposalDraft !== null

  useEffect(() => {
    setProposalDraft(null)
  }, [label, state.proposal])

  // The section's chat (history + message input) stays tucked away until
  // the teacher chooses "Ask AI about this" — except when there's no
  // proposal to review (a question about highlighted text), where the chat
  // is the whole point.
  const [isChatOpen, setIsChatOpen] = useState(!hasProposal)

  return (
    <div className="revision-chat-panel">
      <div className="revision-chat-header">
        <div>
          <p className="card-label">Discussing this section</p>
          <h4>{label}</h4>
        </div>
        <button type="button" className="drawer-close" aria-label="Close conversation" onClick={onClose}>
          ×
        </button>
      </div>

      {/* The suggested revision comes first. Apply to Lesson applies
          whatever the card currently says (including the teacher's own
          edit); a reply in the chat below can replace the proposal, but
          nothing is ever applied without Apply to Lesson. */}
      {state.stage === 'chatting' && hasProposal && (
        <div className="inline-ai-preview">
          <p className="card-label">Suggested revision — not yet applied</p>
          {isEditingProposal ? (
            <textarea
              aria-label="Edit suggested revision"
              rows={4}
              value={proposalDraft}
              onChange={(event) => setProposalDraft(event.target.value)}
              autoFocus
            />
          ) : (
            <p>{state.proposalSegments ? <LessonRichText segments={state.proposalSegments} /> : state.proposal}</p>
          )}
          <div className="revision-actions">
            <button
              type="button"
              className="accept-button"
              onClick={() => onApply(proposalDraft ?? undefined)}
              disabled={isThinking || (isEditingProposal && !proposalDraft.trim())}
            >
              Apply to Lesson
            </button>
            {isEditingProposal ? (
              <button type="button" className="proposal-edit-button" onClick={() => setProposalDraft(null)}>
                Cancel Edit
              </button>
            ) : (
              <button
                type="button"
                className="proposal-edit-button"
                onClick={() => setProposalDraft(state.proposal)}
                disabled={isThinking}
              >
                Edit
              </button>
            )}
            <button
              type="button"
              className="proposal-edit-button"
              aria-expanded={isChatOpen}
              aria-controls="revision-chat"
              onClick={() => setIsChatOpen((open) => !open)}
            >
              {isChatOpen ? 'Hide AI chat' : 'Ask AI about this'}
            </button>
          </div>
        </div>
      )}

      {state.stage === 'applied' && (
        <div className="revision-applied-row">
          <p className="inline-ai-applied-note">✓ Applied to Lesson</p>
          {!isChatOpen && (
            <button
              type="button"
              className="proposal-edit-button"
              aria-expanded={false}
              aria-controls="revision-chat"
              onClick={() => setIsChatOpen(true)}
            >
              Ask AI about this
            </button>
          )}
        </div>
      )}

      {isChatOpen && (
        <div className="revision-chat" id="revision-chat">
          <ChatThread messages={state.messages} className="revision-chat-thread" />
          {isThinking && <p className="empty-state-support">AI is thinking…</p>}

          {/* Sending pauses while the proposal is being edited — a follow-up
              reply would replace the proposal and discard the teacher's edit. */}
          <div className="composer-box">
            <input
              type="text"
              placeholder={isEditingProposal ? 'Apply or cancel your edit to keep chatting...' : 'Ask about this revision...'}
              value={draft}
              autoFocus={hasProposal}
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !isEditingProposal) onSend()
              }}
              disabled={isThinking || isEditingProposal}
            />
            <button
              type="button"
              className="primary-button"
              onClick={onSend}
              disabled={isThinking || isEditingProposal || !draft.trim()}
            >
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function App() {
  // A bare URL opens on the mock Login page; existing #page links still
  // jump straight to that page. Read once at init (not in an effect) so the
  // hash-writing effect below can't overwrite it first.
  const [activePage, setActivePage] = useState<PageId>(getInitialPage)
  const [navOpen, setNavOpen] = useState(false)

  // Lifted out of the lesson workspace canvas so accepted revisions,
  // conversation history, and manual edits survive navigating to another
  // page (Class/Student Feedback) and back to Lesson Planning. `planningTab`
  // is lifted too (rather than living inside LessonPlanningPanel) so that
  // clicking "See AI Suggestions" on the right can reliably switch the
  // left panel over to its AI Chat tab.
  const [planningTab, setPlanningTab] = useState<PlanningTab>('none')
  // Suggestions the teacher dismissed (by section) — their original text is
  // kept and the suggestion is hidden until restored.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<string[]>([])
  // How the lesson in the workspace arrived: generated from the form, or an
  // uploaded lesson the AI reviewed.
  const [lessonSource, setLessonSource] = useState<LessonSource>('ai-generated')
  const [isEditingLesson, setIsEditingLesson] = useState(false)
  const [manualEdits, setManualEdits] = useState<Record<string, string>>({})
  const [draftBySection, setDraftBySection] = useState<Record<string, string>>({})
  const [editBaseline, setEditBaseline] = useState<Record<string, string>>({})
  // An applied AI revision is the section's newest wording, so it replaces
  // any earlier manual edit (which would otherwise keep winning for display
  // and make Edit Lesson reopen the pre-AI text) and flows straight into the
  // edit drafts — including mid-edit, when the teacher applied from the chat
  // while Edit Lesson was open. The baseline moves with it so saving without
  // further changes doesn't record the AI text as a manual edit. From here
  // on it's ordinary lesson content the teacher can edit like any other.
  const revisionEditor = useRevisionWorkflow((label, text) => {
    setManualEdits((prev) => {
      if (!(label in prev)) return prev
      const next = { ...prev }
      delete next[label]
      return next
    })
    setDraftBySection((prev) => ({ ...prev, [label]: text }))
    setEditBaseline((prev) => ({ ...prev, [label]: text }))
  })

  // Generate Lesson no longer navigates away from the Lesson Planning page —
  // it reveals the generated lesson in the workspace panel on the right,
  // in place, so the form and any AI Chat conversation on the left stay
  // exactly as the teacher left them. This state is lifted to App so a
  // generated lesson survives navigating to another page and back.
  const [lessonGenerated, setLessonGenerated] = useState(false)
  const [isGeneratingLesson, setIsGeneratingLesson] = useState(false)
  // The lesson shown in the workspace.
  const [lessonDocument, setLessonDocument] = useState<LessonDocument>(demoLessonDocument)
  // The lesson's Student Feedback Activities, and the Library lesson the
  // workspace lesson is saved as (if any) so they stay with it.
  const [feedbackActivities, setFeedbackActivities] = useState<FeedbackActivity[]>(() => identifyFeedbackActivities(demoLessonDocument))
  const [workspaceLessonId, setWorkspaceLessonId] = useState<string | null>(null)
  // The assignment a Student Feedback link opened, if the page came from one.
  const [studentAssignment, setStudentAssignment] = useState<StudentAssignmentLink | null>(readStudentAssignmentFromHash)
  // A different lesson starts with no revisions, conversations, dismissed
  // suggestions, or manual edits carried over from the previous one.
  const showLessonDocument = (
    document: LessonDocument,
    libraryLessonId: string | null,
    activities: FeedbackActivity[] = identifyFeedbackActivities(document),
  ) => {
    setFeedbackActivities(activities)
    setWorkspaceLessonId(libraryLessonId)
    revisionEditor.reset()
    setDismissedSuggestions([])
    setManualEdits({})
    setDraftBySection({})
    setEditBaseline({})
    setIsEditingLesson(false)
    setPlanningTab((tab) => (tab === 'revision' ? 'none' : tab))
    setLessonDocument(document)
  }
  const generateLessonTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (generateLessonTimeoutRef.current !== null) window.clearTimeout(generateLessonTimeoutRef.current)
    }
  }, [])

  // Which Library lesson (if any) the current page was opened from — drives
  // the context banner that tells the teacher which demo content they're
  // looking at. Cleared by any navigation that doesn't come from a card.
  const [libraryContext, setLibraryContext] = useState<LibraryContext | null>(null)
  const [studentFeedbackTab, setStudentFeedbackTab] = useState<ModelTab>('descriptive')

  // Library classes (and any created with New Class) plus which cards are
  // expanded live here so they survive navigating to a lesson page and back.
  const [libraryLessons, setLibraryLessons] = useState<LibraryLesson[]>(initialLibraryLessons)
  const [libraryClasses, setLibraryClasses] = useState<LibraryClass[]>(() => getInitialLibraryData().classes)
  const [students, setStudents] = useState<Student[]>(() => getInitialLibraryData().students)
  // The lesson Class Feedback is showing — set from the Library; the main
  // nav shows the Library's demo lesson, whose class data the page has.
  const [classFeedbackLessonId, setClassFeedbackLessonId] = useState<string | null>(null)
  const classFeedbackLesson =
    libraryLessons.find((lesson) => lesson.id === classFeedbackLessonId) ??
    libraryLessons.find((lesson) => lesson.id === analyzedClassFeedbackLessonIds[0]) ??
    initialLibraryLessons[0]

  // Keep the AI gateway's list of student identifiers in step with the
  // registry, so new or renamed students are redacted from AI requests too.
  useEffect(() => {
    syncAiRosterGuard(students)
  }, [students])

  const [teacherAccounts, setTeacherAccounts] = useState<Record<string, TeacherAccount>>({
    [DEMO_TEACHER_EMAIL]: { email: DEMO_TEACHER_EMAIL, onboardingComplete: true, state: null, district: '' },
  })
  // Pages opened without logging in (e.g. a #library link) act as the demo
  // teacher, so the prototype stays navigable.
  const [currentTeacherEmail, setCurrentTeacherEmail] = useState(DEMO_TEACHER_EMAIL)
  const currentAccount: TeacherAccount = teacherAccounts[currentTeacherEmail] ?? {
    email: currentTeacherEmail,
    onboardingComplete: false,
    state: null,
    district: '',
  }
  const myClasses = libraryClasses.filter((classroom) => classroom.ownerEmail === currentTeacherEmail)
  const myLessons = libraryLessons.filter((lesson) => lesson.ownerEmail === currentTeacherEmail)
  const [libraryView, setLibraryView] = useState<LibraryViewState>({ expandedClassIds: [], openLessonKey: null })
  // Set by the Library's "+ Create a Class" so Class Setup opens with its
  // create form showing; any other navigation clears it.
  const [startCreatingClass, setStartCreatingClass] = useState(false)

  // Set when Lesson Planning was opened from a class card's Add Lesson: the
  // lesson generated or uploaded there is saved to that class. Once saved,
  // savedLessonId makes a re-generate update that lesson instead of adding a
  // duplicate. Any other route to Lesson Planning (main nav, Create a
  // Lesson, a lesson's own Lesson Planning button) clears it, so the normal
  // workflow never assigns a class.
  const [planningTarget, setPlanningTarget] = useState<PlanningTarget | null>(null)

  // The class the teacher is working with, shared by Class Setup (its
  // roster and Continue pickers), Lesson Planning (via planningTarget) and
  // the Library (which expands it). Set from any of them.
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null)
  const planningTargetClass = planningTarget
    ? (myClasses.find((classroom) => classroom.id === planningTarget.classId) ?? null)
    : null
  const planningTargetLesson = planningTarget?.savedLessonId
    ? (libraryLessons.find((lesson) => lesson.id === planningTarget.savedLessonId) ?? null)
    : null

  const expandLibraryClass = (classId: string) => {
    setLibraryView((prev) =>
      prev.expandedClassIds.includes(classId) ? prev : { ...prev, expandedClassIds: [...prev.expandedClassIds, classId] },
    )
  }

  const navigateTo = (page: PageId) => {
    setLibraryContext(null)
    setStudentAssignment(null)
    setClassFeedbackLessonId(null)
    setPlanningTarget(null)
    setStartCreatingClass(false)
    if (page === 'library' && selectedClassId) expandLibraryClass(selectedClassId)
    setActivePage(page)
  }

  const handleCreateClassFromLibrary = () => {
    navigateTo('class-setup')
    setStartCreatingClass(true)
  }

  const resetGeneratedLesson = () => {
    if (generateLessonTimeoutRef.current !== null) window.clearTimeout(generateLessonTimeoutRef.current)
    setIsGeneratingLesson(false)
    setLessonGenerated(false)
  }

  const handleAddLessonToClass = (classroom: LibraryClass) => {
    resetGeneratedLesson()
    setLibraryContext(null)
    setSelectedClassId(classroom.id)
    setPlanningTarget({ classId: classroom.id, savedLessonId: null })
    setActivePage('lesson-generator')
  }

  const handleViewClassInLibrary = (classId: string) => {
    setSelectedClassId(classId)
    expandLibraryClass(classId)
    navigateTo('library')
  }

  const saveLessonForPlanningTarget = (
    details: PlanningLessonDetails,
    document: LessonDocument,
    uploadedFileName?: string,
  ): string | null => {
    if (!planningTarget || !planningTargetClass) return null
    const { classId, savedLessonId } = planningTarget
    if (savedLessonId) {
      setLibraryLessons((prev) =>
        prev.map((lesson) =>
          lesson.id === savedLessonId
            ? createLibraryLessonFromPlanning(savedLessonId, details, lesson.bannerColor, lesson.ownerEmail, uploadedFileName, document)
            : lesson,
        ),
      )
      return savedLessonId
    }
    const id = `lesson-${Date.now()}`
    setLibraryLessons((prev) => [
      ...prev,
      createLibraryLessonFromPlanning(
        id,
        details,
        lessonBannerColors[prev.length % lessonBannerColors.length],
        currentTeacherEmail,
        uploadedFileName,
        document,
      ),
    ])
    setLibraryClasses((prev) =>
      prev.map((classroom) =>
        classroom.id === classId ? { ...classroom, lessonIds: [...classroom.lessonIds, id] } : classroom,
      ),
    )
    setPlanningTarget({ classId, savedLessonId: id })
    return id
  }

  // Teacher changes to the Student Feedback Activities. For a lesson saved
  // in the Library they're kept with it, and once all are confirmed the
  // lesson lists the assignment under Student Feedback.
  const lessonLinkId = workspaceLessonId ?? lessonDocument.id
  const updateFeedbackActivities = (next: FeedbackActivity[]) => {
    setFeedbackActivities(next)
    if (!workspaceLessonId) return
    const link = assignmentLinkFor(lessonLinkId, lessonDocument.title, next)
    const assignmentId = `${workspaceLessonId}-feedback-activities`
    setLibraryLessons((prev) =>
      prev.map((lesson) =>
        lesson.id === workspaceLessonId
          ? {
              ...lesson,
              lessonPlan: { ...lesson.lessonPlan, feedbackActivities: next },
              studentFeedback: [
                ...lesson.studentFeedback.filter((assignment) => assignment.id !== assignmentId),
                ...(link ? [{ id: assignmentId, title: 'Student Feedback Activities', modelTab: 'descriptive' as const, link }] : []),
              ],
            }
          : lesson,
      ),
    )
  }

  // Returns an error message for the login form, or null on success. A
  // first login with an unknown email creates the account, like Create
  // Account does.
  const handleLogin = ({ email: rawEmail, mode, state, district }: MockLoginCredentials): string | null => {
    const email = rawEmail.trim().toLowerCase() || DEMO_TEACHER_EMAIL
    const existing = teacherAccounts[email]
    if (mode === 'create' && existing) return 'An account with this email already exists. Log in instead.'
    if (mode === 'create' && (!state || !district?.trim())) return 'Choose your state and enter your school district.'
    const account: TeacherAccount = existing ?? {
      email,
      onboardingComplete: false,
      state: mode === 'create' && state ? state : null,
      district: mode === 'create' ? (district ?? '').trim() : '',
    }
    if (!existing) setTeacherAccounts((prev) => ({ ...prev, [email]: account }))
    setCurrentTeacherEmail(email)
    setSelectedClassId(null)
    navigateTo(getPostLoginPage())
    return null
  }

  // Class Setup's "Continue to Lesson Planning": opens Lesson Planning for
  // the selected class (so the new lesson is saved to it), the same way a
  // Library card's Add Lesson does. For a first-time teacher this is the
  // last onboarding step.
  const handleContinueToPlanning = (classroom: LibraryClass) => {
    if (!currentAccount.onboardingComplete) {
      setTeacherAccounts((prev) => ({
        ...prev,
        [currentTeacherEmail]: { ...currentAccount, onboardingComplete: true },
      }))
    }
    handleAddLessonToClass(classroom)
  }

  // Only lessons with prototype content behind them reveal the generated
  // lesson workspace; the rest open on the blank planning form so the
  // teacher never sees one lesson's content under another lesson's title.
  const handleOpenLessonPlan = (lesson: LibraryLesson, classroom: LibraryClass | null) => {
    resetGeneratedLesson()
    const document = lesson.lessonPlan.document ?? demoLessonDocument
    showLessonDocument(document, lesson.id, lesson.lessonPlan.feedbackActivities ?? identifyFeedbackActivities(document))
    setLessonGenerated(lesson.lessonPlan.hasDemoContent)
    setPlanningTarget(null)
    setLibraryContext({ lesson, className: classroom ? classDisplayName(classroom) : undefined, page: 'lesson-generator' })
    setActivePage('lesson-generator')
  }

  const handleOpenStudentFeedback = (
    lesson: LibraryLesson,
    assignment: StudentFeedbackAssignment,
    classroom: LibraryClass | null,
  ) => {
    setStudentFeedbackTab(assignment.modelTab)
    setStudentAssignment(assignment.link ?? null)
    setLibraryContext({ lesson, className: classroom ? classDisplayName(classroom) : undefined, page: 'student-feedback', assignmentTitle: assignment.title })
    setActivePage('student-feedback')
  }

  const handleOpenClassFeedback = (lesson: LibraryLesson, classroom: LibraryClass | null) => {
    setClassFeedbackLessonId(lesson.id)
    setLibraryContext({ lesson, className: classroom ? classDisplayName(classroom) : undefined, page: 'class-feedback-dashboard' })
    setActivePage('class-feedback-dashboard')
  }

  const handleGenerateLessonPlan = (details: PlanningLessonDetails) => {
    if (isGeneratingLesson) return
    const document = generateLessonDocument(details)
    showLessonDocument(document, saveLessonForPlanningTarget(details, document))
    setLessonSource('ai-generated')
    setIsGeneratingLesson(true)
    generateLessonTimeoutRef.current = window.setTimeout(() => {
      setLessonGenerated(true)
      setIsGeneratingLesson(false)
    }, 900)
  }

  // Upload is only wired up when adding a lesson to a class (see
  // onUploadLesson on LessonPlanningPanel): it saves the file as that class's
  // lesson and opens it in the workspace the same way Generate does.
  const handleUploadLesson = (file: File, details: PlanningLessonDetails) => {
    if (isGeneratingLesson) return
    // Uploaded files aren't read yet, so the prototype shows its demo lesson.
    showLessonDocument(demoLessonDocument, saveLessonForPlanningTarget(details, demoLessonDocument, file.name))
    setLessonSource('uploaded')
    setIsGeneratingLesson(true)
    generateLessonTimeoutRef.current = window.setTimeout(() => {
      setLessonGenerated(true)
      setIsGeneratingLesson(false)
    }, 900)
  }

  const canvasProps: LessonWorkspaceCanvasProps = {
    editor: revisionEditor,
    lesson: lessonDocument,
    lessonLinkId,
    feedbackActivities,
    onFeedbackActivitiesChange: updateFeedbackActivities,
    setPlanningTab,
    lessonSource,
    dismissedSuggestions,
    setDismissedSuggestions,
    isEditing: isEditingLesson,
    setIsEditing: setIsEditingLesson,
    manualEdits,
    setManualEdits,
    draftBySection,
    setDraftBySection,
    editBaseline,
    setEditBaseline,
  }

  const planningPanelProps = {
    planningTab,
    setPlanningTab,
    revisionEditor,
    // A teacher's own state framework comes first; NGSS otherwise.
    defaultFramework: (currentAccount.state ?? 'NGSS') as StandardsFrameworkId,
  }

  useEffect(() => {
    window.location.hash = activePage === 'student-feedback' && studentAssignment ? studentAssignmentHash(studentAssignment) : activePage
  }, [activePage, studentAssignment])

  useEffect(() => {
    // Follows a link opened in this tab — a Student Feedback link included.
    const handleHashChange = () => {
      setStudentAssignment(readStudentAssignmentFromHash())
      setActivePage(getInitialPage())
    }
    window.addEventListener('hashchange', handleHashChange)
    return () => window.removeEventListener('hashchange', handleHashChange)
  }, [])

  useEffect(() => {
    if (!navOpen) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [navOpen])

  const currentPage = useMemo(
    () => PAGE_CONFIG.find((page) => page.id === activePage) ?? PAGE_CONFIG[0],
    [activePage],
  )

  if (activePage === 'login') return <LoginPage onLogin={handleLogin} />

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-brand">
          <button
            type="button"
            className="menu-button"
            aria-label="Open prototype navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <BrandWordmark />
        </div>
      </header>

      <main className="app-main">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Workspace</p>
            <h2>{currentPage.title ?? currentPage.label}</h2>
          </div>
          {activePage === 'library' && (
            <button type="button" className="primary-button" onClick={handleCreateClassFromLibrary}>
              + Create a Class
            </button>
          )}
        </div>

        {libraryContext?.page === activePage && (
          <LibraryContextBanner context={libraryContext} onDismiss={() => setLibraryContext(null)} />
        )}

        {activePage === 'lesson-generator' && !currentAccount.onboardingComplete && !planningTarget && (
          <div className="library-context-banner planning-class-banner" role="status">
            <span className="library-context-swatch onboarding-swatch" aria-hidden="true" />
            <p>
              <strong>Set up your first class before planning lessons</strong>
              <br />
              <span>Create a class and upload its student roster, then come back to plan your first lesson.</span>
            </p>
            <button type="button" className="secondary-button" onClick={() => navigateTo('class-setup')}>
              Go to Class Setup
            </button>
          </div>
        )}

        {activePage === 'lesson-generator' && planningTarget && planningTargetClass && (
          <PlanningClassBanner
            classroom={planningTargetClass}
            savedLesson={planningTargetLesson}
            onViewInLibrary={() => handleViewClassInLibrary(planningTargetClass.id)}
            onDismiss={() => setPlanningTarget(null)}
          />
        )}

        {activePage === 'library' && (
          <LibraryPage
            lessons={myLessons}
            classes={myClasses}
            view={libraryView}
            setView={setLibraryView}
            nav={{
              onOpenLessonPlan: handleOpenLessonPlan,
              onOpenStudentFeedback: handleOpenStudentFeedback,
              onOpenClassFeedback: handleOpenClassFeedback,
            }}
            onAddLesson={handleAddLessonToClass}
          />
        )}

        {activePage === 'class-setup' && (
          <ClassSetupPage
            key={currentTeacherEmail}
            classes={myClasses}
            setClasses={setLibraryClasses}
            students={students}
            setStudents={setStudents}
            ownerEmail={currentTeacherEmail}
            startCreating={startCreatingClass}
            onboarding={!currentAccount.onboardingComplete}
            selectedClassId={selectedClassId}
            onSelectClass={setSelectedClassId}
            onContinueToPlanning={handleContinueToPlanning}
            onViewInLibrary={handleViewClassInLibrary}
          />
        )}

        {activePage === 'lesson-generator' && (
          <LessonPlanningPage
            onGenerateLessonPlan={handleGenerateLessonPlan}
            onUploadLesson={planningTargetClass ? handleUploadLesson : undefined}
            lessonGenerated={lessonGenerated}
            isGeneratingLesson={isGeneratingLesson}
            canvasProps={canvasProps}
            planningPanelProps={planningPanelProps}
          />
        )}
        {activePage === 'student-feedback' && (
          <StudentFeedbackPage
            key={`${studentFeedbackTab}:${studentAssignment ? studentAssignmentHash(studentAssignment) : ''}`}
            initialModelTab={studentFeedbackTab}
            assignment={studentAssignment}
          />
        )}
        {activePage === 'class-feedback-dashboard' && <FeedbackDashboardPage key={classFeedbackLesson.id} lesson={classFeedbackLesson} />}
      </main>

      {navOpen && (
        <div className="nav-drawer-backdrop" onClick={() => setNavOpen(false)}>
          <aside
            className="nav-drawer"
            role="dialog"
            aria-label="Prototype navigation"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="nav-drawer-header">
              <div>
                <p className="eyebrow">Prototype Navigation</p>
                <p className="nav-drawer-subtitle">Jump between mockup states for demos.</p>
              </div>
              <button
                type="button"
                className="drawer-close"
                aria-label="Close navigation"
                onClick={() => setNavOpen(false)}
              >
                ×
              </button>
            </div>

            <nav className="page-nav" aria-label="Prototype pages">
              {PAGE_CONFIG.map((page) => (
                <button
                  key={page.id}
                  type="button"
                  className={`nav-button ${activePage === page.id ? 'active' : ''}`}
                  onClick={() => {
                    navigateTo(page.id)
                    setNavOpen(false)
                  }}
                >
                  <span className="nav-dot" aria-hidden="true" />
                  <span>{page.label}</span>
                </button>
              ))}
            </nav>
          </aside>
        </div>
      )}
    </div>
  )
}

type ChatMessage = { role: 'ai' | 'teacher'; text: string }

// ---------------------------------------------------------------------------
// Brainstorm with AI — a guided conversation that fills in the lesson form
//
// The assistant walks through the same fields as "Create a new lesson", one
// question at a time, skipping anything the teacher already filled in:
// first the seven required fields (no skipping), then — if the teacher
// wants to customize — the optional Additional Customization fields (any of
// which can be skipped). Each answer is interpreted locally and written
// straight into the form, so the form and the conversation always agree;
// the assistant's wording comes from the (mock) model through callAiModel
// like every other AI reply.
// ---------------------------------------------------------------------------

type BrainstormField =
  // Required (no skipping)
  | 'gradeLevel'
  | 'topic'
  | 'standards'
  | 'practices'
  | 'learningObjectives'
  | 'instructionalSequence'
  | 'pacing'
  // Optional (can be skipped)
  | 'priorInstruction'
  | 'subsequentInstruction'
  | 'differentiation'
  | 'materialsAndEquipment'
  | 'lessonTemplate'
  | 'rubric'

// Where the conversation is: asking about a field, offering the optional
// customization questions, or finished.
type BrainstormStage = BrainstormField | 'customize-offer' | 'done'

// A read-only view of the lesson form, for deciding what to ask next.
type LessonFormSnapshot = {
  gradeLevel: string
  topic: string
  framework: StandardsFrameworkId
  // Verified standards by code; customStandards is teacher-entered text.
  standards: readonly string[]
  customStandards: readonly string[]
  learningObjectives: string
  instructionalSequence: string
  priorInstruction: string
  subsequentInstruction: string
  differentiation: string
  materialsAndEquipment: string
  pacingSelection: string
  customPacingMinutes: string
  practices: readonly string[]
  // Names of the files chosen in the form's uploads ('' when none).
  lessonTemplateName: string
  rubricName: string
}

// A suggested answer under the assistant's question. `openUpload` chips
// don't send a message — they open that file upload right in the chat.
type QuickReply = { label: string; value: string; openUpload?: 'lessonTemplate' | 'rubric' }

type BrainstormTextField =
  | 'gradeLevel'
  | 'topic'
  | 'learningObjectives'
  | 'instructionalSequence'
  | 'priorInstruction'
  | 'subsequentInstruction'
  | 'differentiation'
  | 'materialsAndEquipment'

type BrainstormAnswer =
  | { kind: 'fill'; field: BrainstormTextField; value: string; summary: string }
  | { kind: 'fill'; field: 'standards'; value: { codes: string[]; custom: string[] }; summary: string }
  | { kind: 'fill'; field: 'practices'; value: string[]; summary: string }
  | { kind: 'fill'; field: 'pacing'; value: { selection: string; customMinutes: string }; summary: string }
  // Only optional questions can be skipped.
  | { kind: 'skip' }
  | { kind: 'retry'; hint: string }

type BrainstormStep = {
  field: BrainstormField
  label: string
  shortLabel: string
  question: string
  optional?: boolean
  // Lesson Template / Rubric: answered by attaching a file in the form.
  upload?: boolean
}

// Form order: the seven required fields, then Additional Customization.
const brainstormSteps: BrainstormStep[] = [
  { field: 'gradeLevel', label: 'Grade level', shortLabel: 'Grade level', question: 'Which grade band is this lesson for?' },
  { field: 'topic', label: 'Topic', shortLabel: 'Topic', question: 'What topic or phenomenon will students explore?' },
  { field: 'standards', label: 'Standards', shortLabel: 'Standards', question: 'Which standard should this lesson address?' },
  {
    field: 'practices',
    label: 'Science Practices to Emphasize',
    shortLabel: 'Practices',
    question: 'Which science practices should students emphasize? You can name more than one — for example, “models and explanations”.',
  },
  {
    field: 'learningObjectives',
    label: 'Learning objectives',
    shortLabel: 'Objectives',
    question: 'What should students be able to do by the end of the lesson?',
  },
  {
    field: 'instructionalSequence',
    label: 'Instructional sequence',
    shortLabel: 'Sequence',
    question:
      'What sequence of activities do you have in mind? For example: launch with a phenomenon, investigate, then make sense of the evidence.',
  },
  { field: 'pacing', label: 'Pacing / Duration', shortLabel: 'Pacing', question: 'How long is the lesson — 45, 60, or 90 minutes, or another length?' },
  {
    field: 'priorInstruction',
    label: 'Prior Instruction',
    shortLabel: 'Prior instruction',
    question: 'What should students already know at this point, including misconceptions they might have?',
    optional: true,
  },
  {
    field: 'subsequentInstruction',
    label: 'Subsequent Instruction',
    shortLabel: 'Subsequent',
    question: 'What will students do next, after this lesson?',
    optional: true,
  },
  {
    field: 'differentiation',
    label: 'Differentiation',
    shortLabel: 'Differentiation',
    question: 'What students’ needs in your class should the activities accommodate?',
    optional: true,
  },
  {
    field: 'materialsAndEquipment',
    label: 'Materials & equipment',
    shortLabel: 'Materials',
    question: 'What materials, equipment, or technology will you use? Mention any lab or safety needs.',
    optional: true,
  },
  {
    field: 'lessonTemplate',
    label: 'Lesson Template',
    shortLabel: 'Template',
    question:
      'Do you have an existing lesson template you’d like the lesson to follow? Choose “Upload File” to attach it.',
    optional: true,
    upload: true,
  },
  {
    field: 'rubric',
    label: 'Rubric',
    shortLabel: 'Rubric',
    question: 'Do you have a rubric for evaluating students’ products? Choose “Upload File” to attach it.',
    optional: true,
    upload: true,
  },
]

const brainstormStepFor = (field: BrainstormField) => brainstormSteps.find((step) => step.field === field)!
const isBrainstormField = (stage: BrainstormStage | null): stage is BrainstormField =>
  stage !== null && stage !== 'customize-offer' && stage !== 'done'
const requiredBrainstormSteps = brainstormSteps.filter((step) => !step.optional)
const optionalBrainstormSteps = brainstormSteps.filter((step) => step.optional)

function isBrainstormFieldFilled(field: BrainstormField, form: LessonFormSnapshot): boolean {
  switch (field) {
    case 'gradeLevel':
      return form.gradeLevel !== ''
    case 'standards':
      return form.standards.length + form.customStandards.length > 0
    case 'pacing':
      return durationMinutes(form.pacingSelection, form.customPacingMinutes) !== null
    case 'practices':
      return form.practices.length > 0
    case 'lessonTemplate':
      return form.lessonTemplateName !== ''
    case 'rubric':
      return form.rubricName !== ''
    default:
      return form[field].trim() !== ''
  }
}

// Standards are scoped to the grade band, so without one there's nothing to
// suggest and the step is passed over.
function isBrainstormFieldAskable(field: BrainstormField, form: LessonFormSnapshot): boolean {
  return field !== 'standards' || Boolean(gradeLevelToStandardsBand[form.gradeLevel])
}

// What to ask next, in form order: the first empty required field (these
// can't be skipped, and a field cleared in the form is asked again); then
// the offer to customize; then — if the teacher said yes — each empty
// optional field they haven't skipped.
function nextBrainstormStage(
  form: LessonFormSnapshot,
  customize: 'yes' | 'no' | null,
  skipped: readonly BrainstormField[],
): BrainstormStage {
  const required = requiredBrainstormSteps.find(
    (step) => !isBrainstormFieldFilled(step.field, form) && isBrainstormFieldAskable(step.field, form),
  )
  if (required) return required.field
  if (customize === null) return 'customize-offer'
  if (customize === 'yes') {
    const optional = optionalBrainstormSteps.find((step) => !isBrainstormFieldFilled(step.field, form) && !skipped.includes(step.field))
    if (optional) return optional.field
  }
  return 'done'
}

// The teacher's current answer for a field, written out in full — used to
// prefill the input when they edit an earlier answer.
function brainstormAnswerText(field: BrainstormField, form: LessonFormSnapshot): string {
  switch (field) {
    case 'gradeLevel':
      return form.gradeLevel === '6-8' ? 'Grades 6–8' : form.gradeLevel === '9-12' ? 'Grades 9–12' : form.gradeLevel
    case 'standards':
      return [...form.standards, ...form.customStandards].join(', ')
    case 'pacing':
      return form.pacingSelection === 'custom'
        ? `${form.customPacingMinutes.trim()} minutes`
        : (pacingOptions.find((option) => option.id === form.pacingSelection)?.label ?? '')
    case 'practices':
      return practiceOptions
        .filter((practice) => form.practices.includes(practice.id))
        .map((practice) => practice.label)
        .join(', ')
    case 'lessonTemplate':
      return form.lessonTemplateName
    case 'rubric':
      return form.rubricName
    default:
      return form[field]
  }
}

// The form as the assistant should see it while a field's answer is being
// replaced: that field's current value no longer counts (so, e.g., standard
// suggestions include the ones about to be replaced).
function withoutBrainstormField(form: LessonFormSnapshot, field: BrainstormField): LessonFormSnapshot {
  switch (field) {
    case 'standards':
      return { ...form, standards: [], customStandards: [] }
    case 'practices':
      return { ...form, practices: [] }
    case 'pacing':
      return { ...form, pacingSelection: '', customPacingMinutes: '' }
    case 'lessonTemplate':
      return { ...form, lessonTemplateName: '' }
    case 'rubric':
      return { ...form, rubricName: '' }
    default:
      return { ...form, [field]: '' }
  }
}

function suggestedStandardsFor(form: LessonFormSnapshot): ScienceStandard[] {
  return suggestStandards(form.framework, form.gradeLevel, form.topic, form.standards, 6)
}

const hasOptionalFieldsLeft = (form: LessonFormSnapshot) =>
  optionalBrainstormSteps.some((step) => !isBrainstormFieldFilled(step.field, form))

// Suggested answers shown under the assistant's latest question.
function brainstormQuickReplies(stage: BrainstormStage | null, form: LessonFormSnapshot): QuickReply[] {
  const skip = { label: 'Skip', value: 'skip' }
  switch (stage) {
    case 'gradeLevel':
      return [
        { label: 'Grades 6–8', value: '6-8' },
        { label: 'Grades 9–12', value: '9-12' },
      ]
    case 'standards':
      return suggestedStandardsFor(form).map((standard) => ({ label: standard.code, value: standard.code }))
    case 'pacing':
      return pacingOptions.filter((option) => option.id !== 'custom').map((option) => ({ label: option.label, value: option.label }))
    case 'practices':
      return [
        ...practiceOptions.map((practice) => ({ label: practice.label, value: practice.label })),
        { label: 'All three practices', value: 'all three' },
      ]
    case 'customize-offer':
      return [
        { label: 'Yes, customize', value: 'Yes, customize' },
        { label: 'No, continue', value: 'No, continue' },
      ]
    case 'lessonTemplate':
    case 'rubric': {
      return [
        { label: 'Upload File', value: '', openUpload: stage },
        { label: 'I’ve attached it', value: 'I’ve attached it' },
        skip,
      ]
    }
    case 'priorInstruction':
    case 'subsequentInstruction':
    case 'differentiation':
    case 'materialsAndEquipment':
      return [skip]
    case 'done':
      return hasOptionalFieldsLeft(form) ? [{ label: 'Customize lesson', value: 'Customize lesson' }] : []
    default:
      return []
  }
}

type FormSummaryItem = { field: BrainstormField; label: string; value: string | null; optional: boolean }

// One bubble in the Form Completion Summary: completion comes from the
// form's actual values (the same check that decides what to ask), so it
// reflects manual edits and never counts an answer that was only suggested.
function formCompletionSummary(form: LessonFormSnapshot): FormSummaryItem[] {
  const shorten = (text: string) => {
    const clean = text.trim().replace(/\s+/g, ' ')
    return clean.length > 24 ? `${clean.slice(0, 22)}…` : clean
  }
  const valueFor = (field: BrainstormField): string => {
    switch (field) {
      case 'gradeLevel':
        return form.gradeLevel === '6-8' ? 'Grades 6–8' : form.gradeLevel === '9-12' ? 'Grades 9–12' : form.gradeLevel
      case 'standards': {
        const all = [...form.standards, ...form.customStandards]
        return all.length > 1 ? `${shorten(all[0])} +${all.length - 1}` : shorten(all[0])
      }
      case 'pacing':
        return form.pacingSelection === 'custom'
          ? `${form.customPacingMinutes.trim()} min (custom)`
          : (pacingOptions.find((option) => option.id === form.pacingSelection)?.label ?? form.pacingSelection)
      case 'practices':
        return form.practices.length === 1
          ? (practiceOptions.find((practice) => practice.id === form.practices[0])?.label ?? '1 selected')
          : `${form.practices.length} selected`
      case 'lessonTemplate':
        return shorten(form.lessonTemplateName)
      case 'rubric':
        return shorten(form.rubricName)
      default:
        return shorten(form[field])
    }
  }
  return brainstormSteps.map((step) => ({
    field: step.field,
    label: step.shortLabel,
    value: isBrainstormFieldFilled(step.field, form) ? valueFor(step.field) : null,
    optional: Boolean(step.optional),
  }))
}

const skipPattern = /^(skip|skip it|skip this|pass|next|later|not now|no thanks|not sure|unsure|idk|i don[’']?t know|n\/?a|none|nothing|no)[.!]?$/i

// Turns the teacher's reply into a form value for `field`. (Lesson Template
// and Rubric are answered by attaching a file, so they're handled by the
// panel, not here.)
function interpretBrainstormAnswer(field: BrainstormField, text: string, form: LessonFormSnapshot): BrainstormAnswer {
  const answer = text.trim()
  const optional = Boolean(brainstormStepFor(field).optional)
  if (skipPattern.test(answer)) {
    // Optional questions can be skipped; required ones need a real answer.
    return optional
      ? { kind: 'skip' }
      : {
          kind: 'retry',
          hint: `This question needs an answer before we move on — it fills in ${brainstormStepFor(field).label} on the lesson form. ${brainstormQuestion(field, form)}`,
        }
  }
  const lower = answer.toLowerCase()

  switch (field) {
    case 'gradeLevel': {
      if (/\b(6|7|8)(th)?\b|middle/.test(lower)) return { kind: 'fill', field, value: '6-8', summary: 'Grades 6–8' }
      if (/\b(9|10|11|12)(th)?\b|high/.test(lower)) return { kind: 'fill', field, value: '9-12', summary: 'Grades 9–12' }
      return { kind: 'retry', hint: 'I can plan for Grades 6–8 or Grades 9–12 — which one fits?' }
    }
    case 'standards': {
      const available = standardsFor(form.framework, form.gradeLevel)
      // No verified data for this framework yet: keep the teacher's own
      // wording as a custom standard rather than guessing a match.
      if (available.length === 0) {
        return { kind: 'fill', field, value: { codes: [], custom: [answer] }, summary: `${answer} (custom)` }
      }
      const codes = (answer.match(/\b(?:MS|HS)-[A-Z]{2,4}\d-\d\b/gi) ?? []).map((code) => code.toUpperCase())
      // Keep the teacher's order (and drop repeats or codes outside this grade band).
      let picked = codes.filter((code, index) => codes.indexOf(code) === index && available.some((standard) => standard.code === code))
      if (picked.length === 0 && codes.length === 0) {
        const match =
          suggestStandards(form.framework, form.gradeLevel, answer, form.standards, 1)[0] ??
          available.find((standard) => matchesStandardsQuery(standard, answer))
        if (match) picked = [match.code]
      }
      if (picked.length === 0) {
        return {
          kind: 'retry',
          hint: 'I couldn’t find that standard for this grade band. Pick a suggestion, describe the concept, or add it as a custom standard in the form.',
        }
      }
      return { kind: 'fill', field, value: { codes: picked, custom: [] }, summary: picked.join(', ') }
    }
    case 'pacing': {
      // 45, 60, or 90 select that preset; any other positive length is a
      // custom duration.
      const minutes = /(\d+(?:\.\d+)?)/.exec(lower)?.[1]
      if (!minutes || Number(minutes) <= 0) {
        return { kind: 'retry', hint: 'About how many minutes? Pick 45, 60, or 90, or type another length — for example, “50 minutes”.' }
      }
      const preset = pacingOptions.find((option) => option.id === minutes)
      return preset
        ? { kind: 'fill', field, value: { selection: preset.id, customMinutes: '' }, summary: preset.label }
        : { kind: 'fill', field, value: { selection: 'custom', customMinutes: minutes }, summary: `${minutes} min` }
    }
    case 'practices': {
      const keywords: Record<string, string[]> = {
        modeling: ['model'],
        explanation: ['explanation', 'explain'],
        argumentation: ['argument', 'evidence', 'argue'],
      }
      const picked = /\ball( three| of (them|these|the practices))?\b/.test(lower)
        ? practiceOptions
        : practiceOptions.filter(
            (practice) => lower.includes(practice.label.toLowerCase()) || keywords[practice.id]?.some((word) => lower.includes(word)),
          )
      if (picked.length === 0) {
        return { kind: 'retry', hint: 'Choose from Develop and Use Models, Construct Explanations, or Engage in Argument from Evidence.' }
      }
      return { kind: 'fill', field, value: picked.map((practice) => practice.id), summary: picked.map((practice) => practice.label).join(', ') }
    }
    case 'lessonTemplate':
    case 'rubric':
      return { kind: 'retry', hint: brainstormQuestion(field, form) }
    default: {
      // A short question or filler ("what next?", "ok") isn't an answer to
      // a free-text field — ask again instead of writing it into the form.
      const isQuestion = answer.endsWith('?') && answer.split(/\s+/).length <= 4
      if (isQuestion || /^(ok(ay)?|yes|hmm+|help|thanks?( you)?)[.!]?$/i.test(answer)) {
        return {
          kind: 'retry',
          hint: `I need an answer for ${brainstormStepFor(field).label}${optional ? ' (or say “skip”)' : ''} before we move on. ${brainstormQuestion(field, form)}`,
        }
      }
      return { kind: 'fill', field, value: answer, summary: answer }
    }
  }
}

function brainstormQuestion(stage: BrainstormStage, form: LessonFormSnapshot): string {
  if (stage === 'done') {
    return (
      'That covers the lesson form. Choose “Create a new lesson” above to review or adjust anything, or generate the lesson now.' +
      (hasOptionalFieldsLeft(form) ? ' You can choose “Customize lesson” anytime to add optional details.' : '')
    )
  }
  if (stage === 'customize-offer') {
    return 'All seven required fields are complete. Would you like to provide additional information to customize your lesson?'
  }
  if (stage === 'standards') {
    if (standardsFor(form.framework, form.gradeLevel).length === 0) {
      return `Which standard should this lesson address? Verified ${standardsFrameworkName(form.framework)} standards aren’t loaded yet, so type the standard you’d like to use and I’ll add it as a custom standard.`
    }
    const suggestions = suggestedStandardsFor(form)
    return suggestions.length > 0
      ? `Which standards should this lesson address? These ${standardsFrameworkName(form.framework)} standards fit “${form.topic.trim()}” — select one or more, then choose “Confirm Selection”.`
      : 'Which standard should this lesson address? Describe the concept or type a standard code.'
  }
  if (stage === 'learningObjectives' && form.practices.length > 0) {
    const practices = practiceOptions.filter((practice) => form.practices.includes(practice.id)).map((practice) => practice.label)
    return `What should students be able to do by the end of the lesson, related to ${practices.join(' and ')}?`
  }
  const step = brainstormStepFor(stage)
  return step.optional ? `${step.question} (Optional — you can skip this.)` : step.question
}

// The mock planning model. It only phrases the reply — the form changes are
// made locally from the teacher's answer before this is called.
function mockBrainstormReply(request: {
  outcome: 'start' | 'filled' | 'updated' | 'skipped' | 'retry' | 'after-done'
  fieldLabel: string
  summary: string
  nextQuestion: string
  keptExistingAnswers: boolean
}): string {
  const quoted = request.summary.length > 80 ? `“${request.summary.slice(0, 77)}…”` : `“${request.summary}”`
  switch (request.outcome) {
    case 'start':
      return (
        'Hi! I’ll help you plan this lesson by filling in the lesson form with you, one question at a time. ' +
        'Type an answer or pick a suggestion — each required question needs an answer, and you can change any answer later with its Edit button.' +
        (request.keptExistingAnswers ? ' I’ll keep what you already entered in the form.' : '') +
        ` ${request.nextQuestion}`
      )
    case 'filled':
      return `Got it — I added ${quoted} to ${request.fieldLabel}. ${request.nextQuestion}`
    case 'updated':
      return `Updated ${request.fieldLabel} to ${quoted}. ${request.nextQuestion}`
    case 'skipped':
      return `No problem — we’ll leave ${request.fieldLabel} for now. ${request.nextQuestion}`
    case 'retry':
    case 'after-done':
      return request.nextQuestion
  }
}

// The seven fields Generate Lesson requires. Completion uses the same
// check as the Form Completion summary, so both always agree.
const requiredLessonFields: { field: BrainstormField; label: string }[] = [
  { field: 'gradeLevel', label: 'Grade Level' },
  { field: 'topic', label: 'Topic' },
  { field: 'standards', label: 'Standards' },
  { field: 'practices', label: 'Science Practices' },
  { field: 'learningObjectives', label: 'Learning Objectives' },
  { field: 'instructionalSequence', label: 'Instructional Sequence' },
  { field: 'pacing', label: 'Duration' },
]

type LessonUploadField = 'lessonTemplate' | 'rubric'

// The two optional uploads, shared by the form's Additional Customization
// and Brainstorm with AI (which show the same file state).
const lessonUploads: Record<LessonUploadField, { label: string; description: string; accept: string }> = {
  lessonTemplate: {
    label: 'Lesson Template',
    description: 'An existing lesson template you’d like the lesson to follow.',
    accept: '.pdf,.doc,.docx,.txt,.md,.ppt,.pptx',
  },
  rubric: {
    label: 'Rubric',
    description: 'A rubric for evaluating students’ products.',
    accept: '.pdf,.doc,.docx,.txt,.md,.xls,.xlsx,.csv',
  },
}

// An optional single-file upload in the existing upload-card style: shows
// the chosen file's name, with Replace and Remove once a file is chosen. A
// file whose type isn't in `accept` is turned away with a message rather
// than attached (the picker's filter is only a hint).
function OptionalFileUpload({
  id,
  label,
  description,
  file,
  accept,
  onChange,
}: {
  id: string
  label: string
  description: string
  file: File | null
  accept: string
  onChange: (file: File | null) => void
}) {
  const [rejected, setRejected] = useState<string | null>(null)
  const acceptedExtensions = accept.split(',').map((type) => type.trim().toLowerCase())
  return (
    <div className="optional-upload" id={id} role="group" aria-label={label}>
      <span className="optional-upload-label">{label}</span>
      <small className="field-hint">{description}</small>
      <div className="upload-card optional-upload-card">
        <div className="optional-upload-file">
          <p className="card-label">{file ? 'Selected file' : 'No file selected'}</p>
          {file && <h4 title={file.name}>{file.name}</h4>}
        </div>
        <div className="optional-upload-actions">
          {file && (
            <button
              type="button"
              className="ghost-button optional-upload-remove"
              onClick={() => {
                setRejected(null)
                onChange(null)
              }}
            >
              Remove
            </button>
          )}
          <label className="secondary-button library-file-button">
            {file ? 'Replace' : 'Choose File'}
            <input
              type="file"
              accept={accept}
              aria-label={`${file ? 'Replace' : 'Choose'} ${label} file`}
              onChange={(event) => {
                const chosen = event.target.files?.[0]
                event.target.value = ''
                if (!chosen) return
                const extension = `.${chosen.name.split('.').pop()?.toLowerCase() ?? ''}`
                if (!acceptedExtensions.includes(extension)) {
                  setRejected(`“${chosen.name}” isn’t a supported file type. Use ${acceptedExtensions.join(', ')}.`)
                  return
                }
                setRejected(null)
                onChange(chosen)
              }}
            />
          </label>
        </div>
      </div>
      {rejected && (
        <p className="roster-error" role="alert">
          {rejected}
        </p>
      )}
    </div>
  )
}

function RequiredMark() {
  return (
    <span className="required-mark" aria-hidden="true">
      *
    </span>
  )
}

function FieldError({ show, message = 'This field is required.' }: { show: boolean; message?: string }) {
  return show ? <small className="field-error">{message}</small> : null
}

function RequiredFieldsAlert({ show, missing, hint }: { show: boolean; missing: readonly string[]; hint?: string }) {
  if (!show || missing.length === 0) return null
  return (
    <div className="required-fields-alert" role="alert">
      <strong>Complete the required fields to generate your lesson:</strong> {missing.join(', ')}.{hint ? ` ${hint}` : ''}
    </div>
  )
}

function brainstormReply(request: Parameters<typeof mockBrainstormReply>[0]): string {
  return callAiModel('lesson-brainstorm', request, mockBrainstormReply)
}

// A brainstorm chat message; a teacher answer the assistant accepted
// records which form field it filled, so it can be edited later.
type BrainstormMessage = ChatMessage & { field?: BrainstormField }

// The assistant's opening message and first question for the form as it is.
function createBrainstormIntro(form: LessonFormSnapshot): { field: BrainstormStage; message: BrainstormMessage } {
  const field = nextBrainstormStage(form, null, [])
  const keptExistingAnswers = brainstormSteps.some((step) => isBrainstormFieldFilled(step.field, form))
  return {
    field,
    message: {
      role: 'ai',
      text: brainstormReply({ outcome: 'start', fieldLabel: '', summary: '', nextQuestion: brainstormQuestion(field, form), keptExistingAnswers }),
    },
  }
}

function LessonPlanningPanel({
  planningTab,
  setPlanningTab,
  revisionEditor,
  defaultFramework,
  onGenerate,
  onUploadLesson,
}: {
  planningTab: PlanningTab
  setPlanningTab: (tab: PlanningTab) => void
  revisionEditor: RevisionWorkflow
  // The teacher's state framework (from their profile), or NGSS.
  defaultFramework: StandardsFrameworkId
  onGenerate?: (details: PlanningLessonDetails) => void
  // Only provided when the page was opened from a class's Add Lesson; without
  // it, Upload file stays the same placeholder button as before.
  onUploadLesson?: (file: File, details: PlanningLessonDetails) => void
}) {
  // Draft text for whichever lesson-section revision conversation is
  // currently active (see revisionEditor.activeLabel) — cleared whenever the
  // teacher switches to a different section's conversation.
  const [revisionDraft, setRevisionDraft] = useState('')
  useEffect(() => {
    setRevisionDraft('')
  }, [revisionEditor.activeLabel])

  // The Lesson Preferences form starts completely blank — a new teacher's
  // first view of this page must look like an empty form, not one already
  // filled in with the prototype's example (Zombie Fires) lesson. That
  // example only ever appears as the GENERATED output once the teacher
  // clicks Generate Lesson (see lessonSteps and friends below), never as
  // pre-filled input here.
  const [selectedPractices, setSelectedPractices] = useState<string[]>([])
  // Every field below lives above the three start options so a teacher's
  // entries survive switching between them (Brainstorm with AI fills these
  // same fields), and survive clicking Generate Lesson (which no longer
  // unmounts this panel at all).
  const [topic, setTopic] = useState('')
  const [learningObjectives, setLearningObjectives] = useState('')
  const [priorInstruction, setPriorInstruction] = useState('')
  const [materialsAndEquipment, setMaterialsAndEquipment] = useState('')
  const [instructionalSequence, setInstructionalSequence] = useState('')
  // Additional Customization (all optional). Collapsing the section only
  // hides these — their values stay.
  const [isCustomizationOpen, setIsCustomizationOpen] = useState(false)
  const [subsequentInstruction, setSubsequentInstruction] = useState('')
  const [differentiation, setDifferentiation] = useState('')
  // Uploaded files are only selected and shown for now; nothing reads them.
  const [lessonTemplateFile, setLessonTemplateFile] = useState<File | null>(null)
  const [rubricFile, setRubricFile] = useState<File | null>(null)

  // The form's own Grade level selector doubles as the Standards filter —
  // teachers aren't asked to pick a grade a second time.
  const [gradeLevel, setGradeLevel] = useState('')
  const selectedGradeBand = gradeLevelToStandardsBand[gradeLevel]
  const [framework, setFramework] = useState<StandardsFrameworkId>(defaultFramework)

  // Standards search: a teacher can type a keyword — without needing to
  // already know a standard's code — and pick any number of matching
  // standards (automatically scoped to the selected grade level), which
  // then show as removable chips.
  const [standardsQuery, setStandardsQuery] = useState('')
  const [selectedStandardCodes, setSelectedStandardCodes] = useState<string[]>([])
  // Standards the teacher typed in themselves (not from the verified list).
  const [customStandards, setCustomStandards] = useState<string[]>([])

  const togglePractice = (practiceId: string) => {
    setSelectedPractices((prev) =>
      prev.includes(practiceId) ? prev.filter((item) => item !== practiceId) : [...prev, practiceId],
    )
  }

  const frameworkStandards = standardsFor(framework, gradeLevel)
  // Standards related to the topic for the selected grade level and
  // framework — recomputed on every render, so they follow any change to
  // those three. Never includes standards already selected.
  const relatedStandards = suggestStandards(framework, gradeLevel, topic, selectedStandardCodes, frameworkStandards.length)
  // The bubbles under the field show the top few.
  const topicSuggestions = relatedStandards.slice(0, 4)
  // Typing searches every standard for the grade level and framework,
  // listing the topic-related ones first.
  const searchedStandards = frameworkStandards
    .filter((standard) => !selectedStandardCodes.includes(standard.code))
    .filter((standard) => matchesStandardsQuery(standard, standardsQuery.trim()))
    .sort((a, b) => {
      const rank = (standard: ScienceStandard) => {
        const index = relatedStandards.indexOf(standard)
        return index === -1 ? relatedStandards.length : index
      }
      return rank(a) - rank(b)
    })
    .slice(0, 8)

  // The Standards search box is a combobox: focusing it opens a dropdown of
  // suggestions (even when empty), and typing narrows it.
  const [isStandardsOpen, setIsStandardsOpen] = useState(false)
  const [activeStandardIndex, setActiveStandardIndex] = useState(-1)
  const standardOptions = standardsQuery.trim() ? searchedStandards : relatedStandards.slice(0, 6)
  const activeStandardOption = standardOptions[activeStandardIndex] ?? null
  const standardsDropdownHeading = standardOptions.length
    ? standardsQuery.trim()
      ? `Matching “${standardsQuery.trim()}”`
      : `Suggested for “${topic.trim()}” · ${formatLessonGrade(gradeLevel)} · ${standardsFrameworkName(framework)}`
    : null
  const standardsDropdownMessage = !selectedGradeBand
    ? 'Select a grade level above to see suggested standards.'
    : frameworkStandards.length === 0
      ? `Verified ${standardsFrameworkName(framework)} standards haven’t been loaded yet. Switch the framework to NGSS, or add your standard as a custom entry.`
      : standardsQuery.trim()
        ? 'No matching standards found. Try a different keyword.'
        : !topic.trim()
          ? 'Enter a topic above to see suggested standards, or type to search.'
          : 'No suggested standards found. Try searching manually.'

  const selectStandardOption = (standard: ScienceStandard) => {
    addStandard(standard.code)
    setStandardsQuery('')
    setActiveStandardIndex(-1)
  }

  const handleStandardsKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIsStandardsOpen(true)
      setActiveStandardIndex((index) => Math.min(index + 1, standardOptions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveStandardIndex((index) => Math.max(index - 1, -1))
    } else if (event.key === 'Enter' && isStandardsOpen && activeStandardOption) {
      event.preventDefault()
      selectStandardOption(activeStandardOption)
    } else if (event.key === 'Escape') {
      setIsStandardsOpen(false)
      setActiveStandardIndex(-1)
    }
  }

  const trimmedStandardsQuery = standardsQuery.trim()
  const canAddCustomStandard =
    trimmedStandardsQuery !== '' &&
    !scienceStandardsBank.some((standard) => standard.code.toLowerCase() === trimmedStandardsQuery.toLowerCase()) &&
    !customStandards.includes(trimmedStandardsQuery)
  const addCustomStandard = () => {
    setCustomStandards((prev) => [...prev, trimmedStandardsQuery])
    setStandardsQuery('')
  }

  const addStandard = (code: string) => {
    setSelectedStandardCodes((prev) => (prev.includes(code) ? prev : [...prev, code]))
  }

  const removeStandard = (code: string) => {
    setSelectedStandardCodes((prev) => prev.filter((item) => item !== code))
  }

  const [pacingSelection, setPacingSelection] = useState('')
  // Kept while switching between presets and Custom, so switching back to
  // Custom restores what the teacher typed.
  const [customPacingMinutes, setCustomPacingMinutes] = useState('')

  // The method to return to when a revision conversation is closed.
  const [lastMethod, setLastMethod] = useState<PlanningTab>(planningTab === 'revision' ? 'none' : planningTab)

  const formSnapshot: LessonFormSnapshot = {
    gradeLevel,
    topic,
    framework,
    standards: selectedStandardCodes,
    customStandards,
    learningObjectives,
    instructionalSequence,
    priorInstruction,
    subsequentInstruction,
    differentiation,
    materialsAndEquipment,
    pacingSelection,
    customPacingMinutes,
    practices: selectedPractices,
    lessonTemplateName: lessonTemplateFile?.name ?? '',
    rubricName: rubricFile?.name ?? '',
  }
  // The summary's progress counts required fields; optional ones are shown
  // separately and never affect it or validation.
  const requiredFilledCount = requiredBrainstormSteps.filter((step) => isBrainstormFieldFilled(step.field, formSnapshot)).length
  const optionalFilledCount = optionalBrainstormSteps.filter((step) => isBrainstormFieldFilled(step.field, formSnapshot)).length

  // Required-field validation for Generate Lesson. Errors only show after a
  // Generate attempt, and each one clears as soon as its field is filled.
  const [showValidation, setShowValidation] = useState(false)
  const missingRequired = requiredLessonFields
    .filter((item) => !isBrainstormFieldFilled(item.field, formSnapshot))
    .map((item) => item.label)
  const isInvalid = (field: BrainstormField) => showValidation && !isBrainstormFieldFilled(field, formSnapshot)
  const invalidClass = (field: BrainstormField) => (isInvalid(field) ? 'field-invalid' : '')

  const lessonDetails: PlanningLessonDetails = {
    topic,
    gradeLevel,
    standards: [
      ...selectedStandardCodes.map((code) => ({
        code,
        framework: scienceStandardsBank.find((standard) => standard.code === code)?.framework ?? framework,
        custom: false,
      })),
      ...customStandards.map((text) => ({ code: text, framework, custom: true })),
    ],
    sciencePractices: practiceOptions.filter((practice) => selectedPractices.includes(practice.id)).map((practice) => practice.id),
    durationMinutes: durationMinutes(pacingSelection, customPacingMinutes),
    ...extractDrivingQuestion(learningObjectives, instructionalSequence),
    // Only optional fields the teacher actually filled in.
    optionalContext: Object.fromEntries(
      Object.entries({
        priorInstruction,
        subsequentInstruction,
        differentiation,
        materialsAndEquipment,
      })
        .map(([key, value]) => [key, value.trim()])
        .filter(([, value]) => value !== ''),
    ),
    uploads: {
      ...(lessonTemplateFile ? { lessonTemplateName: lessonTemplateFile.name } : {}),
      ...(rubricFile ? { rubricName: rubricFile.name } : {}),
    },
  }

  const handleGenerate = () => {
    if (missingRequired.length > 0) {
      setShowValidation(true)
      return
    }
    setShowValidation(false)
    onGenerate?.(lessonDetails)
  }

  // Brainstorm with AI: the conversation and the form field it's asking
  // about (null until started, 'done' once every field has been covered).
  // The chosen option outlives this panel (it's App state) but the form and
  // conversation don't, so a panel that mounts with Brainstorm already
  // chosen starts a fresh conversation for its (empty) form.
  const [brainstormStart] = useState(() => (planningTab === 'brainstorm' ? createBrainstormIntro(formSnapshot) : null))
  const [brainstormMessages, setBrainstormMessages] = useState<BrainstormMessage[]>(brainstormStart ? [brainstormStart.message] : [])
  const [brainstormField, setBrainstormField] = useState<BrainstormStage | null>(brainstormStart?.field ?? null)
  // The teacher's answer to "customize your lesson?" (null until asked), and
  // optional questions they skipped — skipped ones aren't asked again unless
  // they choose Customize lesson later.
  const [customizeChoice, setCustomizeChoice] = useState<'yes' | 'no' | null>(null)
  const [skippedOptional, setSkippedOptional] = useState<BrainstormField[]>([])
  const [brainstormDraft, setBrainstormDraft] = useState('')
  const [isBrainstormThinking, setIsBrainstormThinking] = useState(false)
  // Set while the teacher is changing an earlier answer (via its Edit
  // button); the next message replaces that field's value.
  const [editingField, setEditingField] = useState<BrainstormField | null>(null)
  const brainstormInputRef = useRef<HTMLInputElement>(null)
  const brainstormTimeoutRef = useRef<number | null>(null)
  // Keeps the newest question in view as the conversation grows.
  const brainstormThreadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const thread = brainstormThreadRef.current
    if (thread) thread.scrollTop = thread.scrollHeight
  }, [brainstormMessages.length, isBrainstormThinking, planningTab])
  useEffect(() => {
    return () => {
      if (brainstormTimeoutRef.current !== null) window.clearTimeout(brainstormTimeoutRef.current)
    }
  }, [])

  const startBrainstorm = () => {
    const intro = createBrainstormIntro(formSnapshot)
    setBrainstormField(intro.field)
    setBrainstormMessages([intro.message])
  }

  const chooseMethod = (method: PlanningMethod) => {
    const next: PlanningTab = planningTab === method ? 'none' : method
    setPlanningTab(next)
    setLastMethod(next)
    if (next !== 'brainstorm') return
    if (brainstormField === null) {
      startBrainstorm()
    } else if (isBrainstormField(brainstormField) && isBrainstormFieldFilled(brainstormField, formSnapshot) && !isBrainstormThinking) {
      // The teacher filled in the field being asked about (in the form, e.g.
      // by attaching a file) — acknowledge it and move on.
      const step = brainstormStepFor(brainstormField)
      const nextStage = nextBrainstormStage(formSnapshot, customizeChoice, skippedOptional)
      const detail = step.upload ? ` (${brainstormAnswerText(brainstormField, formSnapshot)})` : ''
      const note = step.upload ? ' I can’t read uploaded files yet, but it stays attached to your lesson form.' : ''
      setBrainstormMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          text: brainstormReply({
            outcome: 'after-done',
            fieldLabel: step.label,
            summary: '',
            nextQuestion: `I see ${step.label} is filled in now${detail}.${note} ${brainstormQuestion(nextStage, formSnapshot)}`,
            keptExistingAnswers: false,
          }),
        },
      ])
      setBrainstormField(nextStage)
    }
  }

  // Which upload is open under the Form Completion Summary (opened from the
  // Template/Rubric bubble or the assistant's "Upload File" action).
  const [brainstormUpload, setBrainstormUpload] = useState<LessonUploadField | null>(null)
  const uploadFiles: Record<LessonUploadField, File | null> = { lessonTemplate: lessonTemplateFile, rubric: rubricFile }
  const setUploadFile = (field: LessonUploadField, file: File | null) =>
    field === 'lessonTemplate' ? setLessonTemplateFile(file) : setRubricFile(file)

  // Attaching from the chat updates the same file state as the form. If the
  // assistant was asking for this file, it acknowledges it and moves on.
  const attachBrainstormFile = (field: LessonUploadField, file: File | null) => {
    setUploadFile(field, file)
    if (!file || brainstormField !== field || isBrainstormThinking) return
    setBrainstormUpload(null)
    const updated: LessonFormSnapshot = {
      ...formSnapshot,
      ...(field === 'lessonTemplate' ? { lessonTemplateName: file.name } : { rubricName: file.name }),
    }
    const nextStage = nextBrainstormStage(updated, customizeChoice, skippedOptional)
    setBrainstormMessages((prev) => [
      ...prev,
      {
        role: 'ai',
        text: brainstormReply({
          outcome: 'after-done',
          fieldLabel: lessonUploads[field].label,
          summary: '',
          nextQuestion: `Thanks — “${file.name}” is attached as your ${lessonUploads[field].label}. I can’t read uploaded files yet, but it stays with your lesson form. ${brainstormQuestion(nextStage, updated)}`,
          keptExistingAnswers: false,
        }),
      },
    ])
    setBrainstormField(nextStage)
  }

  // Standards chosen in the chat but not yet confirmed. They're written to
  // the form (and counted in the summary) only on Confirm Selection.
  const [pendingStandards, setPendingStandards] = useState<string[]>([])
  const togglePendingStandard = (code: string) =>
    setPendingStandards((prev) => (prev.includes(code) ? prev.filter((item) => item !== code) : [...prev, code]))
  const confirmStandards = () => {
    if (pendingStandards.length === 0) return
    sendBrainstormAnswer(pendingStandards.join(', '))
  }

  const startEditingAnswer = (field: BrainstormField) => {
    setEditingField(field)
    setBrainstormDraft(brainstormAnswerText(field, formSnapshot))
    // Editing standards starts from the current selection.
    setPendingStandards(field === 'standards' ? [...formSnapshot.standards] : [])
    brainstormInputRef.current?.focus()
  }

  const cancelEditingAnswer = () => {
    setEditingField(null)
    setBrainstormDraft('')
    setPendingStandards([])
  }

  const sendBrainstormAnswer = (text: string) => {
    const answerText = text.trim()
    const isEdit = editingField !== null
    const stage = editingField ?? brainstormField
    if (!answerText || stage === null || isBrainstormThinking) return
    setBrainstormDraft('')
    setPendingStandards([])

    let outcome: 'filled' | 'updated' | 'skipped' | 'retry' | 'after-done' = 'after-done'
    let summary = ''
    let nextStage: BrainstormStage = brainstormField ?? 'done'
    let nextQuestion: string
    let answeredField: BrainstormField | undefined
    let choice = customizeChoice
    let skipped = skippedOptional
    const lower = answerText.toLowerCase()

    if (stage === 'customize-offer') {
      if (/^(y(es)?|yeah|sure|ok(ay)?|please)\b|customi[sz]e/.test(lower) && !/^no\b/.test(lower)) {
        choice = 'yes'
        nextStage = nextBrainstormStage(formSnapshot, choice, skipped)
        nextQuestion = `Great — let’s add some details. These are all optional, so you can skip any of them. ${brainstormQuestion(nextStage, formSnapshot)}`
      } else if (/^(no|nope|not now|continue|skip)\b|no,? continue/.test(lower)) {
        choice = 'no'
        nextStage = nextBrainstormStage(formSnapshot, choice, skipped)
        nextQuestion = `No problem. ${brainstormQuestion(nextStage, formSnapshot)}`
      } else {
        outcome = 'retry'
        nextQuestion = `Please choose “Yes, customize” or “No, continue”. ${brainstormQuestion('customize-offer', formSnapshot)}`
      }
    } else if (stage === 'done') {
      if (/customi[sz]e|optional|add (more )?details/.test(lower) && hasOptionalFieldsLeft(formSnapshot)) {
        // Back to the optional questions, including ones skipped earlier.
        choice = 'yes'
        skipped = []
        nextStage = nextBrainstormStage(formSnapshot, choice, skipped)
        nextQuestion = `Let’s add those optional details — skip any you don’t need. ${brainstormQuestion(nextStage, formSnapshot)}`
      } else {
        // If a field was cleared in the form since, go back and ask for it.
        nextStage = nextBrainstormStage(formSnapshot, choice, skipped)
        nextQuestion =
          isBrainstormField(nextStage) && !brainstormStepFor(nextStage).optional
            ? `${brainstormStepFor(nextStage).label} is empty in the form again, so let’s fill it in. ${brainstormQuestion(nextStage, formSnapshot)}`
            : brainstormQuestion(nextStage, formSnapshot)
      }
    } else if (brainstormStepFor(stage).upload && !isEdit) {
      // Lesson Template / Rubric: the file itself is attached in the form.
      const label = brainstormStepFor(stage).label
      if (skipPattern.test(answerText)) {
        outcome = 'skipped'
        skipped = [...skipped, stage]
        nextStage = nextBrainstormStage(formSnapshot, choice, skipped)
        nextQuestion = brainstormQuestion(nextStage, formSnapshot)
      } else if (isBrainstormFieldFilled(stage, formSnapshot)) {
        nextStage = nextBrainstormStage(formSnapshot, choice, skipped)
        nextQuestion = `Thanks — “${brainstormAnswerText(stage, formSnapshot)}” is attached as your ${label}. I can’t read uploaded files yet, but it stays with your lesson form. ${brainstormQuestion(nextStage, formSnapshot)}`
      } else {
        outcome = 'retry'
        nextQuestion = `I don’t see a ${label} file yet. Choose “Upload File” to attach it, or skip this one.`
      }
    } else {
      // An edit replaces the field's value, so it's interpreted as if the
      // field were empty.
      const context = isEdit ? withoutBrainstormField(formSnapshot, stage) : formSnapshot
      const result = interpretBrainstormAnswer(stage, answerText, context)
      if (result.kind === 'retry') {
        outcome = 'retry'
        nextQuestion = result.hint
      } else if (result.kind === 'skip') {
        outcome = 'skipped'
        skipped = [...skipped, stage]
        if (isEdit) setEditingField(null)
        nextStage = nextBrainstormStage(formSnapshot, choice, skipped)
        nextQuestion = brainstormQuestion(nextStage, formSnapshot)
      } else {
        outcome = isEdit ? 'updated' : 'filled'
        summary = result.summary
        answeredField = stage
        // Apply the answer to the form now, and work out the next question
        // from the updated form.
        const updated: LessonFormSnapshot = { ...context }
        switch (result.field) {
          case 'gradeLevel':
            setGradeLevel(result.value)
            updated.gradeLevel = result.value
            break
          case 'topic':
            setTopic(result.value)
            updated.topic = result.value
            break
          case 'learningObjectives':
            setLearningObjectives(result.value)
            updated.learningObjectives = result.value
            break
          case 'instructionalSequence':
            setInstructionalSequence(result.value)
            updated.instructionalSequence = result.value
            break
          case 'priorInstruction':
            setPriorInstruction(result.value)
            updated.priorInstruction = result.value
            break
          case 'subsequentInstruction':
            setSubsequentInstruction(result.value)
            updated.subsequentInstruction = result.value
            break
          case 'differentiation':
            setDifferentiation(result.value)
            updated.differentiation = result.value
            break
          case 'materialsAndEquipment':
            setMaterialsAndEquipment(result.value)
            updated.materialsAndEquipment = result.value
            break
          case 'standards':
            setSelectedStandardCodes(result.value.codes)
            setCustomStandards(result.value.custom)
            updated.standards = result.value.codes
            updated.customStandards = result.value.custom
            break
          case 'pacing':
            setPacingSelection(result.value.selection)
            setCustomPacingMinutes(result.value.customMinutes)
            updated.pacingSelection = result.value.selection
            updated.customPacingMinutes = result.value.customMinutes
            break
          case 'practices':
            setSelectedPractices(result.value)
            updated.practices = result.value
            break
        }
        if (isEdit) setEditingField(null)
        nextStage = nextBrainstormStage(updated, choice, skipped)
        nextQuestion = brainstormQuestion(nextStage, updated)
      }
    }
    setCustomizeChoice(choice)
    setSkippedOptional(skipped)
    // Only accepted answers get an Edit button.
    setBrainstormMessages((prev) => [...prev, { role: 'teacher', text: answerText, field: answeredField }])

    const fieldLabel = isBrainstormField(stage) ? brainstormStepFor(stage).label : ''
    setIsBrainstormThinking(true)
    brainstormTimeoutRef.current = window.setTimeout(() => {
      const reply = brainstormReply({ outcome, fieldLabel, summary, nextQuestion, keptExistingAnswers: false })
      setBrainstormMessages((prev) => [...prev, { role: 'ai', text: reply }])
      setBrainstormField(nextStage)
      setIsBrainstormThinking(false)
    }, 600)
  }

  // The latest accepted answer for each field — the one its Edit button sits on.
  const latestAnswerIndex = new Map<BrainstormField, number>()
  brainstormMessages.forEach((message, index) => {
    if (message.field) latestAnswerIndex.set(message.field, index)
  })

  // Shown in the collapsed Additional Customization header.
  const customizationCount =
    [priorInstruction, subsequentInstruction, differentiation, materialsAndEquipment].filter((value) => value.trim() !== '').length +
    (lessonTemplateFile ? 1 : 0) +
    (rubricFile ? 1 : 0)

  const brainstormChips = isBrainstormThinking
    ? []
    : editingField
      ? brainstormQuickReplies(editingField, withoutBrainstormField(formSnapshot, editingField))
      : brainstormQuickReplies(brainstormField, formSnapshot)
  const standardsStage = (editingField ?? brainstormField) === 'standards' && !isBrainstormThinking
  // Selected codes stay listed even if they aren't among the suggestions.
  const brainstormStandardOptions = standardsStage
    ? [
        ...pendingStandards
          .filter((code) => !brainstormChips.some((chip) => chip.value === code))
          .map((code) => ({ label: code, value: code })),
        ...brainstormChips,
      ]
    : []
  const completionSummary = formCompletionSummary(formSnapshot)
  // The Form Completion summary above the input starts collapsed to its
  // one-line progress header.
  const [isSummaryOpen, setIsSummaryOpen] = useState(false)
  const revisionState = revisionEditor.activeLabel ? revisionEditor.statesByLabel[revisionEditor.activeLabel] : undefined

  return (
    <aside className="lesson-sidebar planning-panel">
      <div className="planning-methods" role="group" aria-label="How do you want to plan this lesson?">
        {planningMethods.map((method) => (
          <button
            key={method.id}
            type="button"
            className={`planning-method ${planningTab === method.id ? 'active' : ''}`}
            aria-pressed={planningTab === method.id}
            aria-controls="planning-method-content"
            onClick={() => chooseMethod(method.id)}
          >
            <span className="planning-method-icon" aria-hidden="true">
              {method.icon}
            </span>
            <span className="planning-method-text">
              <strong>{method.label}</strong>
              <small>{method.description}</small>
            </span>
          </button>
        ))}
      </div>

      <div id="planning-method-content" className="planning-method-content">
        {planningTab === 'upload' && (
          <div className="planning-form planning-upload">
            <div className="upload-card">
              <div>
                <p className="card-label">Already have a lesson?</p>
                <h4>Upload it for AI-supported review</h4>
              </div>
              {onUploadLesson ? (
                <label className="secondary-button library-file-button">
                  Upload file
                  <input
                    type="file"
                    accept=".pdf,.doc,.docx,.txt,.md,.ppt,.pptx"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) onUploadLesson(file, lessonDetails)
                      event.target.value = ''
                    }}
                  />
                </label>
              ) : (
                <button type="button" className="secondary-button">
                  Upload file
                </button>
              )}
            </div>

          </div>
        )}

        {planningTab === 'create' && (
          <div className="planning-form">
            <div className="panel-header">
              <h3>Lesson Preferences</h3>
              <span className="badge">Draft</span>
            </div>
            <p className="required-legend">
              <span className="required-mark" aria-hidden="true">
                *
              </span>{' '}
              Required to generate a lesson
            </p>

            <div className="field-grid">
              <label className={invalidClass('gradeLevel')}>
                <span>
                  Grade level <RequiredMark />
                </span>
                <select
                  value={gradeLevel}
                  aria-required="true"
                  aria-invalid={isInvalid('gradeLevel') || undefined}
                  onChange={(event) => setGradeLevel(event.target.value)}
                >
                  <option value="" disabled>
                    Select grade level
                  </option>
                  <option value="6-8">Grades 6–8</option>
                  <option value="9-12">Grades 9–12</option>
                </select>
                <FieldError show={isInvalid('gradeLevel')} />
              </label>

              <label className={invalidClass('topic')}>
                <span>
                  Topic <RequiredMark />
                </span>
                <input
                  type="text"
                  placeholder="Ecosystems, forces, photosynthesis..."
                  value={topic}
                  aria-required="true"
                  aria-invalid={isInvalid('topic') || undefined}
                  onChange={(event) => setTopic(event.target.value)}
                />
                <FieldError show={isInvalid('topic')} />
              </label>

              <div className={`standards-field ${invalidClass('standards')}`}>
                <div className="standards-field-header">
                  <span id="standards-label">
                    Standards <RequiredMark />
                  </span>
                  <label className="standards-framework">
                    <span className="visually-hidden">Standards framework</span>
                    <select value={framework} onChange={(event) => setFramework(event.target.value as StandardsFrameworkId)}>
                      {standardsFrameworks.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="standards-combobox">
                  <input
                    type="text"
                    role="combobox"
                    placeholder="Search by topic, concept, or standard code"
                    aria-labelledby="standards-label"
                    aria-autocomplete="list"
                    aria-expanded={isStandardsOpen}
                    aria-controls="standards-listbox"
                    aria-activedescendant={activeStandardOption ? `standard-option-${activeStandardOption.code}` : undefined}
                    value={standardsQuery}
                    onFocus={() => setIsStandardsOpen(true)}
                    onClick={() => setIsStandardsOpen(true)}
                    onBlur={() => {
                      setIsStandardsOpen(false)
                      setActiveStandardIndex(-1)
                    }}
                    onChange={(event) => {
                      setStandardsQuery(event.target.value)
                      setIsStandardsOpen(true)
                      setActiveStandardIndex(-1)
                    }}
                    onKeyDown={handleStandardsKeyDown}
                  />
                  {isStandardsOpen && (
                    // Options act on mousedown-prevented clicks so the search box keeps
                    // focus and the dropdown stays open for picking several standards.
                    <div className="standards-dropdown">
                      {standardsDropdownHeading && <p className="standards-dropdown-label">{standardsDropdownHeading}</p>}
                      {standardOptions.length > 0 ? (
                        <ul className="standards-suggestions" role="listbox" id="standards-listbox" aria-labelledby="standards-label" aria-multiselectable="true">
                          {standardOptions.map((standard, index) => (
                            <li
                              key={standard.code}
                              id={`standard-option-${standard.code}`}
                              role="option"
                              aria-selected={false}
                              className={`standard-suggestion ${index === activeStandardIndex ? 'active' : ''}`}
                              title={standard.description}
                              onMouseDown={(event) => event.preventDefault()}
                              onMouseEnter={() => setActiveStandardIndex(index)}
                              onClick={() => selectStandardOption(standard)}
                            >
                              <span className="standard-suggestion-code">{standard.code}</span>
                              <span className="standard-suggestion-description">{shortenStandardDescription(standard.description)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="standards-empty" id="standards-listbox" role="status">
                          {standardsDropdownMessage}
                        </p>
                      )}
                      {canAddCustomStandard && (
                        <button
                          type="button"
                          className="ghost-button standard-custom-add"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={addCustomStandard}
                        >
                          + Add “{standardsQuery.trim()}” as a custom standard
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {!selectedGradeBand ? (
                  <p className="standards-empty">Select a grade level above to see suggested standards.</p>
                ) : frameworkStandards.length === 0 ? (
                  <p className="standards-empty">
                    Verified {standardsFrameworkName(framework)} standards haven’t been loaded yet, so there are no suggestions.
                    Switch the framework to NGSS, or add your standard as a custom entry.
                  </p>
                ) : null}

                {!isStandardsOpen && topicSuggestions.length > 0 && (
                  <div className="standards-suggested">
                    <p className="standards-suggested-label">
                      Suggested for “{topic.trim()}” · {standardsFrameworkName(framework)}
                    </p>
                    <div className="standards-suggested-row">
                      {topicSuggestions.map((standard) => (
                        <button
                          type="button"
                          key={standard.code}
                          className="standard-suggestion-bubble"
                          title={standard.description}
                          aria-label={`Add ${standard.code}: ${standard.description}`}
                          onClick={() => addStandard(standard.code)}
                        >
                          <span aria-hidden="true">+</span> {standard.code}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {(selectedStandardCodes.length > 0 || customStandards.length > 0) && (
                  <div className="selected-standards-row" aria-label="Selected standards">
                    {selectedStandardCodes.map((code) => {
                      const standard = scienceStandardsBank.find((item) => item.code === code)
                      if (!standard) return null
                      return (
                        <span key={code} className="tag selected-standard-chip" title={standard.description}>
                          {standard.code}
                          <button
                            type="button"
                            className="chip-remove"
                            aria-label={`Remove ${standard.code}`}
                            onClick={() => removeStandard(code)}
                          >
                            ×
                          </button>
                        </span>
                      )
                    })}
                    {customStandards.map((text) => (
                      <span key={text} className="tag selected-standard-chip custom" title="Custom standard you entered">
                        {text} <small>(custom)</small>
                        <button
                          type="button"
                          className="chip-remove"
                          aria-label={`Remove ${text}`}
                          onClick={() => setCustomStandards((prev) => prev.filter((item) => item !== text))}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <FieldError show={isInvalid('standards')} message="Add at least one standard." />
              </div>

              <div
                className={`practice-field science-practices-field ${invalidClass('practices')}`}
                role="group"
                aria-labelledby="practices-label"
              >
                <span id="practices-label">
                  Science Practices to Emphasize <RequiredMark />
                </span>
                <div className="practice-chip-row">
                  {practiceOptions.map((practice) => (
                    <button
                      key={practice.id}
                      type="button"
                      className={`practice-chip ${selectedPractices.includes(practice.id) ? 'selected' : ''}`}
                      aria-pressed={selectedPractices.includes(practice.id)}
                      title={practice.description}
                      onClick={() => togglePractice(practice.id)}
                    >
                      {practice.label}
                    </button>
                  ))}
                </div>
                {selectedPractices.length > 0 && (
                  <div className="selected-standards-row selected-practices-row" aria-label="Selected science practices">
                    {practiceOptions
                      .filter((practice) => selectedPractices.includes(practice.id))
                      .map((practice) => (
                        <span key={practice.id} className="tag selected-standard-chip">
                          {practice.label}
                          <button
                            type="button"
                            className="chip-remove"
                            aria-label={`Remove ${practice.label}`}
                            onClick={() => togglePractice(practice.id)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                  </div>
                )}
                <FieldError show={isInvalid('practices')} message="Choose at least one science practice." />
              </div>

              <label className={invalidClass('learningObjectives')}>
                <span>
                  Learning objectives <RequiredMark />
                </span>
                <textarea
                  rows={4}
                  placeholder="Describe the target learning outcomes related to the science practices you have identified"
                  value={learningObjectives}
                  aria-required="true"
                  aria-invalid={isInvalid('learningObjectives') || undefined}
                  onChange={(event) => setLearningObjectives(event.target.value)}
                />
                <FieldError show={isInvalid('learningObjectives')} />
              </label>

              <label className={invalidClass('instructionalSequence')}>
                <span>
                  Instructional sequence <RequiredMark />
                </span>
                <textarea
                  rows={3}
                  placeholder="Outline the order of activities — e.g., launch a phenomenon, investigate, make sense of evidence..."
                  value={instructionalSequence}
                  aria-required="true"
                  aria-invalid={isInvalid('instructionalSequence') || undefined}
                  onChange={(event) => setInstructionalSequence(event.target.value)}
                />
                <FieldError show={isInvalid('instructionalSequence')} />
              </label>

              <div className={`practice-field ${invalidClass('pacing')}`} role="group" aria-labelledby="pacing-label">
                <span id="pacing-label">
                  Pacing / Duration <RequiredMark />
                </span>
                <div className="practice-chip-row pacing-chip-row">
                  {pacingOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`practice-chip pacing-chip ${pacingSelection === option.id ? 'selected' : ''}`}
                      aria-pressed={pacingSelection === option.id}
                      onClick={() => setPacingSelection(option.id)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {pacingSelection === 'custom' && (
                  <label className="pacing-custom-field">
                    <span>Custom duration (minutes)</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      min={1}
                      className="pacing-custom-input"
                      placeholder="e.g. 50"
                      value={customPacingMinutes}
                      aria-required="true"
                      aria-invalid={isInvalid('pacing') || undefined}
                      onChange={(event) => setCustomPacingMinutes(event.target.value)}
                    />
                  </label>
                )}
                <FieldError
                  show={isInvalid('pacing')}
                  message={pacingSelection === 'custom' ? 'Enter a positive number of minutes.' : 'Choose a duration.'}
                />
              </div>
            </div>

            <section
              className={`customization-section${isCustomizationOpen ? ' open' : ''}`}
              aria-labelledby="customization-heading"
            >
              <h4 className="customization-heading" id="customization-heading">
                <button
                  type="button"
                  className="customization-toggle"
                  aria-expanded={isCustomizationOpen}
                  aria-controls="customization-content"
                  onClick={() => setIsCustomizationOpen((open) => !open)}
                >
                  <span className="customization-title">Additional Customization</span>
                  {customizationCount > 0 && <span className="badge">{customizationCount} added</span>}
                  <span className="customization-chevron" aria-hidden="true">
                    {isCustomizationOpen ? '▴' : '▾'}
                  </span>
                </button>
              </h4>
              <p className="customization-description">This will help better adapt the generated lesson to your context.</p>
              {isCustomizationOpen && (
                <div className="field-grid customization-fields" id="customization-content">
                  <label>
                    <span>Prior Instruction</span>
                    <textarea
                      rows={3}
                      placeholder="What should students already know? Include possible misconceptions."
                      value={priorInstruction}
                      onChange={(event) => setPriorInstruction(event.target.value)}
                    />
                  </label>

                  <label>
                    <span>Subsequent Instruction</span>
                    <textarea
                      rows={3}
                      placeholder="What will students learn or do after this lesson?"
                      value={subsequentInstruction}
                      onChange={(event) => setSubsequentInstruction(event.target.value)}
                    />
                  </label>

                  <label>
                    <span>Differentiation</span>
                    <textarea
                      rows={3}
                      placeholder="What student needs or accommodations should the activities address?"
                      value={differentiation}
                      onChange={(event) => setDifferentiation(event.target.value)}
                    />
                  </label>

                  <label>
                    <span>Materials &amp; equipment</span>
                    <textarea
                      rows={2}
                      placeholder="Materials, equipment, technology, lab/safety needs..."
                      value={materialsAndEquipment}
                      onChange={(event) => setMaterialsAndEquipment(event.target.value)}
                    />
                  </label>

                  <OptionalFileUpload
                    id="optional-upload-lessonTemplate"
                    {...lessonUploads.lessonTemplate}
                    file={lessonTemplateFile}
                    onChange={setLessonTemplateFile}
                  />
                  <OptionalFileUpload
                    id="optional-upload-rubric"
                    {...lessonUploads.rubric}
                    file={rubricFile}
                    onChange={setRubricFile}
                  />
                  <p className="customization-note">
                    Uploaded files aren’t read yet. A rubric is referenced for evaluating student work; a template can’t
                    shape the lesson’s formatting until files can be read.
                  </p>
                </div>
              )}
            </section>

            <RequiredFieldsAlert show={showValidation} missing={missingRequired} />
            <button type="button" className="primary-button generate-button" onClick={handleGenerate}>
              Generate Lesson
            </button>
          </div>
        )}

        {planningTab === 'brainstorm' && (
          <div className="planning-chat brainstorm-chat">
            <div className="brainstorm-intro">
              <h3>Plan Your Lesson with AI</h3>
              <p>
                Your AI assistant will guide you through the lesson planning form, one question at a time. Your answers will help
                fill in the form automatically.
              </p>
            </div>

            <div className="planning-thread brainstorm-thread" ref={brainstormThreadRef}>
              <div className="chat-thread">
                {brainstormMessages.map((message, index) => (
                  <div key={index} className={`chat-message ${message.role === 'teacher' ? 'teacher-message' : 'ai-message'}`}>
                    <p className="chat-message-label">{message.role === 'teacher' ? 'You' : 'AI'}</p>
                    {message.text}
                    {message.field && latestAnswerIndex.get(message.field) === index && editingField !== message.field && (
                      <button
                        type="button"
                        className="brainstorm-edit-answer"
                        disabled={isBrainstormThinking}
                        aria-label={`Edit your answer for ${brainstormStepFor(message.field).label}`}
                        onClick={() => message.field && startEditingAnswer(message.field)}
                      >
                        Edit
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {isBrainstormThinking && <p className="empty-state-support">AI is thinking…</p>}
              {standardsStage && brainstormStandardOptions.length > 0 ? (
                <div className="brainstorm-standards-picker">
                  <div className="brainstorm-quick-replies" role="group" aria-label="Suggested standards">
                    {brainstormStandardOptions.map((option) => {
                      const selected = pendingStandards.includes(option.value)
                      const standard = scienceStandardsBank.find((item) => item.code === option.value)
                      return (
                        <button
                          key={option.value}
                          type="button"
                          className={`practice-chip ${selected ? 'selected' : ''}`}
                          aria-pressed={selected}
                          title={standard?.description}
                          onClick={() => togglePendingStandard(option.value)}
                        >
                          {selected && (
                            <span className="chip-check" aria-hidden="true">
                              ✓
                            </span>
                          )}
                          {option.label}
                        </button>
                      )
                    })}
                  </div>
                  <div className="brainstorm-standards-confirm">
                    <button type="button" className="primary-button" disabled={pendingStandards.length === 0} onClick={confirmStandards}>
                      Confirm Selection
                    </button>
                    <span className="library-class-note" role="status">
                      {pendingStandards.length === 0
                        ? 'Select at least one standard to continue.'
                        : `${pluralize(pendingStandards.length, 'standard')} selected`}
                    </span>
                  </div>
                </div>
              ) : (
                brainstormChips.length > 0 && (
                  <div className="brainstorm-quick-replies" aria-label="Suggested answers">
                    {brainstormChips.map((chip) => (
                      <button
                        key={chip.label}
                        type="button"
                        className="practice-chip"
                        onClick={() => (chip.openUpload ? setBrainstormUpload(chip.openUpload) : sendBrainstormAnswer(chip.value))}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                )
              )}
              {editingField && (
                <p className="brainstorm-editing-note" role="status">
                  Editing your answer for <strong>{brainstormStepFor(editingField).label}</strong>.{' '}
                  <button type="button" className="ghost-button" onClick={cancelEditingAnswer}>
                    Cancel
                  </button>
                </p>
              )}
            </div>

            <section className={`form-summary${isSummaryOpen ? ' open' : ''}`} aria-labelledby="form-summary-heading">
              <h4 className="form-summary-heading" id="form-summary-heading">
                <button
                  type="button"
                  className="form-summary-toggle"
                  aria-expanded={isSummaryOpen}
                  aria-controls="form-summary-content"
                  onClick={() => setIsSummaryOpen((open) => !open)}
                >
                  <span className="form-summary-title">Form Completion</span>
                  <span className="form-summary-count" title="Required fields completed">
                    {requiredFilledCount}/{requiredBrainstormSteps.length}
                  </span>
                  <span className="form-summary-progress" aria-hidden="true">
                    <span style={{ width: `${(requiredFilledCount / requiredBrainstormSteps.length) * 100}%` }} />
                  </span>
                  {optionalFilledCount > 0 && <span className="form-summary-optional">+{optionalFilledCount} optional</span>}
                  <span className="form-summary-chevron" aria-hidden="true">
                    {isSummaryOpen ? '▴' : '▾'}
                  </span>
                </button>
              </h4>
              {isSummaryOpen && (
                <div className="form-summary-content" id="form-summary-content">
                  {(['required', 'optional'] as const).map((group) => {
                    const items = completionSummary.filter((item) => item.optional === (group === 'optional'))
                    return (
                      <div key={group} className="form-summary-group">
                        <p className="form-summary-group-label">
                          {group === 'required' ? 'Required' : 'Optional'} · {items.filter((item) => item.value).length}/{items.length}
                        </p>
                        <ul className="form-summary-bubbles" aria-label={group === 'required' ? 'Required fields' : 'Optional fields'}>
                          {items.map((item) => {
                            const content = (
                              <>
                                <span className="form-summary-icon" aria-hidden="true">
                                  {item.value ? '✓' : ''}
                                </span>
                                <span className="visually-hidden">{item.value ? 'Completed: ' : 'Not completed: '}</span>
                                {item.value ? (
                                  <>
                                    <span className="form-summary-label">{item.label}:</span> {item.value}
                                  </>
                                ) : (
                                  item.label
                                )}
                              </>
                            )
                            const title = item.value
                              ? `${brainstormStepFor(item.field).label}: ${brainstormAnswerText(item.field, formSnapshot)}`
                              : `${brainstormStepFor(item.field).label} — not completed`
                            // Template and Rubric open their upload right here.
                            if (item.field === 'lessonTemplate' || item.field === 'rubric') {
                              const field = item.field
                              return (
                                <li key={field}>
                                  <button
                                    type="button"
                                    className={`form-summary-bubble form-summary-bubble-button ${item.value ? 'complete' : ''}`}
                                    title={`${title} — click to ${item.value ? 'view or replace the file' : 'upload a file'}`}
                                    aria-expanded={brainstormUpload === field}
                                    aria-controls="brainstorm-upload"
                                    onClick={() => setBrainstormUpload((open) => (open === field ? null : field))}
                                  >
                                    {content}
                                  </button>
                                </li>
                              )
                            }
                            return (
                              <li key={item.field} className={`form-summary-bubble ${item.value ? 'complete' : ''}`} title={title}>
                                {content}
                              </li>
                            )
                          })}
                        </ul>
                      </div>
                    )
                  })}
                  <button type="button" className="ghost-button form-summary-review" onClick={() => chooseMethod('create')}>
                    Review the form
                  </button>
                </div>
              )}
            </section>

            {brainstormUpload && (
              <div className="brainstorm-upload" id="brainstorm-upload">
                <OptionalFileUpload
                  id={`brainstorm-upload-${brainstormUpload}`}
                  {...lessonUploads[brainstormUpload]}
                  file={uploadFiles[brainstormUpload]}
                  onChange={(file) => attachBrainstormFile(brainstormUpload, file)}
                />
                <div className="brainstorm-upload-footer">
                  <p className="customization-note">Also shown in the form’s Additional Customization. Files aren’t read by the AI yet.</p>
                  <button type="button" className="ghost-button brainstorm-upload-close" onClick={() => setBrainstormUpload(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}

            <form
              className="composer-box brainstorm-composer"
              onSubmit={(event) => {
                event.preventDefault()
                sendBrainstormAnswer(brainstormDraft)
              }}
            >
              <input
                type="text"
                ref={brainstormInputRef}
                aria-label="Your answer"
                placeholder={
                  editingField
                    ? `Edit your answer for ${brainstormStepFor(editingField).label}…`
                    : brainstormField === 'done'
                      ? 'Ask a follow-up…'
                      : 'Type your answer…'
                }
                value={brainstormDraft}
                onChange={(event) => setBrainstormDraft(event.target.value)}
                disabled={isBrainstormThinking}
              />
              <button type="submit" className="primary-button" disabled={isBrainstormThinking || !brainstormDraft.trim()}>
                {editingField ? 'Update' : 'Send'}
              </button>
            </form>

            <RequiredFieldsAlert
              show={showValidation}
              missing={missingRequired}
              hint="Keep answering, or open “Create a new lesson” to fill them in."
            />
            <div className="brainstorm-actions">
              <button type="button" className="primary-button generate-button" onClick={handleGenerate}>
                Generate Lesson Plan
              </button>
            </div>
          </div>
        )}

        {planningTab === 'revision' && revisionEditor.activeLabel && revisionState && (
          <div className="planning-chat">
            <RevisionChatPanel
              key={revisionEditor.activeLabel}
              label={revisionEditor.activeLabel}
              state={revisionState}
              isThinking={revisionEditor.isThinking}
              draft={revisionDraft}
              onDraftChange={setRevisionDraft}
              onSend={() => {
                const label = revisionEditor.activeLabel
                if (!label || !revisionDraft.trim()) return
                revisionEditor.sendFollowUp(label, revisionDraft.trim())
                setRevisionDraft('')
              }}
              onApply={(editedText) =>
                revisionEditor.activeLabel && revisionEditor.apply(revisionEditor.activeLabel, editedText)
              }
              onClose={() => {
                revisionEditor.closeChat()
                setPlanningTab(lastMethod)
              }}
            />
          </div>
        )}
      </div>
    </aside>
  )
}

// Shown in place of the generated lesson on Lesson Planning whenever
// Generate Lesson hasn't actually been clicked yet — the page must never
// show lesson content the teacher didn't ask for. `isGenerating`
// swaps in a brief, lightweight "in progress" message (mirroring the same
// plain-text convention "Regenerate Questions" uses on the dashboard)
// between the click and the content actually appearing.
function LessonWorkspacePlaceholder({ isGenerating }: { isGenerating: boolean }) {
  return (
    <section className="workspace-placeholder lesson-workspace-panel">
      <div className="canvas-header">
        <div>
          <p className="card-label">Lesson workspace</p>
          <h3>Lesson plan</h3>
        </div>
      </div>

      {isGenerating ? (
        <div className="empty-state">
          <p className="card-label">Generating lesson</p>
          <h3>Building your aligned lesson plan…</h3>
          <p className="empty-state-support">This will just take a moment.</p>
        </div>
      ) : (
        <div className="empty-state">
          <p className="card-label">Ready for lesson output</p>
          <h3>Your generated lesson will appear here</h3>
          <p className="empty-state-support">
            Complete your lesson preferences and click Generate Lesson to create an aligned lesson plan.
          </p>
        </div>
      )}
    </section>
  )
}

// Lifted to App so "See AI Suggestions" can switch the LessonPlanningPanel
// over to its AI Chat tab, scoped to the section the teacher just clicked.
// The PARTNERS wordmark + acronym subtitle, shared by the app header and the
// mock Login page.
function BrandWordmark() {
  return (
    <div className="brand-text">
      {/* The PARTNERS wordmark is a single dark blue (see .brand-name
          in App.css); the subtitle below keeps its per-letter-group
          accent colors (brand-color-* classes). */}
      <span className="brand-name">PARTNERS</span>
      <span className="brand-subtitle">
        <span>
          <span className="brand-subtitle-highlight brand-color-blue">P</span>romoting an{' '}
          <span className="brand-subtitle-highlight brand-color-blue">A</span>rtificial Intelligence-
          <span className="brand-subtitle-highlight brand-color-blue">R</span>esearcher-
          <span className="brand-subtitle-highlight brand-color-green">T</span>eacher{' '}
          <span className="brand-subtitle-highlight brand-color-green">N</span>etwork
        </span>
        <span>
          to <span className="brand-subtitle-highlight brand-color-purple">E</span>nhance P
          <span className="brand-subtitle-highlight brand-color-purple">r</span>actices in{' '}
          <span className="brand-subtitle-highlight brand-color-orange">S</span>cience
        </span>
      </span>
    </div>
  )
}

// Mock login and account creation — no authentication. Submitting hands the
// entered values to onLogin, which decides where to go (see
// getPostLoginPage) and may return an error to show.
function LoginPage({ onLogin }: { onLogin: (credentials: MockLoginCredentials) => string | null }) {
  const [mode, setMode] = useState<MockLoginCredentials['mode']>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [state, setState] = useState<TeacherState | ''>('')
  const [district, setDistrict] = useState('')
  const [error, setError] = useState<string | null>(null)
  const isCreate = mode === 'create'

  return (
    <div className="app-shell login-shell">
      <form
        className="login-card"
        onSubmit={(event) => {
          event.preventDefault()
          setError(onLogin({ email, password, mode, state, district }))
        }}
      >
        <BrandWordmark />
        <div className="login-heading">
          <h2>{isCreate ? 'Create Teacher Account' : 'Teacher Login'}</h2>
          <p>
            {isCreate
              ? 'Next, you’ll set up your first class and student roster.'
              : 'Sign in to plan lessons and review student feedback.'}
          </p>
        </div>
        <div className="field-grid">
          <label>
            <span>Email</span>
            <input
              type="email"
              autoComplete="username"
              placeholder="teacher@school.edu"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              autoComplete={isCreate ? 'new-password' : 'current-password'}
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {isCreate && (
            <>
              <label>
                <span>
                  State <RequiredMark />
                </span>
                <select value={state} aria-required="true" onChange={(event) => setState(event.target.value as TeacherState)}>
                  <option value="" disabled>
                    Select your state
                  </option>
                  {teacherStateOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>
                  District <RequiredMark />
                </span>
                <input
                  type="text"
                  autoComplete="organization"
                  placeholder="Your school district"
                  value={district}
                  aria-required="true"
                  onChange={(event) => setDistrict(event.target.value)}
                />
              </label>
            </>
          )}
        </div>
        {error && (
          <p className="roster-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary-button login-submit">
          {isCreate ? 'Create Account' : 'Login'}
        </button>
        <button
          type="button"
          className="ghost-button login-mode-toggle"
          onClick={() => {
            setMode(isCreate ? 'login' : 'create')
            setError(null)
          }}
        >
          {isCreate ? 'Already have an account? Log in' : 'New to PARTNERS? Create an account'}
        </button>
        <p className="login-note">
          Prototype only — no real authentication. {DEMO_TEACHER_EMAIL} (or a blank email) signs in as a returning teacher;
          any other email is a first-time login.
        </p>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------------------
// My Lesson Library
//
// There's no persistent lesson store in this prototype, so the Library reads
// these mock records. Each destination points at content that actually
// exists here: only the first lesson's plan has demo content (the Zombie
// Fires lesson, which is also about carbon release), Student Feedback
// assignments open the demo student page on the matching model tab, and
// Class Feedback opens the demo dashboard. An unavailable destination renders
// as a disabled button. Lessons are grouped under classes (LibraryClass);
// lessons not assigned to any class are listed separately.
// ---------------------------------------------------------------------------

// `link` is set for a lesson's confirmed Student Feedback Activities.
type StudentFeedbackAssignment = { id: string; title: string; modelTab: ModelTab; link?: StudentAssignmentLink }

type LibraryLesson = {
  id: string
  title: string
  // A single grade ("10") or a grade band from the planning form ("9-12");
  // null when a lesson was saved before a grade was chosen.
  grade: string | null
  topic: string
  bannerColor: string
  // `document` is the lesson generated for it on Lesson Planning; lessons
  // without one show the demo lesson when hasDemoContent is set.
  lessonPlan: { hasDemoContent: boolean; document?: LessonDocument; feedbackActivities?: FeedbackActivity[] }
  studentFeedback: StudentFeedbackAssignment[]
  classFeedback: { available: boolean }
  // The teacher whose Library this lesson is in.
  ownerEmail: string
  // Standards the teacher selected for this lesson.
  standards: LessonStandardRef[]
  // Science practice ids the lesson emphasizes.
  sciencePractices: string[]
  durationMinutes: number | null
}

// Where a Library navigation came from — the lesson, and the class it was
// opened under (absent for unassigned lessons). Drives the context banner.
type LibraryContext = {
  lesson: LibraryLesson
  className?: string
  page: PageId
  assignmentTitle?: string
}

// A class owns its roster, so assigning another lesson to the class reuses
// the same students without uploading the roster again. A lesson can be
// assigned to any number of classes. The roster is a list of Student IDs
// from the shared student registry (see Student), so one student can be in
// several classes under the same ID.
type LibraryClass = {
  id: string
  name: string
  gradeLevel: string
  // Optional period or section as the teacher typed it ("2", "Period 2",
  // "Section B"); empty when not given.
  period: string
  ownerEmail: string
  bannerColor: string
  studentIds: string[]
  lessonIds: string[]
}

// A student in the shared registry. `id` is the PARTNERS Student ID and
// `pseudonym` the generated name shown wherever a student shouldn't be
// identified; both are assigned once and reused in every class. `name` is
// a first name or initials only (see rosterNameProblem) — no other personal
// information is stored.
type Student = {
  id: string
  name: string
  pseudonym: string
}

// A bare number is shown as "Period 2"; anything else as typed.
function formatPeriod(period: string): string {
  return /^\d+$/.test(period) ? `Period ${period}` : period
}

// How a class is labeled everywhere outside Class Setup — e.g. the Library
// card title "Period 2 · Earth Science".
function classDisplayName(classroom: Pick<LibraryClass, 'name' | 'period'>): string {
  return classroom.period ? `${formatPeriod(classroom.period)} · ${classroom.name}` : classroom.name
}

// The class + lesson navigation handlers, shared by class cards and the
// unassigned lesson cards. `classroom` is null for an unassigned lesson.
type LessonNavHandlers = {
  onOpenLessonPlan: (lesson: LibraryLesson, classroom: LibraryClass | null) => void
  onOpenStudentFeedback: (
    lesson: LibraryLesson,
    assignment: StudentFeedbackAssignment,
    classroom: LibraryClass | null,
  ) => void
  onOpenClassFeedback: (lesson: LibraryLesson, classroom: LibraryClass | null) => void
}

// The class a lesson is being created for on Lesson Planning (via a class
// card's Add Lesson), and the Library lesson it has been saved as, if any.
type PlanningTarget = { classId: string; savedLessonId: string | null }

// Which classes are expanded and which lesson's navigation is open, keyed
// `classId:lessonId`. Lifted to App so the Library looks the same when the
// teacher comes back from a lesson page.
type LibraryViewState = { expandedClassIds: string[]; openLessonKey: string | null }

// The starting Library contents. App copies these into state so lessons
// created from a class's Add Lesson can be saved alongside them.
const initialLibraryLessons: LibraryLesson[] = [
  {
    id: 'climate-carbon-cycle',
    title: 'Climate Change and Carbon Cycle',
    grade: '10',
    topic: 'Earth Science',
    bannerColor: '#5b7f95',
    lessonPlan: { hasDemoContent: true },
    studentFeedback: [
      { id: 'climate-descriptive', title: 'Descriptive Model', modelTab: 'descriptive' },
      { id: 'climate-mechanistic', title: 'Mechanistic Model', modelTab: 'mechanistic' },
    ],
    classFeedback: { available: true },
    ownerEmail: DEMO_TEACHER_EMAIL,
    standards: [],
    sciencePractices: [],
    durationMinutes: null,
  },
  {
    id: 'ecosystem-interactions',
    title: 'Ecosystem Interactions',
    grade: '8',
    topic: 'Life Science',
    bannerColor: '#6f8f6a',
    lessonPlan: { hasDemoContent: false },
    studentFeedback: [{ id: 'ecosystem-descriptive', title: 'Descriptive Model', modelTab: 'descriptive' }],
    classFeedback: { available: false },
    ownerEmail: DEMO_TEACHER_EMAIL,
    standards: [],
    sciencePractices: [],
    durationMinutes: null,
  },
  {
    id: 'chemical-reactions',
    title: 'Chemical Reactions',
    grade: '9',
    topic: 'Physical Science',
    bannerColor: '#8a7299',
    lessonPlan: { hasDemoContent: false },
    studentFeedback: [],
    classFeedback: { available: false },
    ownerEmail: DEMO_TEACHER_EMAIL,
    standards: [],
    sciencePractices: [],
    durationMinutes: null,
  },
]

function formatLessonGrade(grade: string | null): string {
  if (!grade) return 'Grade not set'
  return grade.includes('-') ? `Grades ${grade.replace('-', '–')}` : `Grade ${grade}`
}

const lessonBannerColors = ['#5b7f95', '#6f8f6a', '#8a7299', '#9a7b5b', '#5f7f8a', '#7f6f8f']

// Builds the Library record for a lesson generated or uploaded on Lesson
// Planning after a class's Add Lesson. Title and grade come from the
// planning form (or the uploaded file's name); the plan opens the demo
// lesson workspace, and a brand-new lesson has no feedback yet.
function createLibraryLessonFromPlanning(
  id: string,
  details: PlanningLessonDetails,
  bannerColor: string,
  ownerEmail: string,
  uploadedFileName?: string,
  document?: LessonDocument,
): LibraryLesson {
  const topic = details.topic.trim()
  const title = uploadedFileName ? uploadedFileName.replace(/\.[^.]+$/, '') : topic
  return {
    id,
    title: title || 'Untitled Lesson',
    grade: details.gradeLevel || null,
    topic: topic || 'Not specified',
    bannerColor,
    lessonPlan: { hasDemoContent: true, document },
    studentFeedback: [],
    classFeedback: { available: false },
    ownerEmail,
    standards: details.standards,
    sciencePractices: details.sciencePractices,
    durationMinutes: details.durationMinutes,
  }
}

// Muted banner colors for class cards, cycled for newly created classes.
const classBannerColors = ['#4f6f8f', '#8f7a5b', '#5f8a7d', '#7d6f94', '#8a6a6a', '#5d7d6b']

// Mock roster names, built from first names × last initials so the seeded
// classes don't accidentally share students.
const mockRosterFirstNames = [
  'Avery', 'Bianca', 'Caleb', 'Dana', 'Eli', 'Fatima', 'Gabe', 'Hana', 'Isaac', 'Jada', 'Kai', 'Lena',
  'Mateo', 'Nia', 'Owen', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq', 'Uma', 'Vince', 'Willa', 'Yusuf',
]
const mockRosterNames = [0, 1].flatMap((round) =>
  mockRosterFirstNames.map((first, index) => `${first} ${String.fromCharCode(65 + ((index * 7 + round * 11) % 26))}.`),
)

const pseudonymAdjectives = [
  'Bright', 'Calm', 'Clever', 'Curious', 'Daring', 'Eager', 'Gentle', 'Happy', 'Keen', 'Kind', 'Lively', 'Lucky',
  'Merry', 'Nimble', 'Patient', 'Quick', 'Quiet', 'Swift', 'Sunny', 'Steady', 'Brave', 'Bold', 'Witty', 'Zesty',
]
const pseudonymAnimals = [
  'Otter', 'Falcon', 'Panda', 'Heron', 'Fox', 'Badger', 'Dolphin', 'Lynx', 'Owl', 'Koala', 'Robin', 'Turtle',
  'Bison', 'Crane', 'Gecko', 'Ibis', 'Jaguar', 'Lemur', 'Marmot', 'Newt', 'Orca', 'Puffin', 'Quokka', 'Wren',
]

function formatStudentId(studentNumber: number): string {
  return `S-${String(studentNumber).padStart(4, '0')}`
}

function nextStudentNumber(students: readonly Student[]): number {
  return students.reduce((max, student) => Math.max(max, Number(student.id.replace(/\D/g, '')) || 0), 0) + 1
}

// Picks an unused "Adjective Animal" pseudonym. Stepping through the
// combinations by a large prime keeps consecutive students from getting
// near-identical pseudonyms.
function createPseudonym(studentNumber: number, used: ReadonlySet<string>): string {
  const total = pseudonymAdjectives.length * pseudonymAnimals.length
  for (let attempt = 0; attempt < total; attempt++) {
    const index = (studentNumber * 97 + attempt) % total
    const pseudonym = `${pseudonymAdjectives[index % pseudonymAdjectives.length]} ${pseudonymAnimals[Math.floor(index / pseudonymAdjectives.length)]}`
    if (!used.has(pseudonym)) return pseudonym
  }
  return `Student ${studentNumber}`
}

function createStudent(studentNumber: number, name: string, used: ReadonlySet<string>): Student {
  return { id: formatStudentId(studentNumber), name, pseudonym: createPseudonym(studentNumber, used) }
}

// Built lazily (and once — App's student and class state both read it)
// because the Period 2 roster reuses the Class Feedback demo's student
// names, which are defined further down this file.
let initialLibraryData: { students: Student[]; classes: LibraryClass[] } | null = null

function getInitialLibraryData() {
  if (initialLibraryData) return initialLibraryData
  const students: Student[] = []
  const used = new Set<string>()
  const enroll = (names: readonly string[]) =>
    names.map((name) => {
      const student = createStudent(students.length + 1, name, used)
      used.add(student.pseudonym)
      students.push(student)
      return student.id
    })
  const classes: LibraryClass[] = [
    {
      id: 'period-2-earth-science',
      name: 'Earth Science',
      gradeLevel: '10',
      period: '2',
      ownerEmail: DEMO_TEACHER_EMAIL,
      bannerColor: classBannerColors[0],
      studentIds: enroll(assignmentStudentRoster),
      lessonIds: ['climate-carbon-cycle'],
    },
    {
      id: 'period-4-earth-science',
      name: 'Earth Science',
      gradeLevel: '10',
      period: '4',
      ownerEmail: DEMO_TEACHER_EMAIL,
      bannerColor: classBannerColors[1],
      studentIds: enroll(mockRosterNames.slice(0, 22)),
      lessonIds: ['climate-carbon-cycle'],
    },
    {
      id: 'period-1-life-science',
      name: 'Life Science',
      gradeLevel: '8',
      period: '1',
      ownerEmail: DEMO_TEACHER_EMAIL,
      bannerColor: classBannerColors[2],
      studentIds: enroll(mockRosterNames.slice(22, 48)),
      lessonIds: ['ecosystem-interactions'],
    },
  ]
  initialLibraryData = { students, classes }
  return initialLibraryData
}

function matchesLibraryKeyword(lesson: LibraryLesson, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase()
  if (!needle) return true
  return lesson.title.toLowerCase().includes(needle) || lesson.topic.toLowerCase().includes(needle)
}

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

function LibraryContextBanner({ context, onDismiss }: { context: LibraryContext; onDismiss: () => void }) {
  const { lesson, className, page, assignmentTitle } = context
  let note: string
  if (page === 'lesson-generator') {
    note = lesson.lessonPlan.hasDemoContent
      ? 'Showing the saved lesson plan (prototype demo content).'
      : 'Saved content for this lesson isn’t connected in the prototype yet — the planning form is shown so you can draft it.'
  } else if (page === 'student-feedback') {
    note = `${assignmentTitle ?? 'Assignment'} — the prototype shows its demo student assignment.`
  } else {
    note = 'The prototype shows its demo class feedback analysis.'
  }

  return (
    <div className="library-context-banner" role="status">
      <span className="library-context-swatch" style={{ background: lesson.bannerColor }} aria-hidden="true" />
      <p>
        <strong>Opened from My Lesson Library: {lesson.title}</strong>
        {className ? ` · ${className}` : ''} · {formatLessonGrade(lesson.grade)}
        <br />
        <span>{note}</span>
      </p>
      <button type="button" className="drawer-close" aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}

// Shown on Lesson Planning after a class card's Add Lesson, so the teacher
// knows which class the new lesson will be saved to — and, once it's saved,
// where to find it.
function PlanningClassBanner({
  classroom,
  savedLesson,
  onViewInLibrary,
  onDismiss,
}: {
  classroom: LibraryClass
  savedLesson: LibraryLesson | null
  onViewInLibrary: () => void
  onDismiss: () => void
}) {
  return (
    <div className="library-context-banner planning-class-banner" role="status">
      <span className="library-context-swatch" style={{ background: classroom.bannerColor }} aria-hidden="true" />
      <p>
        {savedLesson ? (
          <>
            <strong>
              Saved “{savedLesson.title}” to {classDisplayName(classroom)}
            </strong>
            <br />
            <span>Generating or uploading again updates this saved lesson.</span>
          </>
        ) : (
          <>
            <strong>Creating a lesson for {classDisplayName(classroom)}</strong> ·{' '}
            {pluralize(classroom.studentIds.length, 'student')}
            <br />
            <span>When you generate or upload a lesson, it’s saved to this class in your Library.</span>
          </>
        )}
      </p>
      {savedLesson && (
        <button type="button" className="secondary-button" onClick={onViewInLibrary}>
          View in Library
        </button>
      )}
      <button type="button" className="drawer-close" aria-label={`Stop adding to ${classDisplayName(classroom)}`} onClick={onDismiss}>
        ×
      </button>
    </div>
  )
}

function LibraryPage({
  lessons: allLessons,
  classes,
  view,
  setView,
  nav,
  onAddLesson,
}: {
  lessons: readonly LibraryLesson[]
  classes: readonly LibraryClass[]
  view: LibraryViewState
  setView: Dispatch<SetStateAction<LibraryViewState>>
  nav: LessonNavHandlers
  onAddLesson: (classroom: LibraryClass) => void
}) {
  const [keyword, setKeyword] = useState('')
  const [grade, setGrade] = useState('all')

  const lessonsById = useMemo(
    () => Object.fromEntries(allLessons.map((lesson) => [lesson.id, lesson])) as Record<string, LibraryLesson>,
    [allLessons],
  )
  const gradeOptions = useMemo(
    () =>
      Array.from(new Set(allLessons.flatMap((lesson) => (lesson.grade ? [lesson.grade] : [])))).sort(
        (a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b),
      ),
    [allLessons],
  )

  const needle = keyword.trim().toLowerCase()
  const hasFilters = needle !== '' || grade !== 'all'
  const matchesGrade = (lesson: LibraryLesson) => grade === 'all' || lesson.grade === grade

  // A class matches on its own name (then all its lessons of the selected
  // grade show) or through any lesson that matches the keyword and grade.
  const visibleClasses = classes.flatMap((classroom) => {
    const lessons = classroom.lessonIds.map((id) => lessonsById[id]).filter(Boolean)
    const nameMatches = needle !== '' && classDisplayName(classroom).toLowerCase().includes(needle)
    const visibleLessons = lessons.filter(
      (lesson) => matchesGrade(lesson) && (nameMatches || matchesLibraryKeyword(lesson, keyword)),
    )
    const visible = !hasFilters || visibleLessons.length > 0 || (nameMatches && grade === 'all')
    return visible ? [{ classroom, lessons, visibleLessons }] : []
  })

  const assignedLessonIds = new Set(classes.flatMap((classroom) => classroom.lessonIds))
  const unassignedLessons = allLessons.filter((lesson) => !assignedLessonIds.has(lesson.id))
  const visibleUnassigned = unassignedLessons.filter(
    (lesson) => matchesGrade(lesson) && matchesLibraryKeyword(lesson, keyword),
  )

  const clearFilters = () => {
    setKeyword('')
    setGrade('all')
  }

  const toggleClass = (classId: string) => {
    setView((prev) => {
      const isExpanded = prev.expandedClassIds.includes(classId)
      return {
        expandedClassIds: isExpanded
          ? prev.expandedClassIds.filter((id) => id !== classId)
          : [...prev.expandedClassIds, classId],
        openLessonKey: isExpanded && prev.openLessonKey?.startsWith(`${classId}:`) ? null : prev.openLessonKey,
      }
    })
  }

  const toggleLesson = (lessonKey: string) => {
    setView((prev) => ({ ...prev, openLessonKey: prev.openLessonKey === lessonKey ? null : lessonKey }))
  }

  return (
    <section className="library-page">
      <div className="library-filters">
        <label className="library-keyword">
          <span>Keyword</span>
          <input
            type="search"
            placeholder="Search by class, title, or topic..."
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <label className="library-grade">
          <span>Grade</span>
          <select value={grade} onChange={(event) => setGrade(event.target.value)}>
            <option value="all">All Grades</option>
            {gradeOptions.map((option) => (
              <option key={option} value={option}>
                {formatLessonGrade(option)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="secondary-button" onClick={clearFilters} disabled={!hasFilters}>
          Clear Filters
        </button>
      </div>

      <p className="library-count" aria-live="polite">
        {pluralize(visibleClasses.length, 'class', 'classes')} · {pluralize(visibleUnassigned.length, 'unassigned lesson')}
        {hasFilters ? ' matching your filters' : ''}
      </p>

      {visibleClasses.length === 0 && visibleUnassigned.length === 0 ? (
        <div className="library-empty">
          <h3>No classes or lessons match your filters</h3>
          <p>Try a different keyword or grade, or clear the filters to see everything.</p>
          <button type="button" className="secondary-button" onClick={clearFilters}>
            Clear Filters
          </button>
        </div>
      ) : (
        <>
          {visibleClasses.length > 0 && (
            <ul className="library-grid library-grid--classes" aria-label="Classes">
              {visibleClasses.map(({ classroom, lessons, visibleLessons }) => (
                <li key={classroom.id}>
                  <LibraryClassCard
                    classroom={classroom}
                    lessonCount={lessons.length}
                    visibleLessons={visibleLessons}
                    isFiltered={hasFilters}
                    isExpanded={view.expandedClassIds.includes(classroom.id)}
                    openLessonKey={view.openLessonKey}
                    onToggle={() => toggleClass(classroom.id)}
                    onToggleLesson={toggleLesson}
                    onAddLesson={() => onAddLesson(classroom)}
                    nav={nav}
                  />
                </li>
              ))}
            </ul>
          )}

          {visibleUnassigned.length > 0 && (
            <section className="library-unassigned" aria-labelledby="library-unassigned-heading">
              <h3 id="library-unassigned-heading">Unassigned Lessons</h3>
              <p>Lessons that aren’t assigned to a class yet. Assign one from a class card’s lesson list.</p>
              <ul className="library-grid">
                {visibleUnassigned.map((lesson) => (
                  <li key={lesson.id}>
                    <LibraryLessonCard lesson={lesson} nav={nav} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </section>
  )
}

function LibraryClassCard({
  classroom,
  lessonCount,
  visibleLessons,
  isFiltered,
  isExpanded,
  openLessonKey,
  onToggle,
  onToggleLesson,
  onAddLesson,
  nav,
}: {
  classroom: LibraryClass
  lessonCount: number
  visibleLessons: readonly LibraryLesson[]
  isFiltered: boolean
  isExpanded: boolean
  openLessonKey: string | null
  onToggle: () => void
  onToggleLesson: (lessonKey: string) => void
  onAddLesson: () => void
  nav: LessonNavHandlers
}) {
  const listId = `library-class-lessons-${classroom.id}`

  return (
    <article className="library-card library-class-card">
      <div className="library-card-banner" style={{ background: classroom.bannerColor }} aria-hidden="true" />
      <div className="library-card-body">
        <h3>{classDisplayName(classroom)}</h3>
        <dl className="library-card-meta">
          <div>
            <dt>Students</dt>
            <dd>{classroom.studentIds.length}</dd>
          </div>
          <div>
            <dt>Lessons</dt>
            <dd>{lessonCount}</dd>
          </div>
        </dl>
      </div>

      <div className="library-card-actions">
        <button
          type="button"
          className="library-action"
          aria-expanded={isExpanded}
          aria-controls={listId}
          onClick={onToggle}
        >
          <span>{isExpanded ? 'Hide Lessons' : 'View Lessons'}</span>
          <span aria-hidden="true">{isExpanded ? '▴' : '▾'}</span>
        </button>

        {isExpanded && (
          <div className="library-class-lessons" id={listId}>
            {lessonCount === 0 ? (
              <p className="library-class-note">No lessons assigned yet.</p>
            ) : (
              <>
                {isFiltered && visibleLessons.length < lessonCount && (
                  <p className="library-class-note">
                    Showing {visibleLessons.length} of {lessonCount} lessons that match your filters.
                  </p>
                )}
                <ul>
                  {visibleLessons.map((lesson) => {
                    const lessonKey = `${classroom.id}:${lesson.id}`
                    const isOpen = openLessonKey === lessonKey
                    return (
                      <li key={lesson.id} className={`library-class-lesson${isOpen ? ' open' : ''}`}>
                        <button
                          type="button"
                          className="library-class-lesson-toggle"
                          aria-expanded={isOpen}
                          onClick={() => onToggleLesson(lessonKey)}
                        >
                          <span className="library-context-swatch" style={{ background: lesson.bannerColor }} aria-hidden="true" />
                          <span className="library-class-lesson-text">
                            <strong>{lesson.title}</strong>
                            <small>
                              {formatLessonGrade(lesson.grade)} · {lesson.topic}
                            </small>
                          </span>
                          <span aria-hidden="true">{isOpen ? '▴' : '▾'}</span>
                        </button>
                        {isOpen && <LessonNavActions lesson={lesson} classroom={classroom} nav={nav} />}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}

          </div>
        )}

        {/* Opens Lesson Planning for this class; the lesson the teacher
            generates or uploads there is saved to this class. */}
        <button type="button" className="library-action" onClick={onAddLesson}>
          <span>Add Lesson</span>
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </article>
  )
}

// Unassigned lessons keep the original lesson-card layout.
function LibraryLessonCard({ lesson, nav }: { lesson: LibraryLesson; nav: LessonNavHandlers }) {
  return (
    <article className="library-card">
      <div className="library-card-banner" style={{ background: lesson.bannerColor }} aria-hidden="true" />
      <div className="library-card-body">
        <h3>{lesson.title}</h3>
        <dl className="library-card-meta">
          <div>
            <dt>Grade</dt>
            <dd>{formatLessonGrade(lesson.grade)}</dd>
          </div>
          <div>
            <dt>Topic</dt>
            <dd>{lesson.topic}</dd>
          </div>
        </dl>
      </div>
      <div className="library-card-actions">
        <LessonNavActions lesson={lesson} classroom={null} nav={nav} />
      </div>
    </article>
  )
}

// The three lesson destinations, always in the same order. Unavailable ones
// render disabled; with more than one Student Feedback assignment the button
// opens a small menu listing all of them instead of picking one.
function LessonNavActions({
  lesson,
  classroom,
  nav,
}: {
  lesson: LibraryLesson
  classroom: LibraryClass | null
  nav: LessonNavHandlers
}) {
  const [assignmentMenuOpen, setAssignmentMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const assignments = lesson.studentFeedback

  useEffect(() => {
    if (!assignmentMenuOpen) return
    const handlePointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setAssignmentMenuOpen(false)
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAssignmentMenuOpen(false)
    }
    document.addEventListener('mousedown', handlePointer)
    window.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('keydown', handleKey)
    }
  }, [assignmentMenuOpen])

  const handleStudentFeedback = () => {
    if (assignments.length === 1) nav.onOpenStudentFeedback(lesson, assignments[0], classroom)
    else setAssignmentMenuOpen((open) => !open)
  }

  return (
    <div className="library-lesson-actions">
      <button type="button" className="library-action" onClick={() => nav.onOpenLessonPlan(lesson, classroom)}>
        Lesson Planning
      </button>

      <div className="library-action-menu" ref={menuRef}>
        <button
          type="button"
          className="library-action"
          disabled={assignments.length === 0}
          aria-haspopup={assignments.length > 1 ? 'menu' : undefined}
          aria-expanded={assignments.length > 1 ? assignmentMenuOpen : undefined}
          onClick={handleStudentFeedback}
        >
          <span>Student Feedback</span>
          {assignments.length === 0 && <small>Not available</small>}
          {assignments.length > 1 && <small>{assignments.length} assignments ▾</small>}
        </button>
        {assignmentMenuOpen && (
          <div className="library-assignment-menu" role="menu">
            {assignments.map((assignment) => (
              <button
                key={assignment.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAssignmentMenuOpen(false)
                  nav.onOpenStudentFeedback(lesson, assignment, classroom)
                }}
              >
                {assignment.title}
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className="library-action"
        disabled={!lesson.classFeedback.available}
        onClick={() => nav.onOpenClassFeedback(lesson, classroom)}
      >
        <span>Class Feedback</span>
        {!lesson.classFeedback.available && <small>No analysis yet</small>}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// AI request gateway — student roster data never reaches an AI model
//
// Every AI model call in the app goes through callAiModel. (Today the
// "models" are the local mock*Reply functions; a real API client must be
// passed in the same way, never called directly.) Before the model sees a
// request, the gateway replaces every student identifier it knows — roster
// names and their first-name part, Student IDs, pseudonyms, and the demo
// Class Feedback student names — with neutral placeholders ("Student A"),
// anywhere in the request (nested objects, arrays, free text a teacher or
// student typed). It then re-scans the redacted request and refuses to send
// it if any identifier is still present. The model's reply is mapped back
// to the real names only here, locally, for display.
// ---------------------------------------------------------------------------

type AiPurpose =
  | 'lesson-generation'
  | 'lesson-revision'
  | 'lesson-brainstorm'
  | 'student-feedback'
  | 'class-feedback-analysis'
  | 'class-feedback-summary'
  | 'facilitation-questions'

// The identifiers to keep out of AI requests. Kept in sync with the student
// registry by App (see syncAiRosterGuard); the demo Class Feedback names are
// always included because that page's evidence carries student names.
let aiRosterIdentifiers: string[] = []

const studentIdPattern = /S-\d{4,}/giu

function syncAiRosterGuard(students: readonly Student[]) {
  const identifiers = new Set<string>()
  // Placeholder words are never treated as identifiers, and one-letter
  // names are skipped — they can't be told apart from ordinary text.
  const add = (identifier: string) => {
    if (identifier.length > 1 && !/^(student|id)$/i.test(identifier)) identifiers.add(identifier)
  }
  const addName = (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return
    add(trimmed)
    // The first-name part on its own ("Jordan" for "Jordan P.") identifies
    // the student too; single letters are skipped so ordinary words survive.
    add(trimmed.split(' ')[0].replace(/\.$/, ''))
  }
  for (const student of students) {
    addName(student.name)
    add(student.pseudonym)
  }
  for (const name of assignmentStudentRoster) addName(name)
  aiRosterIdentifiers = [...identifiers].sort((a, b) => b.length - a.length)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rosterIdentifierPattern(): RegExp | null {
  if (aiRosterIdentifiers.length === 0) return null
  const alternatives = aiRosterIdentifiers.map(escapeRegExp).join('|')
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'giu')
}

function mapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapStrings(item, transform)]))
  }
  return value
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, out))
  return out
}

declare global {
  interface Window {
    // Development-only record of exactly what each AI request would send,
    // after redaction — used to verify roster data is excluded.
    __partnersAiRequests?: { purpose: AiPurpose; request: unknown }[]
  }
}

function callAiModel<TInput, TOutput>(purpose: AiPurpose, input: TInput, model: (request: TInput) => TOutput): TOutput {
  const namePattern = rosterIdentifierPattern()
  const placeholderFor = new Map<string, string>()
  const originalFor = new Map<string, string>()
  const placeholder = (original: string, label: string) => {
    const known = placeholderFor.get(original.toLowerCase())
    if (known) return known
    const next = `${label} ${placeholderFor.size < 26 ? String.fromCharCode(65 + placeholderFor.size) : placeholderFor.size + 1}`
    placeholderFor.set(original.toLowerCase(), next)
    originalFor.set(next, original)
    return next
  }
  const redact = (text: string) => {
    let result = text.replace(studentIdPattern, (match) => placeholder(match, 'Student ID'))
    if (namePattern) result = result.replace(namePattern, (match) => placeholder(match, 'Student'))
    return result
  }

  const request = mapStrings(input, redact) as TInput
  const leaked = collectStrings(request).some(
    (text) => new RegExp(studentIdPattern.source, 'iu').test(text) || (namePattern ? new RegExp(namePattern.source, 'iu').test(text) : false),
  )
  if (leaked) throw new Error(`Blocked a ${purpose} AI request that still contained student roster data.`)
  if (import.meta.env.DEV) (window.__partnersAiRequests ??= []).push({ purpose, request })

  const placeholders = [...originalFor.keys()].sort((a, b) => b.length - a.length)
  // Whole placeholders only — "Student E" must not match inside "Student Evidence".
  const restore = (text: string) =>
    placeholders.reduce(
      (result, key) => result.replace(new RegExp(`${escapeRegExp(key)}(?![\\p{L}\\p{N}])`, 'gu'), () => originalFor.get(key) ?? key),
      text,
    )
  return mapStrings(model(request), restore) as TOutput
}

// ---------------------------------------------------------------------------
// Lesson generation
//
// Generate Lesson sends the planning form to the AI model (through the
// callAiModel privacy gateway) with instructions and a JSON response schema.
// The model returns structured content only — the title, the learning
// objectives, one activity per step of the teacher's instructional sequence,
// how each Additional Customization field was used, and suggestions tied to
// specific sections. It never writes headings: buildGeneratedLessonDocument
// lays the lesson out in the Lesson Planning form's own order, and shows the
// fields the teacher entered (grade, topic, standards, practices, driving
// question, duration) exactly as entered. Optional sections appear only when
// the teacher filled them in.
// ---------------------------------------------------------------------------

// Uploaded files aren't read yet. Until they are, a lesson template can't
// shape the lesson's formatting, so its content is never sent to the model.
const lessonDocumentProcessingAvailable = false

type CustomizationField = OptionalContextField | 'lessonTemplate' | 'rubric'

const customizationLabels: Record<CustomizationField, string> = {
  priorInstruction: 'Prior Instruction',
  subsequentInstruction: 'Subsequent Instruction',
  differentiation: 'Differentiation',
  materialsAndEquipment: 'Materials & Equipment',
  lessonTemplate: 'Lesson Template',
  rubric: 'Rubric',
}

// What the model receives: the form's fields, with only the optional ones
// the teacher actually provided.
type LessonGenerationInput = {
  gradeLevel: string
  topic: string
  standards: { code: string; description?: string; teacherEntered: boolean }[]
  sciencePractices: { label: string; description: string }[]
  learningObjectives: string
  drivingQuestion?: string
  instructionalSequence: string
  durationMinutes: number
  additionalCustomization: Partial<Record<OptionalContextField, string>> & {
    lessonTemplate?: { fileName: string; content: string }
    rubric?: { fileName: string }
  }
}

// The model's structured output (see lessonGenerationSchema).
type LessonGenerationOutput = {
  title: string
  learningObjectives: string[]
  activities: {
    sequenceStep: string
    title: string
    minutes: number
    description: string
    practiceMoves: string[]
    objectives: number[]
  }[]
  customization: { field: CustomizationField; howUsed: string }[]
  suggestions: { section: string; flaggedText: string; suggestion: string; addedText: string; summary: string }[]
}

const lessonGenerationInstructions = [
  'You are the PARTNERS lesson-planning assistant for high school science teachers.',
  'Write a lesson from the teacher’s Lesson Planning form, given in "lesson". Return only JSON that matches "responseSchema" — no headings, Markdown, or extra keys.',
  'The app lays the lesson out itself, in this order: Topic, Grade Level, Lesson Duration, Standards, Science Practices to Emphasize, Learning Objectives, Driving Question, Instructional Sequence, Additional Customization.',
  'Grade level, topic, standards, science practices, the driving question, and the duration are shown exactly as the teacher entered them. Do not restate, change, or add to them.',
  'learningObjectives: one entry per objective the teacher wrote, in the same order. Clarify the wording only; never add objectives.',
  'activities: expand each step of the teacher’s instructional sequence into one activity, in the same order. Copy the step into sequenceStep. Do not add, drop, merge, or reorder steps.',
  'minutes: whole numbers that add up exactly to lesson.durationMinutes.',
  'objectives: the learning objectives (1-based, matching learningObjectives) each activity works toward. Every objective must be addressed by at least one activity.',
  'Use every selected science practice in at least one activity, and list the exact phrases naming each practice move in practiceMoves.',
  'If a driving question is provided, pose it in the opening activity. If none is provided, do not write one.',
  'customization: one entry for each Additional Customization field that was provided, saying how the lesson uses it. Weave prior instruction, subsequent instruction, and differentiation into the activities. Never invent content for fields that are missing.',
  'A rubric is for evaluating student work: refer to it in an evaluation activity. A lesson template guides formatting only, and is provided only when its content could be read.',
  'suggestions: up to four improvement ideas. section is "Learning Objective N" or "Activity N" (1-based, matching your arrays). flaggedText is copied exactly from that section’s text; addedText is the sentence to add if the teacher accepts.',
].join('\n')

const lessonGenerationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'learningObjectives', 'activities', 'customization', 'suggestions'],
  properties: {
    title: { type: 'string' },
    learningObjectives: { type: 'array', items: { type: 'string' } },
    activities: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sequenceStep', 'title', 'minutes', 'description', 'practiceMoves', 'objectives'],
        properties: {
          sequenceStep: { type: 'string' },
          title: { type: 'string' },
          minutes: { type: 'integer', minimum: 0 },
          description: { type: 'string' },
          practiceMoves: { type: 'array', items: { type: 'string' } },
          objectives: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
    customization: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['field', 'howUsed'],
        properties: {
          field: { type: 'string', enum: Object.keys(customizationLabels) },
          howUsed: { type: 'string' },
        },
      },
    },
    suggestions: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['section', 'flaggedText', 'suggestion', 'addedText', 'summary'],
        properties: {
          section: { type: 'string' },
          flaggedText: { type: 'string' },
          suggestion: { type: 'string' },
          addedText: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
  },
} as const

// Splits a teacher's list ("Launch, investigate, then explain.") into its
// items, in order.
function splitTeacherList(text: string): string[] {
  return text
    .split(/\r?\n|;|→|->|,|\s+then\s+|\s(?=\d+[.)]\s)/i)
    .map((item) =>
      item
        .trim()
        .replace(/^(?:\d+[.)]|[-•*]|and\b|then\b)\s*/i, '')
        .replace(/\s+and$/i, '')
        .replace(/[.]+$/, '')
        .trim(),
    )
    .filter(Boolean)
}

const ensurePeriod = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

// Splits `total` minutes across activities by weight — in 5-minute blocks
// when the total allows — so the parts always add up to the total exactly.
function allocateMinutes(total: number, weights: readonly number[]): number[] {
  const count = weights.length
  if (count === 0 || total <= 0) return weights.map(() => 0)
  const unit = total % 5 === 0 && total / 5 >= count ? 5 : 1
  const units = Math.floor(total / unit)
  const safeWeights = weights.map((weight) => (weight > 0 ? weight : 1))
  const weightSum = safeWeights.reduce((sum, weight) => sum + weight, 0)
  const exact = safeWeights.map((weight) => Math.max(1, (weight / weightSum) * units))
  const allocated = exact.map(Math.floor)
  let remaining = units - allocated.reduce((sum, value) => sum + value, 0)
  const byRemainder = exact.map((value, index) => ({ index, fraction: value - Math.floor(value) })).sort((a, b) => b.fraction - a.fraction)
  for (let step = 0; remaining > 0; step++, remaining--) allocated[byRemainder[step % count].index]++
  while (remaining < 0) {
    allocated[allocated.indexOf(Math.max(...allocated))]--
    remaining++
  }
  return allocated.map((value) => value * unit)
}

type ActivityKind = 'launch' | 'investigate' | 'model' | 'argue' | 'explain' | 'apply' | 'assess' | 'other'

const activityKinds: { kind: ActivityKind; pattern: RegExp; weight: number }[] = [
  { kind: 'launch', pattern: /launch|engage|hook|introduc|phenomen|open|warm/i, weight: 1 },
  { kind: 'investigate', pattern: /investigat|explor|lab|experiment|data|collect|observ|research/i, weight: 2 },
  { kind: 'model', pattern: /model/i, weight: 2 },
  { kind: 'argue', pattern: /argu|debate|claim|defend/i, weight: 1.5 },
  { kind: 'explain', pattern: /explain|sense|discuss|share|synthes/i, weight: 1.5 },
  { kind: 'apply', pattern: /elaborat|apply|extend|transfer|practice/i, weight: 1.5 },
  { kind: 'assess', pattern: /evaluat|assess|exit|reflect|check|wrap|clos|quiz|summar/i, weight: 1 },
]

// How each practice shows up in an activity, and which kinds of activity
// suit it best.
const practiceMovesById: Record<string, { move: string; sentence: string; prefers: ActivityKind[] }> = {
  'Develop and Use Models': {
    move: 'develop and use a model',
    sentence: 'Students develop and use a model to represent their current thinking, then revise it as they learn more.',
    prefers: ['model', 'investigate', 'explain'],
  },
  'Construct Explanations': {
    move: 'construct an explanation',
    sentence: 'Students construct an explanation that connects a claim to evidence with clear reasoning.',
    prefers: ['explain', 'assess', 'apply'],
  },
  'Engage in Argument from Evidence': {
    move: 'engage in argument from evidence',
    sentence: 'Students engage in argument from evidence, weighing alternative ideas before settling on one.',
    prefers: ['argue', 'explain', 'apply'],
  },
}

// Stands in for the lesson-generation model until a real one is connected:
// builds the structured output the schema asks for from the form alone.
function mockLessonGenerationReply(lesson: LessonGenerationInput): string {
  // Lowercased for use mid-sentence, unless it starts with an acronym.
  const topic = lesson.topic.trim().replace(/^\p{Lu}(?=\p{Ll})/u, (letter) => letter.toLowerCase())
  const custom = lesson.additionalCustomization
  const steps = splitTeacherList(lesson.instructionalSequence)
  const kinds = steps.map((step) => activityKinds.find((item) => item.pattern.test(step)) ?? { kind: 'other' as const, weight: 1.5 })

  const describe = (step: string, kind: ActivityKind, index: number): string => {
    switch (kind) {
      case 'launch':
        return index === 0 && lesson.drivingQuestion
          ? `The teacher introduces a phenomenon about ${topic} and poses the driving question: “${lesson.drivingQuestion}” Students share their initial ideas with a partner.`
          : `The teacher introduces a phenomenon about ${topic}. Students share their initial ideas with a partner.`
      case 'investigate':
        return `In small groups, students investigate questions about ${topic}, gathering observations and data they can use as evidence.`
      case 'model':
        return `Students sketch a model of ${topic} that shows the parts of the system and how they interact.`
      case 'argue':
        return `Groups make a claim about ${topic} and use their evidence to support it.`
      case 'explain':
        return `Students make sense of what they found, discussing how their evidence connects to what they know about ${topic}.`
      case 'apply':
        return `Students apply their ideas about ${topic} to a new example.`
      case 'assess':
        return `Students show what they learned about ${topic} in a short written reflection.`
      default:
        return `Students ${step.charAt(0).toLowerCase()}${step.slice(1)}, focusing on ${topic}.`
    }
  }

  const activities = steps.map((step, index) => ({
    sequenceStep: step,
    title: capitalize(step),
    minutes: 0,
    description: describe(step, kinds[index].kind, index),
    practiceMoves: [] as string[],
    objectives: [] as number[],
  }))
  if (lesson.drivingQuestion && activities.length > 0 && kinds[0].kind !== 'launch') {
    activities[0].description += ` The teacher poses the driving question: “${lesson.drivingQuestion}”`
  }
  allocateMinutes(lesson.durationMinutes, kinds.map((item) => item.weight)).forEach((minutes, index) => {
    activities[index].minutes = minutes
  })

  // Every selected practice goes into the activity that suits it best,
  // spreading them out when several prefer the same one.
  for (const practice of lesson.sciencePractices) {
    if (activities.length === 0) break
    const move = practiceMovesById[practice.label] ?? {
      move: practice.label.toLowerCase(),
      sentence: `Students ${practice.label.charAt(0).toLowerCase()}${practice.label.slice(1)}.`,
      prefers: [],
    }
    const preferred = move.prefers
      .flatMap((kind) => kinds.map((item, index) => (item.kind === kind ? index : -1)).filter((index) => index >= 0))
      .find((index) => activities[index].practiceMoves.length === 0)
    const fallback = activities
      .map((activity, index) => ({ index, used: activity.practiceMoves.length + (kinds[index].kind === 'launch' ? 0.5 : 0) }))
      .sort((a, b) => a.used - b.used)[0].index
    const target = activities[preferred ?? fallback]
    target.description += ` ${move.sentence}`
    target.practiceMoves.push(move.move)
  }

  const customization: LessonGenerationOutput['customization'] = []
  const last = activities.length - 1
  if (activities.length > 0) {
    if (custom.priorInstruction) {
      activities[0].description += ` Students connect today’s work to what they learned before: ${ensurePeriod(custom.priorInstruction)}`
      customization.push({ field: 'priorInstruction', howUsed: 'Used in Activity 1 to connect to what students already know.' })
    }
    if (custom.differentiation) {
      const main = kinds.reduce((best, item, index) => (item.weight > kinds[best].weight ? index : best), 0)
      activities[main].description += ` Supports: ${ensurePeriod(custom.differentiation)}`
      customization.push({ field: 'differentiation', howUsed: `Built into Activity ${main + 1}.` })
    }
    if (custom.rubric) {
      const assessIndex = kinds.findIndex((item) => item.kind === 'assess')
      const target = assessIndex >= 0 ? assessIndex : last
      activities[target].description += ` The teacher evaluates student work with the uploaded rubric (${custom.rubric.fileName}).`
      customization.push({ field: 'rubric', howUsed: `Used to evaluate student work in Activity ${target + 1}.` })
    }
    if (custom.subsequentInstruction) {
      activities[last].description += ` The teacher closes by previewing what comes next: ${ensurePeriod(custom.subsequentInstruction)}`
      customization.push({ field: 'subsequentInstruction', howUsed: `Previewed at the end of Activity ${last + 1}.` })
    }
  }
  if (custom.materialsAndEquipment) {
    customization.push({ field: 'materialsAndEquipment', howUsed: 'Listed for the activities above.' })
  }
  if (custom.lessonTemplate) {
    customization.push({ field: 'lessonTemplate', howUsed: 'Its section order and formatting guide the activities.' })
  }

  const learningObjectives = lesson.learningObjectives
    .split(/\r?\n|;|(?<=\.)\s+/)
    .map((item) => item.trim().replace(/^(?:\d+[.)]|[-•*])\s*/, '').replace(/^students will be able to\s*/i, ''))
    .filter(Boolean)
    .map((item) => ensurePeriod(capitalize(item)))

  // Every objective is worked on in at least one activity: the activities
  // after the opening share them out in order, and a closing check covers
  // them all.
  const working = activities.length > 1 && kinds[0].kind === 'launch' ? activities.slice(1) : activities
  learningObjectives.forEach((_, index) => {
    if (working.length === 0) return
    const target = working[Math.min(working.length - 1, Math.floor((index * working.length) / learningObjectives.length))]
    target.objectives.push(index + 1)
  })
  kinds.forEach((item, index) => {
    if (item.kind === 'assess') activities[index].objectives = learningObjectives.map((_, number) => number + 1)
  })

  const firstSentence = (text: string) => text.split(/(?<=[.!?”])\s+/)[0]
  const suggestions: LessonGenerationOutput['suggestions'] = []
  if (activities.length > 0) {
    const opening = activities[0].description
    const flagged = opening.includes('Students share their initial ideas with a partner.')
      ? 'Students share their initial ideas with a partner.'
      : firstSentence(opening)
    suggestions.push({
      section: 'Activity 1',
      flaggedText: flagged,
      suggestion:
        'Opening with what students notice and wonder gives them ownership of the phenomenon before they start explaining it. Consider adding a quick notice-and-wonder round first.',
      addedText: 'Before sharing, each student records one thing they notice and one thing they wonder.',
      summary: 'opening with a quick notice-and-wonder round before students share their ideas',
    })
  }
  if (activities.length >= 3) {
    const middle = kinds.findIndex((item, index) => index > 0 && index < last && (item.kind === 'investigate' || item.kind === 'model'))
    const index = middle >= 0 ? middle : 1
    suggestions.push({
      section: `Activity ${index + 1}`,
      flaggedText: firstSentence(activities[index].description),
      suggestion:
        'Students may lose track of what they found by the time they explain their thinking. Consider having each group keep a simple evidence log to come back to later in the lesson.',
      addedText: 'Each group keeps an evidence log to revisit later in the lesson.',
      summary: 'having groups keep an evidence log to revisit later in the lesson',
    })
  }
  if (activities.length >= 2) {
    suggestions.push({
      section: `Activity ${last + 1}`,
      flaggedText: firstSentence(activities[last].description),
      suggestion:
        'The lesson ends without a quick check of the learning objectives. Consider closing with a short exit ticket so you can see who is ready to move on.',
      addedText: `End with a two-question exit ticket that checks the learning objective${learningObjectives.length === 1 ? '' : 's'}.`,
      summary: 'ending with a short exit ticket tied to the learning objectives',
    })
  }
  if (learningObjectives.length > 0 && !/evidence/i.test(learningObjectives[0])) {
    suggestions.push({
      section: 'Learning Objective 1',
      flaggedText: learningObjectives[0],
      suggestion: 'This objective doesn’t say how students will show their understanding. Consider naming the evidence they’ll use.',
      addedText: 'Students support their thinking with evidence from the lesson.',
      summary: 'naming how students will show their understanding with evidence',
    })
  }

  const output: LessonGenerationOutput = {
    title: `${lesson.topic.trim().replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())}${lesson.sciencePractices[0] ? `: ${lesson.sciencePractices[0].label}` : ''}`,
    learningObjectives,
    activities,
    customization,
    suggestions,
  }
  return JSON.stringify(output)
}

// Reads the model's JSON, keeping only well-formed entries — anything
// malformed is dropped rather than shown.
function readLessonGenerationOutput(raw: string): LessonGenerationOutput {
  let data: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') data = parsed as Record<string, unknown>
  } catch {
    // Treated as an empty response below.
  }
  const list = (value: unknown) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []) as Record<string, unknown>[]
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  return {
    title: text(data.title),
    learningObjectives: (Array.isArray(data.learningObjectives) ? data.learningObjectives : []).map(text).filter(Boolean),
    activities: list(data.activities)
      .map((item) => ({
        sequenceStep: text(item.sequenceStep),
        title: text(item.title),
        minutes: typeof item.minutes === 'number' && item.minutes >= 0 ? Math.round(item.minutes) : 0,
        description: text(item.description),
        practiceMoves: (Array.isArray(item.practiceMoves) ? item.practiceMoves : []).map(text).filter(Boolean),
        objectives: (Array.isArray(item.objectives) ? item.objectives : []).filter((value): value is number => Number.isInteger(value)),
      }))
      .filter((item) => item.description),
    customization: list(data.customization)
      .map((item) => ({ field: text(item.field) as CustomizationField, howUsed: text(item.howUsed) }))
      .filter((item) => item.field in customizationLabels),
    suggestions: list(data.suggestions)
      .map((item) => ({
        section: text(item.section),
        flaggedText: text(item.flaggedText),
        suggestion: text(item.suggestion),
        addedText: text(item.addedText),
        summary: text(item.summary),
      }))
      .filter((item) => item.section && item.suggestion && item.addedText),
  }
}

// Splits a section's text into segments: phrases naming a science practice
// move are bold, and `flaggedText` (what a suggestion points at) is flagged.
function buildSegments(text: string, boldPhrases: readonly string[], flaggedText?: string): LessonSegment[] {
  const lower = text.toLowerCase()
  const boldRanges = boldPhrases
    .map((phrase) => ({ start: phrase ? lower.indexOf(phrase.toLowerCase()) : -1, length: phrase.length }))
    .filter((range) => range.start >= 0)
    .map((range) => ({ start: range.start, end: range.start + range.length }))
  const flagStart = flaggedText ? text.indexOf(flaggedText) : -1
  const flagRange = flagStart >= 0 && flaggedText ? { start: flagStart, end: flagStart + flaggedText.length } : null
  const points = new Set([0, text.length])
  for (const range of [...boldRanges, ...(flagRange ? [flagRange] : [])]) {
    points.add(range.start)
    points.add(range.end)
  }
  const sorted = [...points].sort((a, b) => a - b)
  const segments: LessonSegment[] = []
  for (let index = 0; index < sorted.length - 1; index++) {
    const [start, end] = [sorted[index], sorted[index + 1]]
    if (start === end) continue
    const segment: LessonSegment = { text: text.slice(start, end) }
    if (boldRanges.some((range) => range.start <= start && end <= range.end)) segment.bold = true
    if (flagRange && flagRange.start <= start && end <= flagRange.end) segment.flagged = true
    segments.push(segment)
  }
  return segments
}

// The form has no Driving Question field, so a driving question is only
// one the teacher labeled in Learning Objectives or Instructional Sequence
// ("Driving question: Why ...?"). It's taken out of that text so it isn't
// treated as an objective or an activity, and nothing is inferred otherwise.
function extractDrivingQuestion(
  learningObjectives: string,
  instructionalSequence: string,
): { drivingQuestion: string; learningObjectives: string; instructionalSequence: string } {
  const pattern = /driving question\s*[:\-–—]\s*([^\n]*?\?)/i
  let drivingQuestion = ''
  const strip = (text: string) => {
    const match = pattern.exec(text)
    if (!match) return text
    if (!drivingQuestion) drivingQuestion = match[1].trim().replace(/^["“]|["”]$/g, '')
    return (text.slice(0, match.index) + text.slice(match.index + match[0].length)).replace(/^[\s,;.]+|[\s,;]+$/g, '').replace(/\n{2,}/g, '\n')
  }
  return {
    learningObjectives: strip(learningObjectives),
    instructionalSequence: strip(instructionalSequence),
    drivingQuestion,
  }
}

function buildLessonGenerationInput(details: PlanningLessonDetails): LessonGenerationInput {
  const { optionalContext, uploads } = details
  return {
    gradeLevel: formatLessonGrade(details.gradeLevel),
    topic: details.topic.trim(),
    standards: details.standards.map((standard) => ({
      code: standard.code,
      description: standard.custom ? undefined : scienceStandardsBank.find((item) => item.code === standard.code)?.description,
      teacherEntered: standard.custom,
    })),
    sciencePractices: practiceOptions
      .filter((practice) => details.sciencePractices.includes(practice.id))
      .map(({ label, description }) => ({ label, description })),
    learningObjectives: details.learningObjectives.trim(),
    ...(details.drivingQuestion.trim() ? { drivingQuestion: details.drivingQuestion.trim() } : {}),
    instructionalSequence: details.instructionalSequence.trim(),
    durationMinutes: details.durationMinutes ?? 0,
    additionalCustomization: {
      ...optionalContext,
      // A template's content can only be sent once files can be read.
      ...(uploads.lessonTemplateName && lessonDocumentProcessingAvailable
        ? { lessonTemplate: { fileName: uploads.lessonTemplateName, content: '' } }
        : {}),
      ...(uploads.rubricName ? { rubric: { fileName: uploads.rubricName } } : {}),
    },
  }
}

// Lays out a generated lesson in the Lesson Planning form's order. The
// teacher's own entries come straight from the form; the model's output
// fills in objectives, activities, and customization notes. If the model
// returned nothing usable for a part, the teacher's own text is shown.
function buildGeneratedLessonDocument(details: PlanningLessonDetails, output: LessonGenerationOutput): LessonDocument {
  const steps: LessonStep[] = []
  const totalMinutes = details.durationMinutes ?? 0

  const objectives = output.learningObjectives.length > 0 ? output.learningObjectives : [ensurePeriod(details.learningObjectives)]
  const activities =
    output.activities.length > 0
      ? output.activities
      : splitTeacherList(details.instructionalSequence).map((step) => ({
          sequenceStep: step,
          title: capitalize(step),
          minutes: 0,
          description: ensurePeriod(capitalize(step)),
          practiceMoves: [],
          objectives: [],
        }))
  // Activity time always adds up to the selected Lesson Duration.
  const minutesSum = activities.reduce((sum, activity) => sum + activity.minutes, 0)
  const minutes =
    minutesSum === totalMinutes ? activities.map((activity) => activity.minutes) : allocateMinutes(totalMinutes, activities.map((activity) => activity.minutes))
  const boldPhrasesFor = (label: string) => {
    const index = Number(label.replace('Activity ', '')) - 1
    return activities[index]?.practiceMoves ?? []
  }

  // Lesson Overview: Topic, Grade Level, and Lesson Duration together.
  steps.push({ label: 'Topic', segments: [{ text: details.topic.trim() }] })
  steps.push({ label: 'Grade Level', segments: [{ text: formatLessonGrade(details.gradeLevel) }] })
  steps.push({
    label: 'Lesson Duration',
    segments: [
      {
        text:
          activities.length > 0
            ? `${totalMinutes} minutes (${minutes.join(' + ')} min across ${pluralize(activities.length, 'activity', 'activities')})`
            : `${totalMinutes} minutes`,
      },
    ],
  })
  steps.push({
    label: 'Standards',
    sectionHeading: 'Standards',
    displayPrefix: '',
    listStyle: 'bullet',
    afterSection: 'practices',
    segments: details.standards.map((standard) => {
      const description = standard.custom ? undefined : scienceStandardsBank.find((item) => item.code === standard.code)?.description
      return { text: description ? `${standard.code} — ${description}` : standard.custom ? `${standard.code} (entered by you)` : standard.code }
    }),
  })

  objectives.forEach((objective, index) => {
    steps.push({
      label: `Learning Objective ${index + 1}`,
      displayPrefix: `${index + 1}.`,
      ...(index === 0 ? { sectionHeading: 'Learning Objectives', leadIn: 'By the end of the lesson, students will be able to:' } : {}),
      segments: [{ text: objective }],
    })
  })

  const drivingQuestion = details.drivingQuestion.trim()
  if (drivingQuestion) {
    steps.push({ label: 'Driving Question', sectionHeading: 'Driving Question', displayPrefix: '', segments: [{ text: drivingQuestion }] })
  }

  activities.forEach((activity, index) => {
    steps.push({
      label: `Activity ${index + 1}`,
      displayPrefix: `${index + 1}. ${activity.title || capitalize(activity.sequenceStep)}:`,
      duration: minutes[index],
      objectives: activity.objectives.filter((number) => number >= 1 && number <= objectives.length),
      ...(index === 0 ? { sectionHeading: 'Instructional Sequence' } : {}),
      segments: buildSegments(activity.description, activity.practiceMoves),
    })
  })

  // Additional Customization: only what the teacher provided, in form order.
  const howUsed = (field: CustomizationField) => output.customization.find((item) => item.field === field)?.howUsed
  const customizationSteps: LessonStep[] = []
  for (const field of ['priorInstruction', 'subsequentInstruction', 'differentiation'] as const) {
    const value = details.optionalContext[field]
    if (!value) continue
    const note = howUsed(field)
    customizationSteps.push({ label: customizationLabels[field], segments: [{ text: `${ensurePeriod(value)}${note ? ` ${note}` : ''}` }] })
  }
  if (details.optionalContext.materialsAndEquipment) {
    customizationSteps.push({
      label: customizationLabels.materialsAndEquipment,
      listStyle: 'bullet',
      segments: splitTeacherList(details.optionalContext.materialsAndEquipment).map((item) => ({ text: capitalize(item) })),
    })
  }
  if (details.uploads.lessonTemplateName) {
    const note = lessonDocumentProcessingAvailable ? howUsed('lessonTemplate') : undefined
    customizationSteps.push({
      label: customizationLabels.lessonTemplate,
      segments: [
        {
          text: note
            ? `${details.uploads.lessonTemplateName} — ${note}`
            : `${details.uploads.lessonTemplateName} — attached, but not applied: templates can only guide the lesson’s formatting once uploaded files can be read.`,
        },
      ],
    })
  }
  if (details.uploads.rubricName) {
    const note = howUsed('rubric')
    customizationSteps.push({ label: customizationLabels.rubric, segments: [{ text: `${details.uploads.rubricName}${note ? ` — ${note}` : ''}` }] })
  }
  if (customizationSteps.length > 0) customizationSteps[0] = { ...customizationSteps[0], sectionHeading: 'Additional Customization' }
  steps.push(...customizationSteps)

  // Suggestions stay attached to the section they're about: its flagged
  // phrase is highlighted, and the proposed revision adds the suggested
  // sentence to that section's text.
  const suggestions: Record<string, string> = {}
  const suggestionSummaries: Record<string, string> = {}
  const revisionSegments: Record<string, readonly LessonSegment[]> = {}
  for (const item of output.suggestions) {
    const index = steps.findIndex((step) => step.label === item.section && step.listStyle !== 'bullet')
    if (index < 0 || suggestions[item.section]) continue
    const step = steps[index]
    const text = segmentsToText(step.segments)
    const bold = item.section.startsWith('Activity ') ? boldPhrasesFor(item.section) : []
    const flagged = item.flaggedText && text.includes(item.flaggedText) ? item.flaggedText : text
    steps[index] = { ...step, segments: buildSegments(text, bold, flagged) }
    suggestions[item.section] = item.suggestion
    suggestionSummaries[item.section] = item.summary || item.suggestion
    revisionSegments[item.section] = [...buildSegments(text, bold), { text: ` ${ensurePeriod(item.addedText)}`, added: true }]
  }

  return {
    id: `lesson-${Date.now().toString(36)}`,
    title: output.title || details.topic.trim() || 'Untitled Lesson',
    steps,
    practices: practiceOptions.filter((practice) => details.sciencePractices.includes(practice.id)).map((practice) => practice.label),
    suggestions,
    suggestionSummaries,
    revisionSegments,
    workflows: {},
  }
}

function generateLessonDocument(details: PlanningLessonDetails): LessonDocument {
  const raw = callAiModel(
    'lesson-generation',
    { instructions: lessonGenerationInstructions, responseSchema: lessonGenerationSchema, lesson: buildLessonGenerationInput(details) },
    (request) => mockLessonGenerationReply(request.lesson),
  )
  return buildGeneratedLessonDocument(details, readLessonGenerationOutput(raw))
}

// ---------------------------------------------------------------------------
// Class Setup
//
// Classes (name, grade level, optional period/section) and their student
// rosters, shared with the Library. Rosters hold first names or initials
// only. Students live in one registry: each new student gets a PARTNERS
// Student ID and a pseudonym, and an existing ID is reused only when the
// upload reliably identifies the student — by that Student ID. A matching
// first name is never linked automatically; at most it's offered for the
// teacher to confirm. All of this is frontend state until there's a backend.
// ---------------------------------------------------------------------------

// High school grades only.
const classGradeOptions = ['9', '10', '11', '12']

function formatClassGrade(gradeLevel: string): string {
  if (!gradeLevel) return '—'
  return gradeLevel === 'K' ? 'Kindergarten' : `Grade ${gradeLevel}`
}

function normalizeStudentId(raw: string): string | null {
  const match = /^s?-?\s*(\d{1,})$/i.exec(raw.trim())
  return match ? formatStudentId(Number(match[1])) : null
}

// Why a roster name can't be stored, or null if it's a first name or
// initials (optionally followed by one initial, e.g. "Jordan P.").
function rosterNameProblem(name: string): string | null {
  if (name.includes('@')) return 'Looks like an email address — use a first name or initials only.'
  if (/\d/.test(name)) return 'Contains numbers — use a first name or initials only.'
  if (!/^[\p{L}\s.'’-]+$/u.test(name)) return 'Contains characters that aren’t part of a first name or initials.'
  if (name.length > 30) return 'Too long — use a first name or initials only.'
  const words = name.split(' ')
  const isInitial = (word: string) => /^\p{L}\.?$/u.test(word)
  const isFirstOrInitials = (word: string) => /^\p{L}[\p{L}'’-]*$/u.test(word) || /^(\p{L}\.?){1,3}$/u.test(word)
  if (words.length === 1 && isFirstOrInitials(words[0])) return null
  if (words.length === 2 && isFirstOrInitials(words[0]) && isInitial(words[1])) return null
  return 'Looks like it includes a last name — use the first name or initials only.'
}

function normalizeStudentName(name: string): string {
  return name.toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim()
}

// Minimal CSV reader: quoted fields, escaped quotes, commas/newlines inside
// quotes, CRLF or LF line endings, and a leading BOM.
function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

// Reads the files we need out of a .xlsx (a ZIP archive) using the browser's
// built-in DecompressionStream, so the prototype needs no spreadsheet
// dependency.
async function readZipTextEntries(buffer: ArrayBuffer, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  const decoder = new TextDecoder()
  let endOfDirectory = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      endOfDirectory = i
      break
    }
  }
  if (endOfDirectory < 0) throw new Error('This file isn’t a valid .xlsx workbook.')

  const entryCount = view.getUint16(endOfDirectory + 10, true)
  let offset = view.getUint32(endOfDirectory + 16, true)
  const entries = new Map<string, string>()
  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('This file isn’t a valid .xlsx workbook.')
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength
    if (!wanted(name)) continue

    const dataStart =
      localHeaderOffset + 30 + view.getUint16(localHeaderOffset + 26, true) + view.getUint16(localHeaderOffset + 28, true)
    const data = bytes.slice(dataStart, dataStart + compressedSize)
    let content: Uint8Array
    if (method === 0) {
      content = data
    } else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      content = new Uint8Array(await new Response(stream).arrayBuffer())
    } else {
      throw new Error('This workbook uses an unsupported compression format.')
    }
    entries.set(name, decoder.decode(content))
  }
  return entries
}

function spreadsheetColumnIndex(cellRef: string): number {
  const letters = /^[A-Z]+/.exec(cellRef)?.[0] ?? 'A'
  return [...letters].reduce((index, letter) => index * 26 + (letter.charCodeAt(0) - 64), 0) - 1
}

// First worksheet of a .xlsx as rows of cell text.
async function readXlsxRows(buffer: ArrayBuffer): Promise<string[][]> {
  const isSheet = (name: string) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
  const entries = await readZipTextEntries(buffer, (name) => name === 'xl/sharedStrings.xml' || isSheet(name))
  const sheetName = [...entries.keys()]
    .filter(isSheet)
    .sort((a, b) => Number(/\d+/.exec(a)?.[0]) - Number(/\d+/.exec(b)?.[0]))[0]
  if (!sheetName) throw new Error('No worksheet was found in this workbook.')

  const parser = new DOMParser()
  const textOf = (element: Element) =>
    Array.from(element.getElementsByTagName('t'))
      .map((t) => t.textContent ?? '')
      .join('')
  const sharedXml = entries.get('xl/sharedStrings.xml')
  const sharedStrings = sharedXml
    ? Array.from(parser.parseFromString(sharedXml, 'application/xml').getElementsByTagName('si')).map(textOf)
    : []

  const sheet = parser.parseFromString(entries.get(sheetName) ?? '', 'application/xml')
  const rows = Array.from(sheet.getElementsByTagName('row')).map((rowElement) => {
    const cells: string[] = []
    for (const cell of Array.from(rowElement.getElementsByTagName('c'))) {
      const type = cell.getAttribute('t')
      const value = cell.getElementsByTagName('v')[0]?.textContent ?? ''
      const text = type === 's' ? (sharedStrings[Number(value)] ?? '') : type === 'inlineStr' ? textOf(cell) : value
      cells[spreadsheetColumnIndex(cell.getAttribute('r') ?? 'A')] = text
    }
    return Array.from(cells, (cell) => cell ?? '')
  })
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''))
}

async function readRosterFile(file: File): Promise<string[][]> {
  const extension = file.name.toLowerCase().split('.').pop()
  if (extension === 'csv' || extension === 'txt') return parseCsv(await file.text())
  if (extension === 'xlsx') return readXlsxRows(await file.arrayBuffer())
  if (extension === 'xls') throw new Error('Older .xls workbooks aren’t supported — save the file as .xlsx or .csv and upload it again.')
  throw new Error('Upload a .csv or .xlsx file.')
}

// One student row from an upload or the Add Student form. Only these two
// fields are ever read out of a roster file.
type RosterUploadRow = { name: string; studentId: string | null }

const rosterNameHeader = /^(student\s*)?(first\s*name|first|name|initials?)(\s*(or|\/)\s*initials?)?$/
const rosterIdHeader = /^(partners\s*)?(student\s*)?id$/

// Maps spreadsheet rows to students, importing only a First Name / Initials
// column and an optional Student ID column. Every other column (last names,
// emails, birthdays…) is dropped here and never enters app state; its
// header is returned so the teacher can be told it was ignored.
function rosterRowsFromTable(table: string[][]): { rows: RosterUploadRow[]; ignoredColumns: string[] } {
  if (table.length === 0) return { rows: [], ignoredColumns: [] }
  const header = table[0].map((cell) => cell.trim().toLowerCase())
  let nameColumn = header.findIndex((cell) => rosterNameHeader.test(cell))
  const idColumn = header.findIndex((cell) => rosterIdHeader.test(cell))
  const hasHeader = nameColumn >= 0 || idColumn >= 0
  let ignoredColumns: string[]
  if (hasHeader) {
    if (nameColumn < 0) throw new Error('Couldn’t find a “First Name or Initials” column in this file.')
    ignoredColumns = table[0].filter((cell, index) => index !== nameColumn && index !== idColumn && cell.trim() !== '')
  } else {
    // No recognizable header: only the first column is read.
    nameColumn = 0
    const extraColumns = Math.max(...table.map((cells) => cells.length)) - 1
    ignoredColumns = extraColumns > 0 ? [`${pluralize(extraColumns, 'unlabeled column')} after the first`] : []
  }

  const rows = (hasHeader ? table.slice(1) : table)
    .map((cells) => ({
      name: (cells[nameColumn] ?? '').trim().replace(/\s+/g, ' '),
      studentId: idColumn >= 0 ? (cells[idColumn] ?? '').trim() || null : null,
    }))
    .filter((row) => row.name !== '' || row.studentId)
  return { rows, ignoredColumns }
}

// A row waiting for the teacher's review before it joins the roster.
// `existing` is set only when the row's Student ID matched a registered
// student; `linkTo` is a link the teacher chose by hand.
type RosterReviewRow = {
  key: string
  name: string
  studentId: string | null
  existing: Student | null
  unknownId: boolean
  linkTo: string | null
}

// Two cards: Class Management (Add Class, then a collapsible Edit Existing
// Class) and Student Roster Management (class picker, privacy notice and
// upload, then a collapsible Check & Edit Student Roster). Both collapsible
// parts start collapsed.
function ClassSetupPage({
  classes,
  setClasses,
  students,
  setStudents,
  ownerEmail,
  startCreating,
  onboarding,
  selectedClassId,
  onSelectClass,
  onContinueToPlanning,
  onViewInLibrary,
}: {
  classes: readonly LibraryClass[]
  setClasses: Dispatch<SetStateAction<LibraryClass[]>>
  students: readonly Student[]
  setStudents: Dispatch<SetStateAction<Student[]>>
  ownerEmail: string
  startCreating: boolean
  onboarding: boolean
  // The app-wide selected class (see App); falls back to the first class.
  selectedClassId: string | null
  onSelectClass: (classId: string) => void
  onContinueToPlanning: (classroom: LibraryClass) => void
  onViewInLibrary: (classId: string) => void
}) {
  const [editClassId, setEditClassId] = useState<string | null>(classes[0]?.id ?? null)
  const [isEditOpen, setIsEditOpen] = useState(false)
  const [isRosterOpen, setIsRosterOpen] = useState(false)
  const [createdClassId, setCreatedClassId] = useState<string | null>(null)
  const [updatedClassId, setUpdatedClassId] = useState<string | null>(null)
  // Bumped after each create (and on Edit's Cancel) to reset that form.
  const [addFormKey, setAddFormKey] = useState(0)
  const [editFormKey, setEditFormKey] = useState(0)

  const studentsById = useMemo(
    () => Object.fromEntries(students.map((student) => [student.id, student])) as Record<string, Student>,
    [students],
  )
  const findClass = (id: string | null) => classes.find((classroom) => classroom.id === id) ?? null
  const rosterClass = findClass(selectedClassId) ?? classes[0] ?? null
  const editClass = findClass(editClassId) ?? classes[0] ?? null
  const createdClass = findClass(createdClassId)
  const updatedClass = findClass(updatedClassId)

  const createClass = (values: ClassFormValues) => {
    const id = `class-${Date.now()}`
    setClasses((prev) => [
      ...prev,
      {
        id,
        ...values,
        ownerEmail,
        bannerColor: classBannerColors[prev.length % classBannerColors.length],
        studentIds: [],
        lessonIds: [],
      },
    ])
    // The new class becomes the selected one, ready for its roster.
    onSelectClass(id)
    setCreatedClassId(id)
    setAddFormKey((key) => key + 1)
  }

  const updateClass = (values: ClassFormValues) => {
    if (!editClass) return
    setClasses((prev) => prev.map((classroom) => (classroom.id === editClass.id ? { ...classroom, ...values } : classroom)))
    setUpdatedClassId(editClass.id)
  }

  const hasClass = classes.length > 0
  const hasRoster = (rosterClass?.studentIds.length ?? 0) > 0

  return (
    <div className="class-setup">
      {onboarding && (
        <section className="setup-section onboarding-panel" aria-labelledby="onboarding-heading">
          <div className="onboarding-header">
            <div>
              <p className="card-label">Welcome to PARTNERS</p>
              <h3 id="onboarding-heading">Set up your first class before planning lessons</h3>
            </div>
          </div>
          <ol className="onboarding-steps">
            <li className={hasClass ? 'done' : 'current'}>
              <span className="onboarding-step-marker" aria-hidden="true">{hasClass ? '✓' : '1'}</span>
              <span>Add a class</span>
            </li>
            <li className={hasRoster ? 'done' : hasClass ? 'current' : undefined}>
              <span className="onboarding-step-marker" aria-hidden="true">{hasRoster ? '✓' : '2'}</span>
              <span>Upload the student roster</span>
            </li>
            <li className={hasClass && hasRoster ? 'current' : undefined}>
              <span className="onboarding-step-marker" aria-hidden="true">3</span>
              <span>Plan your first lesson</span>
            </li>
          </ol>
          <p className="library-class-note">
            {!hasClass
              ? 'Start by adding your class below.'
              : !hasRoster
                ? `Next, upload the roster for ${classDisplayName(rosterClass!)}.`
                : `All set — use Continue to Lesson Planning at the bottom of the page. Your first lesson will be saved to ${classDisplayName(rosterClass!)}.`}
          </p>
        </section>
      )}

      <section className="setup-section" aria-labelledby="class-management-heading">
        <h3 className="setup-section-title" id="class-management-heading">
          Class Management
        </h3>

        <div className="setup-subsection" role="group" aria-labelledby="add-class-heading">
          <h4 className="setup-subsection-title" id="add-class-heading">
            Add Class
          </h4>
          <ClassSetupForm
            key={addFormKey}
            submitLabel="Create Class"
            autoFocus={startCreating || (onboarding && !hasClass)}
            onSave={createClass}
          />
          {createdClass && (
            <div className="class-mgmt-notice" role="status">
              <span>
                Created <strong>{classDisplayName(createdClass)}</strong> — it’s in your Library. Upload its roster below.
              </span>
              <button type="button" className="secondary-button" onClick={() => onViewInLibrary(createdClass.id)}>
                View in Library
              </button>
            </div>
          )}
        </div>

        <CollapsibleSubsection
          id="edit-class"
          title="Edit Existing Class"
          summary={pluralize(classes.length, 'class', 'classes')}
          isOpen={isEditOpen}
          onToggle={() => setIsEditOpen((open) => !open)}
        >
          {editClass ? (
            <>
              <div className="setup-picker-row">
                <label className="setup-class-picker">
                  <span>Class</span>
                  <select
                    value={editClass.id}
                    onChange={(event) => {
                      setEditClassId(event.target.value)
                      setUpdatedClassId(null)
                    }}
                  >
                    {classes.map((classroom) => (
                      <option key={classroom.id} value={classroom.id}>
                        {classDisplayName(classroom)}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="library-class-note">
                  {formatClassGrade(editClass.gradeLevel)} · {pluralize(editClass.studentIds.length, 'student')} ·{' '}
                  {pluralize(editClass.lessonIds.length, 'lesson')}
                </p>
              </div>
              <ClassSetupForm
                key={`${editClass.id}-${editFormKey}`}
                initial={editClass}
                submitLabel="Save Changes"
                onSave={updateClass}
                onCancel={() => {
                  setEditFormKey((key) => key + 1)
                  setUpdatedClassId(null)
                }}
              />
              {updatedClass && (
                <div className="class-mgmt-notice" role="status">
                  <span>
                    Saved <strong>{classDisplayName(updatedClass)}</strong>.
                  </span>
                  <button type="button" className="secondary-button" onClick={() => onViewInLibrary(updatedClass.id)}>
                    View in Library
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="library-class-note">No classes yet. Add one above.</p>
          )}
        </CollapsibleSubsection>
      </section>

      <section className="setup-section" aria-labelledby="roster-heading">
        <div className="setup-section-header">
          <h3 className="setup-section-title" id="roster-heading">
            Student Roster Management
          </h3>
          {rosterClass && (
            <label className="setup-class-picker">
              <span>Class</span>
              <select value={rosterClass.id} onChange={(event) => onSelectClass(event.target.value)}>
                {classes.map((classroom) => (
                  <option key={classroom.id} value={classroom.id}>
                    {classDisplayName(classroom)}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <aside className="privacy-notice" aria-labelledby="student-privacy-heading">
          <h4 id="student-privacy-heading">Student Privacy</h4>
          <p>Use only students’ first names or initials. Do not include last names or other identifying information.</p>
          <p>Student roster data will not be sent to AI models.</p>
        </aside>

        {rosterClass ? (
          <RosterUpload
            key={rosterClass.id}
            classroom={rosterClass}
            classes={classes}
            students={students}
            studentsById={studentsById}
            setClasses={setClasses}
            setStudents={setStudents}
          />
        ) : (
          <p className="library-class-note">Add a class above to upload its roster.</p>
        )}

        <CollapsibleSubsection
          id="check-roster"
          title="Check & Edit Student Roster"
          summary={rosterClass ? `${classDisplayName(rosterClass)} · ${pluralize(rosterClass.studentIds.length, 'student')}` : 'No class yet'}
          isOpen={isRosterOpen}
          onToggle={() => setIsRosterOpen((open) => !open)}
        >
          {rosterClass ? (
            <RosterEditor
              key={rosterClass.id}
              classroom={rosterClass}
              classes={classes}
              students={students}
              studentsById={studentsById}
              setClasses={setClasses}
              setStudents={setStudents}
            />
          ) : (
            <p className="library-class-note">Add a class above to see its roster.</p>
          )}
        </CollapsibleSubsection>
      </section>

      <section className="setup-section setup-continue" aria-labelledby="continue-heading">
        <div className="setup-continue-row">
          <div className="setup-continue-text">
            <h3 className="setup-section-title" id="continue-heading">
              Lesson Planning
            </h3>
            <p className="library-class-note">
              {rosterClass
                ? `New lessons will be saved to ${classDisplayName(rosterClass)} and use its roster.`
                : 'Create a class in Class Management above, then continue to plan its lessons.'}
            </p>
          </div>
          {rosterClass && (
            <label className="setup-class-picker">
              <span>Class</span>
              <select value={rosterClass.id} onChange={(event) => onSelectClass(event.target.value)}>
                {classes.map((classroom) => (
                  <option key={classroom.id} value={classroom.id}>
                    {classDisplayName(classroom)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="primary-button"
            // First-time teachers finish the roster step first; returning
            // teachers can continue and add students later.
            disabled={!rosterClass || (onboarding && !hasRoster)}
            onClick={() => rosterClass && onContinueToPlanning(rosterClass)}
          >
            Continue to Lesson Planning
          </button>
        </div>
        {!rosterClass ? (
          <p className="roster-warning" role="status">
            Select or create a class before continuing to Lesson Planning.
          </p>
        ) : (
          !hasRoster && (
            <p className="roster-warning" role="status">
              {classDisplayName(rosterClass)} doesn’t have a student roster yet. Upload one in Student Roster Management above
              {onboarding ? ' before continuing.' : ' — or continue now and add students later.'}
            </p>
          )
        )}
      </section>
    </div>
  )
}

// A collapsible part of a Class Setup card, set off from what's above it
// by a divider; the whole header row is the toggle.
function CollapsibleSubsection({
  id,
  title,
  summary,
  isOpen,
  onToggle,
  children,
}: {
  id: string
  title: string
  summary: string
  isOpen: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="setup-subsection setup-collapsible" role="group" aria-labelledby={`${id}-heading`}>
      <h4 className="setup-subsection-title" id={`${id}-heading`}>
        <button type="button" className="setup-toggle" aria-expanded={isOpen} aria-controls={`${id}-content`} onClick={onToggle}>
          <span className="setup-toggle-title">{title}</span>
          <span className="setup-toggle-summary">{summary}</span>
          <span className="setup-toggle-chevron" aria-hidden="true">
            {isOpen ? '▴' : '▾'}
          </span>
        </button>
      </h4>
      {isOpen && (
        <div className="setup-subsection-body" id={`${id}-content`}>
          {children}
        </div>
      )}
    </div>
  )
}

type ClassFormValues = { name: string; gradeLevel: string; period: string }

function ClassSetupForm({
  initial,
  submitLabel,
  autoFocus = false,
  onSave,
  onCancel,
}: {
  initial?: LibraryClass
  submitLabel: string
  autoFocus?: boolean
  onSave: (values: ClassFormValues) => void
  onCancel?: () => void
}) {
  const [name, setName] = useState(initial?.name ?? '')
  // A class saved with a grade that's no longer offered starts blank, so the
  // teacher picks one of the current options before saving.
  const [gradeLevel, setGradeLevel] = useState(
    initial && classGradeOptions.includes(initial.gradeLevel) ? initial.gradeLevel : '',
  )
  const [period, setPeriod] = useState(initial?.period ?? '')
  const canSave = name.trim() !== '' && gradeLevel !== ''
  const preview = { name: name.trim(), period: period.trim() }
  const isUnchanged =
    initial !== undefined && preview.name === initial.name && gradeLevel === initial.gradeLevel && preview.period === initial.period

  return (
    <form
      className="setup-class-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave) onSave({ name: preview.name, gradeLevel, period: preview.period })
      }}
    >
      <div className="setup-class-fields">
        <label>
          <span>Class Name (required)</span>
          <input type="text" placeholder="Biology" value={name} autoFocus={autoFocus} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          <span>Grade Level (required)</span>
          <select value={gradeLevel} onChange={(event) => setGradeLevel(event.target.value)}>
            <option value="" disabled>
              Select grade
            </option>
            {classGradeOptions.map((option) => (
              <option key={option} value={option}>
                {formatClassGrade(option)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Period / Section (optional)</span>
          <input type="text" placeholder="Period 2" value={period} onChange={(event) => setPeriod(event.target.value)} />
        </label>
        <div className="setup-class-actions">
          {onCancel && (
            <button type="button" className="secondary-button" disabled={isUnchanged} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="primary-button" disabled={!canSave || isUnchanged}>
            {submitLabel}
          </button>
        </div>
      </div>
      {preview.name && <p className="library-class-note">Shows in the Library as “{classDisplayName(preview)}”.</p>}
    </form>
  )
}

function downloadCsv(fileName: string, rows: string[][]) {
  const escape = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)
  const blob = new Blob([rows.map((row) => row.map(escape).join(',')).join('\n') + '\n'], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

type RosterSectionProps = {
  classroom: LibraryClass
  classes: readonly LibraryClass[]
  students: readonly Student[]
  studentsById: Record<string, Student>
  setClasses: Dispatch<SetStateAction<LibraryClass[]>>
  setStudents: Dispatch<SetStateAction<Student[]>>
}

// Registers any new students and adds the given Student IDs to the class
// (skipping ones already in it).
function addStudentsToClass(
  { classroom, setClasses, setStudents }: Pick<RosterSectionProps, 'classroom' | 'setClasses' | 'setStudents'>,
  studentIds: readonly string[],
  created: readonly Student[],
) {
  if (created.length > 0) setStudents((prev) => [...prev, ...created])
  setClasses((prev) =>
    prev.map((other) =>
      other.id === classroom.id
        ? { ...other, studentIds: [...other.studentIds, ...studentIds.filter((id) => !other.studentIds.includes(id))] }
        : other,
    ),
  )
}

function otherClassesFor(classes: readonly LibraryClass[], classroom: LibraryClass, studentId: string) {
  return classes.filter((other) => other.id !== classroom.id && other.studentIds.includes(studentId))
}

// Upload → review → add. Nothing joins the roster until the teacher has
// reviewed it and clicked Add.
function RosterUpload(props: RosterSectionProps) {
  const { classroom, classes, students, studentsById } = props
  const [reviewRows, setReviewRows] = useState<RosterReviewRow[]>([])
  const [uploadName, setUploadName] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [ignoredColumns, setIgnoredColumns] = useState<string[]>([])
  const [isReading, setIsReading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const nextRowKey = useRef(0)

  const roster = classroom.studentIds.map((id) => studentsById[id]).filter(Boolean)
  // Only this teacher's own classes are ever shown or offered as matches.
  const ownStudentIds = new Set(classes.flatMap((other) => other.studentIds))

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setUploadError(null)
    setNotice(null)
    setIgnoredColumns([])
    setIsReading(true)
    try {
      const { rows, ignoredColumns: ignored } = rosterRowsFromTable(await readRosterFile(file))
      if (rows.length === 0) throw new Error('No students were found in this file.')
      const added = rows.map((row): RosterReviewRow => {
        const normalizedId = row.studentId ? normalizeStudentId(row.studentId) : null
        const existing = normalizedId ? (studentsById[normalizedId] ?? null) : null
        nextRowKey.current += 1
        return {
          key: `row-${nextRowKey.current}`,
          name: row.name,
          studentId: normalizedId ?? row.studentId,
          existing,
          unknownId: row.studentId !== null && !existing,
          linkTo: null,
        }
      })
      setReviewRows((prev) => [...prev, ...added])
      setIgnoredColumns(ignored)
      setUploadName(file.name)
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'This file couldn’t be read.')
    } finally {
      setIsReading(false)
    }
  }

  const updateRow = (key: string, changes: Partial<RosterReviewRow>) =>
    setReviewRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...changes } : row)))

  // Everything that depends on the (editable) name is derived here, so a
  // fix in the review table is re-checked immediately.
  const nameCounts = new Map<string, number>()
  for (const row of reviewRows) {
    if (!row.existing) nameCounts.set(normalizeStudentName(row.name), (nameCounts.get(normalizeStudentName(row.name)) ?? 0) + 1)
  }
  const reviewed = reviewRows.map((row) => {
    const resolvedId = row.existing?.id ?? row.linkTo
    // Same first name/initials in the teacher's other classes: offered as a
    // possible link, never applied automatically.
    const possibleMatches = row.existing
      ? []
      : students.filter(
          (student) =>
            ownStudentIds.has(student.id) &&
            !classroom.studentIds.includes(student.id) &&
            normalizeStudentName(student.name) === normalizeStudentName(row.name),
        )
    return {
      row,
      problem: row.existing ? null : rosterNameProblem(row.name),
      alreadyInClass: resolvedId !== null && classroom.studentIds.includes(resolvedId),
      possibleMatches,
      sameNameInClass:
        !row.existing && roster.some((student) => normalizeStudentName(student.name) === normalizeStudentName(row.name)),
      duplicateInUpload: !row.existing && (nameCounts.get(normalizeStudentName(row.name)) ?? 0) > 1,
    }
  })
  const rowsToAdd = reviewed.filter((item) => !item.problem && !item.alreadyInClass)
  const blockedCount = reviewed.filter((item) => item.problem).length

  const clearReview = () => {
    setReviewRows([])
    setUploadName(null)
    setIgnoredColumns([])
  }

  const confirmReview = () => {
    const used = new Set(students.map((student) => student.pseudonym))
    let nextNumber = nextStudentNumber(students)
    const created: Student[] = []
    const idsToAdd: string[] = []
    for (const { row } of rowsToAdd) {
      const reuseId = row.existing?.id ?? row.linkTo
      if (reuseId) {
        idsToAdd.push(reuseId)
        continue
      }
      const student = createStudent(nextNumber, row.name, used)
      nextNumber++
      used.add(student.pseudonym)
      created.push(student)
      idsToAdd.push(student.id)
    }
    addStudentsToClass(props, idsToAdd, created)
    const reused = idsToAdd.length - created.length
    setNotice(
      `Added ${pluralize(idsToAdd.length, 'student')} to ${classDisplayName(classroom)}: ${created.length} new` +
        (reused > 0 ? `, ${reused} kept an existing Student ID.` : '.') +
        ' Open “Check & Edit Student Roster” to review them.',
    )
    // Rows that still need a fix stay in review; everything else is done.
    setReviewRows((prev) => prev.filter((row) => reviewed.some((item) => item.row.key === row.key && item.problem)))
    setUploadName(null)
    setIgnoredColumns([])
  }

  return (
    <div className="roster-manager">
      <div className="upload-card roster-upload-card">
        <div>
          <h4>Upload Student Roster</h4>
          <p className="roster-upload-hint">
            {isReading ? 'Reading file…' : (uploadName ?? 'CSV or Excel (.xlsx) · First names or initials only')}
          </p>
        </div>
        <div className="roster-upload-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              downloadCsv('partners-roster-template.csv', [['Student ID', 'First Name or Initials'], ['', 'Jordan'], ['', 'M.K.']])
            }
          >
            Download Template
          </button>
          <label className="primary-button library-file-button roster-choose-file">
            Choose File
            <input
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                void handleFile(event.target.files?.[0])
                event.target.value = ''
              }}
            />
          </label>
        </div>
      </div>
      {uploadError && (
        <p className="roster-error" role="alert">
          {uploadError}
        </p>
      )}
      {ignoredColumns.length > 0 && (
        <p className="roster-warning" role="status">
          Not imported: {ignoredColumns.join(', ')}. Only first names or initials are kept.
        </p>
      )}
      {notice && (
        <p className="class-mgmt-notice" role="status">
          {notice}
        </p>
      )}

      {reviewRows.length > 0 && (
        <div className="roster-review">
          <div className="roster-section-header">
            <h4>Review before adding ({pluralize(rowsToAdd.length, 'student')} ready)</h4>
          </div>
          <div className="class-mgmt-table-wrap">
            <table className="class-mgmt-table">
              <thead>
                <tr>
                  <th scope="col">First Name or Initials</th>
                  <th scope="col">Student ID</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {reviewed.map(({ row, problem, alreadyInClass, possibleMatches, sameNameInClass, duplicateInUpload }) => (
                  <tr key={row.key} className={problem ? 'blocked' : undefined}>
                    <th scope="row">
                      {row.existing ? (
                        <>
                          {row.existing.name}
                          {normalizeStudentName(row.name) !== normalizeStudentName(row.existing.name) && row.name && (
                            <small className="roster-also-in">Name in file: {row.name} (registered name kept)</small>
                          )}
                        </>
                      ) : (
                        <input
                          type="text"
                          aria-label="First name or initials"
                          aria-invalid={problem ? true : undefined}
                          value={row.name}
                          onChange={(event) => updateRow(row.key, { name: event.target.value, linkTo: null })}
                        />
                      )}
                    </th>
                    <td className="roster-id">{row.existing?.id ?? row.linkTo ?? <em>New ID</em>}</td>
                    <td>
                      {problem ? (
                        <span className="roster-problem">
                          {problem}{' '}
                          {row.name.includes(' ') && (
                            <button
                              type="button"
                              className="ghost-button roster-inline-fix"
                              onClick={() => updateRow(row.key, { name: row.name.split(' ')[0] })}
                            >
                              Use “{row.name.split(' ')[0]}”
                            </button>
                          )}
                        </span>
                      ) : alreadyInClass ? (
                        <span className="roster-status muted">Already in this class — skipped</span>
                      ) : row.existing ? (
                        <span className="roster-status">Existing student — Student ID kept</span>
                      ) : (
                        <div className="roster-status-stack">
                          <span className="roster-status">{row.linkTo ? 'Linked to an existing student' : 'New student'}</span>
                          {row.unknownId && (
                            <small>Student ID “{row.studentId}” isn’t registered, so a new ID will be created.</small>
                          )}
                          {duplicateInUpload && <small>This name appears more than once — add an initial to tell them apart.</small>}
                          {sameNameInClass && <small>A student with this name is already in this class.</small>}
                          {possibleMatches.length > 0 && (
                            <label className="roster-link-select">
                              <span>Same student as someone in your other classes?</span>
                              <select
                                value={row.linkTo ?? ''}
                                onChange={(event) => updateRow(row.key, { linkTo: event.target.value || null })}
                              >
                                <option value="">No — create a new student</option>
                                {possibleMatches.map((student) => (
                                  <option key={student.id} value={student.id}>
                                    Yes — {student.id} ({otherClassesFor(classes, classroom, student.id).map(classDisplayName).join(', ')})
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="ghost-button roster-icon-button"
                        aria-label={`Remove ${row.name || 'row'} from review`}
                        onClick={() => setReviewRows((prev) => prev.filter((other) => other.key !== row.key))}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {blockedCount > 0 && (
            <p className="roster-warning">
              {pluralize(blockedCount, 'row needs', 'rows need')} a fix before {blockedCount === 1 ? 'it' : 'they'} can be added.
            </p>
          )}
          <div className="library-dialog-actions">
            <button type="button" className="secondary-button" onClick={clearReview}>
              Discard
            </button>
            <button type="button" className="primary-button" disabled={rowsToAdd.length === 0} onClick={confirmReview}>
              Add {pluralize(rowsToAdd.length, 'Student')} to Roster
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// The class's current roster: add one student, edit a name, remove a
// student. Teachers only enter a first name or initials; every student
// added here is new and gets an automatically generated Student ID and
// pseudonym. Students are never matched to an existing record by name.
function RosterEditor(props: RosterSectionProps) {
  const { classroom, classes, students, studentsById, setClasses, setStudents } = props
  const [newName, setNewName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const roster = classroom.studentIds.map((id) => studentsById[id]).filter(Boolean)
  const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ')

  const addStudent = () => {
    const name = cleanName(newName)
    setNotice(null)
    const problem = rosterNameProblem(name)
    if (problem) {
      setAddError(problem)
      return
    }
    const used = new Set(students.map((student) => student.pseudonym))
    const student = createStudent(nextStudentNumber(students), name, used)
    const sameName = roster.some((other) => normalizeStudentName(other.name) === normalizeStudentName(name))
    addStudentsToClass(props, [student.id], [student])
    setNotice(
      `Added ${name} as ${student.id} (${student.pseudonym}).` +
        (sameName ? ' Another student in this class has the same name — consider adding an initial.' : ''),
    )
    setAddError(null)
    setNewName('')
  }

  const editProblem = editing ? rosterNameProblem(cleanName(editing.name)) : null
  const saveName = () => {
    if (!editing) return
    const name = cleanName(editing.name)
    if (rosterNameProblem(name)) return
    setStudents((prev) => prev.map((student) => (student.id === editing.id ? { ...student, name } : student)))
    setEditing(null)
  }

  const removeFromClass = (student: Student) => {
    setClasses((prev) =>
      prev.map((other) =>
        other.id === classroom.id ? { ...other, studentIds: other.studentIds.filter((id) => id !== student.id) } : other,
      ),
    )
    setNotice(`Removed ${student.name} from ${classDisplayName(classroom)}. Their Student ID is kept for other classes.`)
  }

  return (
    <div className="roster-manager">
      <div className="roster-current-header">
        <p className="library-class-note">
          This roster is reused for every lesson in {classDisplayName(classroom)}. Name changes apply everywhere the student
          appears.
        </p>
        {roster.length > 0 && (
          <button
            type="button"
            className="secondary-button"
            onClick={() =>
              downloadCsv(`${classDisplayName(classroom).replace(/[^\w-]+/g, '-')}-roster.csv`, [
                ['Student ID', 'First Name or Initials'],
                ...roster.map((student) => [student.id, student.name]),
              ])
            }
          >
            Download Roster
          </button>
        )}
      </div>

      {notice && (
        <p className="class-mgmt-notice" role="status">
          {notice}
        </p>
      )}

      {roster.length === 0 ? (
        <p className="library-class-note">No students yet. Upload a roster above or add a student below.</p>
      ) : (
        <div className="class-mgmt-table-wrap">
          <table className="class-mgmt-table">
            <thead>
              <tr>
                <th scope="col">Student ID</th>
                <th scope="col">Student Name</th>
                <th scope="col">Pseudonym</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roster.map((student) => {
                const otherClasses = otherClassesFor(classes, classroom, student.id)
                const isEditing = editing?.id === student.id
                return (
                  <tr key={student.id}>
                    <td className="roster-id">{student.id}</td>
                    <th scope="row">
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            aria-label={`Name for ${student.id}`}
                            aria-invalid={editProblem ? true : undefined}
                            value={editing.name}
                            autoFocus
                            onChange={(event) => setEditing({ id: student.id, name: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') saveName()
                              if (event.key === 'Escape') setEditing(null)
                            }}
                          />
                          {editProblem && <small className="roster-problem">{editProblem}</small>}
                        </>
                      ) : (
                        <>
                          {student.name}
                          {otherClasses.length > 0 && (
                            <small className="roster-also-in">Also in {otherClasses.map(classDisplayName).join(', ')}</small>
                          )}
                        </>
                      )}
                    </th>
                    <td>{student.pseudonym}</td>
                    <td className="class-mgmt-row-actions">
                      {isEditing ? (
                        <>
                          <button type="button" className="secondary-button" onClick={() => setEditing(null)}>
                            Cancel
                          </button>
                          <button type="button" className="primary-button" disabled={Boolean(editProblem)} onClick={saveName}>
                            Save
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => setEditing({ id: student.id, name: student.name })}
                          >
                            Edit
                          </button>
                          <button type="button" className="secondary-button" onClick={() => removeFromClass(student)}>
                            Remove
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <form
        className="roster-manual-add"
        aria-label="Add student"
        onSubmit={(event) => {
          event.preventDefault()
          addStudent()
        }}
      >
        <label>
          <span>First name or initials</span>
          <input
            type="text"
            placeholder="Jordan"
            value={newName}
            aria-invalid={addError ? true : undefined}
            onChange={(event) => {
              setNewName(event.target.value)
              setAddError(null)
            }}
          />
        </label>
        <button type="submit" className="secondary-button" disabled={!newName.trim()}>
          Add Student
        </button>
      </form>
      {addError && (
        <p className="roster-error" role="alert">
          {addError}
        </p>
      )}
    </div>
  )
}

// What the planning form knows about the lesson being created, handed to
// Generate / Upload so a lesson added from a class can be saved to it.
type PlanningLessonDetails = {
  topic: string
  gradeLevel: string
  standards: LessonStandardRef[]
  // Science practice ids (see practiceOptions), in the order listed.
  sciencePractices: string[]
  // Lesson length: a preset or the teacher's custom minutes.
  durationMinutes: number | null
  learningObjectives: string
  // Empty unless the teacher wrote one (see extractDrivingQuestion).
  drivingQuestion: string
  instructionalSequence: string
  // Completed optional text fields from Additional Customization, keyed by
  // field.
  optionalContext: Partial<Record<OptionalContextField, string>>
  // Names of the uploaded Additional Customization files (their content
  // isn't read yet).
  uploads: { lessonTemplateName?: string; rubricName?: string }
}

type OptionalContextField =
  | 'priorInstruction'
  | 'subsequentInstruction'
  | 'differentiation'
  | 'materialsAndEquipment'

type PlanningPanelProps = {
  planningTab: PlanningTab
  setPlanningTab: (tab: PlanningTab) => void
  revisionEditor: RevisionWorkflow
  defaultFramework: StandardsFrameworkId
}

function LessonPlanningPage({
  onGenerateLessonPlan,
  onUploadLesson,
  lessonGenerated,
  isGeneratingLesson,
  canvasProps,
  planningPanelProps,
}: {
  onGenerateLessonPlan: (details: PlanningLessonDetails) => void
  onUploadLesson?: (file: File, details: PlanningLessonDetails) => void
  lessonGenerated: boolean
  isGeneratingLesson: boolean
  canvasProps: LessonWorkspaceCanvasProps
  planningPanelProps: PlanningPanelProps
}) {
  return (
    <div className="planning-layout">
      <LessonPlanningPanel
        {...planningPanelProps}
        onGenerate={onGenerateLessonPlan}
        onUploadLesson={onUploadLesson}
      />

      {lessonGenerated ? (
        <LessonWorkspaceCanvas {...canvasProps} />
      ) : (
        <LessonWorkspacePlaceholder isGenerating={isGeneratingLesson} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Student Feedback Activities
//
// At the bottom of the lesson: the Instructional Sequence activities where
// students submit a model, explanation, or other science-practice artifact.
// Teachers confirm, edit, add, or remove them; once every one is confirmed,
// the lesson gets one Student Feedback link listing all of them in order.
// There's no backend yet, so the link carries the confirmed activities
// itself (nothing about students is in it) — the Student Feedback page reads
// them from the URL.
// ---------------------------------------------------------------------------

type FeedbackActivity = {
  id: string
  name: string
  // What students submit, in a short sentence.
  submission: string
  confirmed: boolean
  // The lesson section it was identified from; absent for teacher-added ones.
  sourceLabel?: string
}

// The lesson-specific assignment a Student Feedback link opens.
type StudentAssignmentLink = {
  lessonId: string
  lessonTitle: string
  activities: { name: string; submission: string }[]
}

// What counts as a submitted artifact, checked in order — the first match
// describes the activity's submission.
const submissionRules: { pattern: RegExp; submission: string }[] = [
  { pattern: /revis\w* (?:their|the|a|its) models?/, submission: 'Their revised model, with a note on what they changed and why.' },
  {
    pattern: /\b(?:sketch|build|construct|develop|draw|create)\w*\b[^.]{0,40}\bmodels?\b/,
    submission: 'A model (drawing or diagram) showing their current thinking.',
  },
  { pattern: /construct\w* an explanation|written explanation/, submission: 'A written explanation that connects a claim to evidence.' },
  { pattern: /argument from evidence|make a claim|claims? about/, submission: 'A claim supported by evidence.' },
  { pattern: /ask questions|generate\w* (?:their )?questions|questions are collected/, submission: 'The questions they still need to answer.' },
  { pattern: /reflection|exit ticket/, submission: 'A short written reflection on what they learned.' },
]

// The Instructional Sequence steps: from its heading up to the next one.
function instructionalSequenceSteps(lesson: LessonDocument): LessonStep[] {
  const start = lesson.steps.findIndex((step) => step.sectionHeading === 'Instructional Sequence')
  if (start < 0) return []
  const end = lesson.steps.findIndex((step, index) => index > start && step.sectionHeading)
  return lesson.steps.slice(start, end < 0 ? undefined : end)
}

function activityName(step: LessonStep): string {
  return step.displayPrefix ? step.displayPrefix.replace(/^\d+\.\s*/, '').replace(/:$/, '').trim() || step.label : step.label
}

function identifyFeedbackActivities(lesson: LessonDocument): FeedbackActivity[] {
  return instructionalSequenceSteps(lesson).flatMap((step) => {
    const text = segmentsToText(step.segments).toLowerCase()
    const rule = submissionRules.find((item) => item.pattern.test(text))
    return rule ? [{ id: step.label, name: activityName(step), submission: rule.submission, confirmed: false, sourceLabel: step.label }] : []
  })
}

// The link's assignment, or null until there's at least one activity and
// every activity is confirmed.
function assignmentLinkFor(lessonId: string, lessonTitle: string, activities: readonly FeedbackActivity[]): StudentAssignmentLink | null {
  if (activities.length === 0 || activities.some((activity) => !activity.confirmed)) return null
  return { lessonId, lessonTitle, activities: activities.map(({ name, submission }) => ({ name, submission })) }
}

function encodeAssignment(link: StudentAssignmentLink): string {
  const json = JSON.stringify({ l: link.lessonId, t: link.lessonTitle, a: link.activities.map((item) => [item.name, item.submission]) })
  let binary = ''
  new TextEncoder().encode(json).forEach((byte) => {
    binary += String.fromCharCode(byte)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeAssignment(value: string): StudentAssignmentLink | null {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
    const data: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))))
    if (!data || typeof data !== 'object') return null
    const { l, t, a } = data as { l?: unknown; t?: unknown; a?: unknown }
    if (typeof l !== 'string' || typeof t !== 'string' || !Array.isArray(a)) return null
    const activities = a
      .filter((item): item is [string, string] => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string')
      .map(([name, submission]) => ({ name, submission }))
    return activities.length > 0 ? { lessonId: l, lessonTitle: t, activities } : null
  } catch {
    return null
  }
}

function studentAssignmentHash(link: StudentAssignmentLink): string {
  return `student-feedback?lesson=${encodeURIComponent(link.lessonId)}&assignment=${encodeAssignment(link)}`
}

function studentAssignmentUrl(link: StudentAssignmentLink): string {
  return `${window.location.origin}${window.location.pathname}#${studentAssignmentHash(link)}`
}

// A Student Feedback link in the current URL, if there is one.
function readStudentAssignmentFromHash(): StudentAssignmentLink | null {
  const [page, query] = window.location.hash.replace('#', '').split('?')
  if (page !== 'student-feedback' || !query) return null
  return decodeAssignment(new URLSearchParams(query).get('assignment') ?? '')
}

function StudentFeedbackActivities({
  lessonId,
  lessonTitle,
  activities,
  onChange,
}: {
  lessonId: string
  lessonTitle: string
  activities: readonly FeedbackActivity[]
  onChange: (next: FeedbackActivity[]) => void
}) {
  // The activity being edited (or 'new' for one being added) and its draft.
  const [editing, setEditing] = useState<{ id: string; name: string; submission: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const confirmedCount = activities.filter((activity) => activity.confirmed).length
  const remaining = activities.length - confirmedCount
  const link = assignmentLinkFor(lessonId, lessonTitle, activities)
  const url = link ? studentAssignmentUrl(link) : null
  const canSave = Boolean(editing?.name.trim() && editing.submission.trim())

  const saveEdit = () => {
    if (!editing || !canSave) return
    const values = { name: editing.name.trim(), submission: ensurePeriod(editing.submission.trim()), confirmed: true }
    onChange(
      editing.id === 'new'
        ? [...activities, { id: `custom-${Date.now()}`, ...values }]
        : activities.map((activity) => (activity.id === editing.id ? { ...activity, ...values } : activity)),
    )
    setEditing(null)
    setCopied(false)
  }

  const copyLink = async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const editor = (
    <div className="feedback-activity-editor">
      <label>
        <span>Activity name</span>
        <input
          type="text"
          value={editing?.name ?? ''}
          autoFocus
          onChange={(event) => setEditing((prev) => (prev ? { ...prev, name: event.target.value } : prev))}
        />
      </label>
      <label>
        <span>What students submit</span>
        <textarea
          rows={2}
          value={editing?.submission ?? ''}
          onChange={(event) => setEditing((prev) => (prev ? { ...prev, submission: event.target.value } : prev))}
        />
      </label>
      <div className="feedback-activity-actions">
        <button type="button" className="primary-button" disabled={!canSave} onClick={saveEdit}>
          {editing?.id === 'new' ? 'Add Activity' : 'Save'}
        </button>
        <button type="button" className="secondary-button" onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <section className="feedback-activities" aria-labelledby="feedback-activities-heading">
      <div className="feedback-activities-header">
        <div>
          <p className="card-label">Student Feedback Activities</p>
          <h4 id="feedback-activities-heading">
            {pluralize(activities.length, 'submission activity', 'submission activities')}
          </h4>
        </div>
        {activities.length > 0 && (
          <span className={`badge feedback-confirmed-count${remaining === 0 ? ' all-confirmed' : ''}`}>
            {confirmedCount} of {activities.length} confirmed
          </span>
        )}
      </div>
      <p className="feedback-activities-hint">
        Activities from the Instructional Sequence where students submit a model, explanation, or other science-practice
        work for feedback. Confirm each one, or edit, add, and remove activities.
      </p>

      {activities.length > 0 && (
        <ol className="feedback-activity-list">
          {activities.map((activity, index) => (
            <li key={activity.id} className={`feedback-activity${activity.confirmed ? ' confirmed' : ''}`}>
              {editing?.id === activity.id ? (
                editor
              ) : (
                <>
                  <div className="feedback-activity-text">
                    <p className="feedback-activity-name">
                      <span className="feedback-activity-number">{index + 1}.</span> {activity.name}
                      <span className={`feedback-activity-status${activity.confirmed ? ' confirmed' : ''}`}>
                        {activity.confirmed ? '✓ Confirmed' : 'Needs confirmation'}
                      </span>
                    </p>
                    <p>{activity.submission}</p>
                  </div>
                  <div className="feedback-activity-actions">
                    {!activity.confirmed && (
                      <button
                        type="button"
                        className="primary-button"
                        onClick={() => {
                          onChange(activities.map((item) => (item.id === activity.id ? { ...item, confirmed: true } : item)))
                          setCopied(false)
                        }}
                      >
                        Confirm
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setEditing({ id: activity.id, name: activity.name, submission: activity.submission })}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ghost-button feedback-activity-remove"
                      aria-label={`Remove ${activity.name}`}
                      onClick={() => {
                        onChange(activities.filter((item) => item.id !== activity.id))
                        if (editing?.id === activity.id) setEditing(null)
                        setCopied(false)
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ol>
      )}

      {editing?.id === 'new' ? (
        <div className="feedback-activity feedback-activity-new">{editor}</div>
      ) : (
        <button type="button" className="secondary-button feedback-add-button" onClick={() => setEditing({ id: 'new', name: '', submission: '' })}>
          + Add Activity
        </button>
      )}

      <div className="feedback-link" aria-live="polite">
        <p className="card-label">Student Feedback link</p>
        {url ? (
          <>
            <div className="feedback-link-row">
              <input type="text" readOnly value={url} aria-label="Student Feedback link" onFocus={(event) => event.target.select()} />
              <button type="button" className="secondary-button" onClick={() => void copyLink()}>
                {copied ? 'Copied' : 'Copy Link'}
              </button>
              <a className="primary-button feedback-open-link" href={url} target="_blank" rel="noopener noreferrer">
                Open Student Page
              </a>
            </div>
            <p className="feedback-link-note">
              One link for this lesson, with all {pluralize(activities.length, 'activity', 'activities')} in order. Student
              submissions aren’t saved yet in the prototype.
            </p>
          </>
        ) : (
          <p className="feedback-link-pending" role="status">
            {activities.length === 0
              ? 'Pending — add at least one submission activity to create the link.'
              : `Pending — confirm the remaining ${pluralize(remaining, 'activity', 'activities')} to create this lesson’s link.`}
          </p>
        )}
      </div>
    </section>
  )
}

type LessonWorkspaceCanvasProps = {
  editor: RevisionWorkflow
  lesson: LessonDocument
  // The id used in the lesson's Student Feedback link.
  lessonLinkId: string
  feedbackActivities: readonly FeedbackActivity[]
  onFeedbackActivitiesChange: (next: FeedbackActivity[]) => void
  setPlanningTab: (tab: PlanningTab) => void
  lessonSource: LessonSource
  dismissedSuggestions: readonly string[]
  setDismissedSuggestions: Dispatch<SetStateAction<string[]>>
  isEditing: boolean
  setIsEditing: Dispatch<SetStateAction<boolean>>
  manualEdits: Record<string, string>
  setManualEdits: Dispatch<SetStateAction<Record<string, string>>>
  draftBySection: Record<string, string>
  setDraftBySection: Dispatch<SetStateAction<Record<string, string>>>
  editBaseline: Record<string, string>
  setEditBaseline: Dispatch<SetStateAction<Record<string, string>>>
}

// The lesson itself — sections with their AI suggestions, Edit Lesson, and
// the contextual AI interactions. Mounted on the Lesson Planning page right
// after Generate Lesson; its state is all lifted up to App via props, so
// navigating to another page and back never loses a revision,
// conversation, or manual edit.
function LessonWorkspaceCanvas({
  editor,
  lesson,
  lessonLinkId,
  feedbackActivities,
  onFeedbackActivitiesChange,
  setPlanningTab,
  lessonSource,
  dismissedSuggestions,
  setDismissedSuggestions,
  isEditing,
  setIsEditing,
  manualEdits,
  setManualEdits,
  draftBySection,
  setDraftBySection,
  editBaseline,
  setEditBaseline,
}: LessonWorkspaceCanvasProps) {

  const contentRef = useRef<HTMLDivElement>(null)
  const { popup, clear: clearPopup } = useSelectionPopup(contentRef)
  // Suggestion cards start collapsed to a compact header; each one expands
  // and collapses on its own. Collapsing only hides the card's details —
  // the suggestion and its highlight stay until it's applied or dismissed.
  const [expandedSuggestions, setExpandedSuggestions] = useState<string[]>([])
  const toggleSuggestion = (label: string) =>
    setExpandedSuggestions((prev) => (prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label]))

  const getDisplayText = (label: string, segments: readonly LessonSegment[]) => {
    const manualEdit = manualEdits[label]
    if (manualEdit !== undefined) return manualEdit
    const applied = editor.revisedLesson[label]
    if (applied !== undefined) return applied
    return segmentsToText(segments)
  }

  const startEditing = () => {
    const drafts: Record<string, string> = {}
    for (const step of lesson.steps) {
      drafts[step.label] = getDisplayText(step.label, step.segments)
    }
    setDraftBySection(drafts)
    setEditBaseline(drafts)
    setIsEditing(true)
  }

  const saveEditing = () => {
    setManualEdits((prev) => {
      const next = { ...prev }
      for (const [label, text] of Object.entries(draftBySection)) {
        if (text !== editBaseline[label]) {
          next[label] = text
        }
      }
      return next
    })
    setIsEditing(false)
  }

  // The single entry point for "Revise Lesson" — opens (or restarts) a
  // section's conversation and switches the left workspace over to it,
  // whether triggered from a flagged AI suggestion or a freeform text
  // selection. The lesson's `revisionSegments` seed the initial
  // concrete proposal for sections that have one; freeform selections just
  // get a conversation with no preview/apply step, same as before.
  const startRevisionChat = (label: string, text: string, viaSuggestion: boolean) => {
    const revision = lesson.revisionSegments[label]
    editor.ask(label, buildSectionConversation(text, label, viaSuggestion, lesson), revision && segmentsToText(revision), revision)
    setPlanningTab('revision')
  }

  // Re-focuses an already-engaged section's conversation (chatting,
  // previewing, or applied) without resetting it.
  const focusRevisionChat = (label: string) => {
    editor.reopen(label)
    setPlanningTab('revision')
  }

  const handleManualAskAI = (text: string, sectionKey: string | null) => {
    if (!sectionKey) return
    startRevisionChat(sectionKey, text, false)
    clearPopup()
    window.getSelection()?.removeAllRanges()
  }

  const pendingSuggestionCount = lesson.steps.filter(
    (step) =>
      lesson.suggestions[step.label] &&
      editor.revisedLesson[step.label] === undefined &&
      !dismissedSuggestions.includes(step.label),
  ).length

  const renderLessonStep = (step: LessonStep) => {
    // Most steps show their own label as the lead-in text ("Standards:",
    // "Engage:"); a few — the individually editable numbered learning
    // objectives — replace that with a short displayPrefix ("1.A", "1.B",
    // "1.C") since their internal label is only a data key, not something
    // meant to be read.
    const labelText = step.displayPrefix ?? `${step.label}:`
    const key = step.label

    const revisionState = editor.statesByLabel[key]
    const appliedText = editor.revisedLesson[key]
    const isApplied = appliedText !== undefined
    // Highlight only the part AI actually contributed, never the section's
    // original wording. Falls back to highlighting the whole applied text
    // only when we genuinely can't tell which part is new (see apply() in
    // useRevisionWorkflow).
    const richSegments = editor.revisedLessonSegments[key]
    const isFocused = editor.activeLabel === key
    // The suggestion for this section, if it has one that hasn't been
    // applied or dismissed — shown as a card right under the section, with
    // its flagged phrase highlighted in the text.
    const suggestion = !isApplied && !dismissedSuggestions.includes(key) ? lesson.suggestions[key] : undefined
    const showSuggestionHighlight = Boolean(suggestion)
    const sectionClassName =
      [isFocused && 'section-focused', editor.justAppliedLabel === key && 'section-just-applied']
        .filter(Boolean)
        .join(' ') || undefined

    // Review a suggestion in the chat on the left (where it can be applied).
    // Once the teacher has engaged with it, this just re-opens that ongoing
    // conversation.
    const askAboutSuggestion = () => {
      if (revisionState) {
        focusRevisionChat(key)
        return
      }
      const flaggedText = segmentsToText(step.segments.filter((segment) => segment.flagged))
      startRevisionChat(key, flaggedText || segmentsToText(step.segments), true)
    }
    const handleTriggerClick = askAboutSuggestion

    // Dismissing keeps the original text; it also closes the suggestion's
    // conversation if that's the one open on the left.
    const dismissSuggestion = () => {
      setDismissedSuggestions((prev) => (prev.includes(key) ? prev : [...prev, key]))
      if (editor.activeLabel === key) editor.closeChat()
    }

    const isSuggestionExpanded = expandedSuggestions.includes(key)
    const suggestionBodyId = `suggestion-${key.replace(/[^a-zA-Z0-9]+/g, '-')}`
    const suggestionCard = suggestion && (
      <div
        className={`suggestion-popover lesson-suggestion-card${isSuggestionExpanded ? ' is-expanded' : ''}`}
        role="note"
        aria-label={`AI suggestion for ${step.displayPrefix ?? step.label}`}
      >
        <button
          type="button"
          className="lesson-suggestion-toggle"
          aria-expanded={isSuggestionExpanded}
          aria-controls={suggestionBodyId}
          onClick={() => toggleSuggestion(key)}
        >
          <span className="lesson-suggestion-sparkle" aria-hidden="true">
            ✦
          </span>
          <span className="card-label">AI Suggestion</span>
          <span className="lesson-suggestion-chevron" aria-hidden="true">
            {isSuggestionExpanded ? '▴' : '▾'}
          </span>
        </button>
        {isSuggestionExpanded && (
          <div className="lesson-suggestion-body" id={suggestionBodyId}>
            <p>{suggestion}</p>
            <div className="lesson-suggestion-actions">
              <button type="button" className="primary-button" onClick={askAboutSuggestion}>
                Revise Lesson
              </button>
              <button type="button" className="ghost-button lesson-suggestion-dismiss" onClick={dismissSuggestion}>
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>
    )

    // Clicking an "AI revised" section: reopen the existing conversation if
    // one exists; there always is one by the time a section shows as
    // applied, since Apply Change is what makes it applied in the first
    // place — but this stays defensive in case that ever changes.
    const openAppliedSectionChat = () => {
      if (revisionState) {
        focusRevisionChat(key)
      } else {
        const flaggedText = segmentsToText(step.segments.filter((segment) => segment.flagged))
        startRevisionChat(key, flaggedText || segmentsToText(step.segments), true)
      }
    }

    if (isEditing) {
      // A pending suggestion stays visible right next to its textarea while
      // editing, so the teacher can compare it against what they're typing.
      // A section with an ongoing review conversation keeps its card too,
      // even once applied — AI-revised text is edited exactly like any other
      // text, with its AI conversation still one click away. Dismissed
      // suggestions don't come back here.
      const editingSuggestion = !dismissedSuggestions.includes(key) ? lesson.suggestions[key] : undefined
      const showEditingSuggestion = Boolean(editingSuggestion && !isApplied) || Boolean(revisionState)
      return (
        <div data-section-key={key}>
          <p>
            <strong>{labelText}</strong> <DurationBadge duration={step.duration} objectives={step.objectives} />
          </p>
          <textarea
            rows={3}
            value={draftBySection[key] ?? ''}
            onChange={(event) => setDraftBySection((prev) => ({ ...prev, [key]: event.target.value }))}
          />
          {showEditingSuggestion && (
            <div className="suggestion-popover">
              <p className="card-label">AI Suggestion</p>
              {editingSuggestion && <p>{editingSuggestion}</p>}
              <button type="button" className="secondary-button" onClick={askAboutSuggestion}>
                Revise Lesson
              </button>
            </div>
          )}
        </div>
      )
    }

    // The current lesson (manual edits + whatever's been applied so far),
    // with the yellow "AI revised" highlight/tag on an applied section and
    // any pending suggestion flagged in the text and shown as a card below.

    // A manual edit (from Edit Lesson / Save Edits) always takes
    // priority for display — it's the teacher's own final wording,
    // shown as plain text with no yellow highlight, which is
    // reserved for AI suggestions and AI-applied changes. If AI had
    // revised the section before the teacher edited it, the "AI revised"
    // tag stays as a record of that — informational only.
    const manualEdit = manualEdits[key]
    if (manualEdit !== undefined) {
      return (
        <div data-section-key={key} className={sectionClassName}>
          <p>
            {labelText} <DurationBadge duration={step.duration} objectives={step.objectives} /> {manualEdit}
            {isApplied && (
              <>
                {' '}
                <span className="ai-revised-tag">AI revised</span>
              </>
            )}
          </p>
        </div>
      )
    }

    // Materials and Equipment & Technology render as a bullet list — one
    // list item per segment — instead of one flowing paragraph, as long as
    // the section hasn't been applied yet. An applied change is a flat,
    // one-off accepted string and falls through to the normal paragraph
    // rendering below, like every other applied section.
    if (step.listStyle === 'bullet' && !isApplied) {
      return (
        <div data-section-key={key} className={sectionClassName}>
          {labelText && <p>{labelText}</p>}
          <ul className="lesson-bullet-list">
            {step.segments.map((segment, segmentIndex) => {
              const content = segment.bold ? <strong>{segment.text}</strong> : segment.text
              if (showSuggestionHighlight && segment.flagged) {
                return (
                  <li key={segmentIndex}>
                    <span
                      role="button"
                      tabIndex={0}
                      className="ai-highlight lesson-highlight-trigger"
                      onClick={handleTriggerClick}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          handleTriggerClick()
                        }
                      }}
                    >
                      {content}
                    </span>
                  </li>
                )
              }
              return <li key={segmentIndex}>{content}</li>
            })}
          </ul>

          {suggestionCard}
        </div>
      )
    }

    return (
      <div data-section-key={key} className={sectionClassName}>
        <p>
          {labelText} <DurationBadge duration={step.duration} objectives={step.objectives} />{' '}
          {isApplied ? (
            <>
              <span
                role="button"
                tabIndex={0}
                className={richSegments ? 'lesson-highlight-trigger' : 'lesson-highlight-trigger ai-highlight'}
                onClick={openAppliedSectionChat}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openAppliedSectionChat()
                  }
                }}
              >
                {richSegments ? <LessonRichText segments={richSegments} /> : appliedText}
              </span>
              <span className="ai-revised-tag">AI revised</span>
            </>
          ) : showSuggestionHighlight ? (
            // Only the segment(s) marked `flagged` (the specific sentence or
            // phrase the suggestion is about) become the clickable/highlighted
            // trigger — the rest of the section renders as the teacher's
            // normal text, so an AI suggestion never blankets a whole section.
            <>
              {step.segments.map((segment, segmentIndex) => {
                const content = segment.bold ? <strong>{segment.text}</strong> : segment.text
                if (!segment.flagged) {
                  return <span key={segmentIndex}>{content}</span>
                }
                return (
                  <span
                    key={segmentIndex}
                    role="button"
                    tabIndex={0}
                    className="lesson-highlight-trigger ai-highlight"
                    onClick={handleTriggerClick}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        handleTriggerClick()
                      }
                    }}
                  >
                    {content}
                  </span>
                )
              })}
            </>
          ) : (
            <LessonRichText segments={step.segments} />
          )}
        </p>

        {suggestionCard}
      </div>
    )
  }

  return (
    <>
      <section className="workspace-canvas">
        <div className="canvas-header">
          <div>
            <p className="card-label">Lesson workspace</p>
            <h3>Lesson plan</h3>
          </div>
          <div className="canvas-header-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => (isEditing ? saveEditing() : startEditing())}
            >
              {isEditing ? 'Save Edits' : 'Edit Lesson'}
            </button>
            <button type="button" className="primary-button">
              Export Lesson Plan
            </button>
          </div>
        </div>

        <p className="lesson-suggestion-summary" role="status">
          {pendingSuggestionCount > 0
            ? `${pluralize(pendingSuggestionCount, 'AI suggestion')} to review — each appears under its section.`
            : 'No AI suggestions waiting for review.'}
          {dismissedSuggestions.length > 0 && (
            <>
              {' '}
              <button type="button" className="ghost-button lesson-suggestion-restore" onClick={() => setDismissedSuggestions([])}>
                Restore {pluralize(dismissedSuggestions.length, 'dismissed suggestion')}
              </button>
            </>
          )}
        </p>
        <p className="lesson-source">Source: {lessonSourceLabels[lessonSource]}</p>

        <p className="content-legend">
          <span>
            <strong>Bold</strong> = Science Practice
          </span>
          <span className="legend-divider">·</span>
          <span>
            <span className="ai-highlight">Yellow</span> = AI Suggestion / Change
          </span>
        </p>

        {!isEditing && <p className="lesson-hint">Highlight any text in the lesson to ask AI about it.</p>}

        <div className="lesson-plan-editor">
          <div className="lesson-plan-content" ref={contentRef}>
            <p className="card-label">Lesson Overview</p>
            <p data-section-key="workspace-meta-0">Lesson Title: {lesson.title}</p>

            {lesson.steps.map((step) => (
              <Fragment key={step.label}>
                {step.sectionHeading && <p className="card-label lesson-section-heading">{step.sectionHeading}</p>}
                {step.leadIn && <p className="lesson-lead-in">{step.leadIn}</p>}
                {renderLessonStep(step)}
                {step.afterSection === 'practices' && (
                  <div className="practice-tags-block" data-section-key="workspace-practices">
                    <p className="card-label">Science Practices to Emphasize</p>
                    <div className="context-tags">
                      {lesson.practices.map((practice) => (
                        <span key={practice} className="tag">
                          {practice}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </Fragment>
            ))}
          </div>
        </div>

        <StudentFeedbackActivities
          key={lessonLinkId}
          lessonId={lessonLinkId}
          lessonTitle={lesson.title}
          activities={feedbackActivities}
          onChange={onFeedbackActivitiesChange}
        />
      </section>

      <SelectionAskAIPopup popup={popup} onAskAI={handleManualAskAI} />
    </>
  )
}

// Every summary row across all three sections defaults to unselected except
// the very first Learning Objective idea, so the individual-evidence panel
// always has something to show rather than opening empty.
const defaultPatternId = learningObjectiveOverlap[0]?.ideas[0]?.id ?? null

// One clickable row shared by all three summary sections — a pattern's
// label and its student count. Highlights with the same light-blue
// selection style used elsewhere in the app (`.trend-item.active` before
// it, now `.pattern-row.active`) when it's the currently selected pattern.
function PatternRowButton({
  row,
  isActive,
  onSelect,
}: {
  row: PatternRow
  isActive: boolean
  onSelect: (id: string) => void
}) {
  return (
    <div
      className={`pattern-row${isActive ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      aria-pressed={isActive}
      onClick={() => onSelect(row.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect(row.id)
        }
      }}
    >
      <span className="pattern-row-label">{row.label}</span>
      <span className="pattern-row-count">{row.count}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Student Feedback — the student-facing counterpart to Lesson Planning/
// Workspace and Class Feedback, but a DIFFERENT content context: this page
// uses a COVID-19 / handwashing modeling activity (the structures of the
// coronavirus and of soap, and how soap's structure lets it disrupt the
// virus and mix with water) rather than the Zombie Fires phenomenon used
// everywhere else in the prototype — see the teacher-facing pages for that
// content. Same two-panel shape as the rest of the app — the student's own
// model and explanation on the left, a persistent AI Feedback conversation
// on the right — and the same shared building blocks
// (ChatThread, chips, composer-box, card styling) rather than a one-off
// visual language.
// ---------------------------------------------------------------------------

type ModelTab = 'descriptive' | 'mechanistic'

// Two representations of the SAME model (not two assignments) — switching
// tabs must never lose either one, so both live in the same component's
// state the whole time; the tabs only ever change which is on screen.
// Descriptive = what structures/components are present. Mechanistic = how
// those structures interact to help explain what happens.
const modelTabLabels: Record<ModelTab, string> = {
  descriptive: 'Descriptive Model',
  mechanistic: 'Mechanistic Model',
}

const studentTask = {
  topic: 'COVID-19 & Handwashing: Structure and Function',
  prompt:
    "Develop and use models to think about the structures of the coronavirus and soap, then explain how the structure of soap helps it function when mixed with water.",
}

// The Descriptive Model prompt has two lettered parts (virus, then soap),
// each with its own set of structures to label — kept as data so the JSX
// below just maps over it instead of hand-duplicating the two halves.
const descriptiveModelPrompt: { heading: string; instruction: string; labels: string[] }[] = [
  {
    heading: 'A. Coronavirus',
    instruction: 'Draw a diagram of the coronavirus and label:',
    labels: ['Protein', 'Fatty envelope', 'Genetic material'],
  },
  {
    heading: 'B. Soap',
    instruction: 'Draw a diagram of a soap molecule and label:',
    labels: ['Hydrophilic portion (attracted to water)', 'Hydrophobic portion (attracted to fat)'],
  },
]

const mechanisticModelPrompt =
  'Draw a diagram that helps show how the structures of a soap molecule can help serve the function of helping oil mix with water. Show how soap molecules, oil, and water interact.'

const initialStudentExplanation =
  "In my model I drew the soap's hydrophobic tail sticking into the virus's fatty envelope, since both of those are supposed to be attracted to fat. I think that's part of how soap breaks the virus apart, but I'm not totally sure yet how the hydrophilic end helps rinse it away with water — I want to add that to my mechanistic model."

// Each model tab gets its own AI feedback conversation, not one shared
// chatbot (see section 1/2/3 of the spec) — so the two are seeded
// separately here, and StudentFeedbackPage keeps them in separate state
// keyed by ModelTab. Both are seeded so the page always opens mid-
// conversation, exactly like a student returning to feedback they've
// already started.
//
// Descriptive: short, and stays focused on helping the student notice and
// describe structures/components that are already in their DRAWING — what's
// labeled, where things are positioned, and whether the relationships
// between structures are actually visible on the page — never jumping ahead
// to mechanism/why, and never just explaining the answer itself.
const initialDescriptiveFeedback: ChatMessage[] = [
  {
    role: 'ai',
    text: 'I see that you labeled the coronavirus’s fatty envelope and the two parts of the soap molecule. Where could you add water to your drawing so the relationship between the hydrophilic part and water is easier to see?',
  },
  { role: 'teacher', text: 'I could draw water molecules around the soap.' },
  {
    role: 'ai',
    text: 'That could make the relationship clearer. Which part of the soap molecule should point toward the water in your drawing?',
  },
]

// Mechanistic: opens on what's in the student's mechanistic drawing and
// pushes toward interactions and change (many soap molecules acting on the
// envelope), then — the last word in the conversation — explicitly sends
// the student back to their Descriptive Model, naming the specific
// relationships they represented there (hydrophobic part ↔ fat,
// hydrophilic part ↔ water), and asks how to use those as the foundation
// for showing the mechanism with arrows, labels, or positioning. The
// progression it models: what I represented descriptively helps me reason
// about and improve my mechanistic model. Scaffolds with questions, never a
// textbook explanation of why soap works.
const initialMechanisticFeedback: ChatMessage[] = [
  {
    role: 'ai',
    text: 'I see that you drew the hydrophobic part of the soap next to the virus’s fatty envelope. What could you add to show what happens when many soap molecules interact with the envelope?',
  },
  { role: 'teacher', text: 'Maybe I could show the fatty layer starting to break apart?' },
  {
    role: 'ai',
    text: 'Look back at your Descriptive Model: you showed that the hydrophobic part of soap interacts with fat while the hydrophilic part interacts with water. How could you use arrows, labels, or positioning in your Mechanistic Model to show how these interactions contribute to the change in the fatty envelope?',
  },
]

const initialFeedbackByTab: Record<ModelTab, ChatMessage[]> = {
  descriptive: initialDescriptiveFeedback,
  mechanistic: initialMechanisticFeedback,
}

// Shown as a small contextual label above the Mechanistic Model AI
// conversation (spec section 4) — makes the connection to the Descriptive
// Model explicit to the student, not just implicit in the AI's wording.
const mechanisticProgressionNote = 'Building on your Descriptive Model'

// Rotates through generic Socratic follow-ups when nothing in the student's
// message keyword-matches something more specific below — the point is the
// conversation always has somewhere to go, never that it runs out of things
// to ask. Kept separate per model tab so the fallback question still matches
// what that tab is meant to help students think about (structures/labels for
// Descriptive, interactions/mechanism for Mechanistic — see section 7).
const genericDescriptiveFollowUps = [
  'Which structure in your model would that be part of — is it something you could add a label for?',
  'Is that a structure you’ve already drawn, or a new part you’d want to add to your model?',
  'Where is that positioned in your drawing, and is its relationship to the nearby structures easy to see?',
  'How does that structure compare between the virus and the soap molecule in your model?',
]

const genericMechanisticFollowUps = [
  'Where in your model would that interaction show up — is it something you could add an arrow for?',
  'How could you use arrows or labels to show that happening over time, rather than all at once?',
  'Is that something your model already shows happening, or a new relationship you’d want to add?',
  'Which structures are involved in that, and how would you position them relative to each other to show it?',
]

// Stands in for a real AI call. Always responds with a scaffolding question
// grounded in whatever the student just said, never the scientific answer
// itself — matches the rest of this prototype's "mock reply" convention
// (see mockDeeperAnalysisReply / mockRevisionFollowUpReply). Every reply
// stays anchored to the DRAWING itself — labels, arrows, structures, and
// the positioning/relationships between them, and what is or isn't yet
// represented visually — rather than explaining the underlying science, so
// this never reads as a general science tutor giving the answer away.
// Sensitive to which model tab the student is currently on (see section 7
// of the spec): Descriptive replies stay focused on identifying and
// labeling structures/positioning, Mechanistic replies stay focused on
// interactions, cause-and-effect, and change shown through arrows.
function mockStudentFeedbackReply(message: string, followUpCount: number, modelTab: ModelTab): string {
  const lower = message.toLowerCase()

  if (modelTab === 'descriptive') {
    if (lower.includes('protein') || lower.includes('spike')) {
      return 'You mentioned the protein. Where did you draw it on the coronavirus, and how does its position compare to the fatty envelope in your model?'
    }
    if (lower.includes('envelope') || lower.includes('fatty')) {
      return 'You’re describing the fatty envelope. What part of the soap molecule do you think would interact with it — and did you label that part?'
    }
    if (lower.includes('genetic') || lower.includes('rna') || lower.includes('dna')) {
      return 'You’re thinking about the genetic material. Where is it positioned in your model, and did you draw or label anything around it to show what protects it?'
    }
    if (lower.includes('hydrophilic') || lower.includes('water')) {
      return 'You’re describing the hydrophilic portion. Which end of the soap molecule is that, and how did you show it in your diagram?'
    }
    if (lower.includes('hydrophobic') || lower.includes('fat')) {
      return 'You’re describing the hydrophobic portion. Which direction does that part point in your drawing, and is that relationship labeled?'
    }
    return genericDescriptiveFollowUps[followUpCount % genericDescriptiveFollowUps.length]
  }

  if (lower.includes('stick') || lower.includes('attach') || lower.includes('grab')) {
    return 'That connection could be useful to show in your model. What arrow or label could you add to represent what you think the soap is doing?'
  }
  if (lower.includes('break') || lower.includes('dissolve') || lower.includes('disrupt') || lower.includes('apart')) {
    return 'You’re describing something happening to the virus’s structure. What part of your model shows the fatty envelope actually being disrupted, and how would you show that change?'
  }
  if (lower.includes('surround') || lower.includes('cluster') || lower.includes('group') || lower.includes('ball')) {
    return 'That’s an interesting way to represent it. What’s on the outside of that cluster in your model, and what’s on the inside?'
  }
  if (lower.includes('mix') || lower.includes('combine') || (lower.includes('oil') && lower.includes('water'))) {
    return 'You’re describing how oil and water interact with soap. Which part of the soap molecule is facing the oil, and which part is facing the water in your drawing?'
  }
  if (lower.includes('rinse') || lower.includes('wash') || lower.includes('remove') || lower.includes('away')) {
    return 'You’re describing the virus being carried away. What could you add — an arrow, or a change in the drawing — to show what happens right before that point?'
  }
  return genericMechanisticFollowUps[followUpCount % genericMechanisticFollowUps.length]
}

function MicButton({ isListening, onClick, label }: { isListening: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      className={`mic-button${isListening ? ' listening' : ''}`}
      aria-label={isListening ? `Stop recording — ${label}` : `Record — ${label}`}
      aria-pressed={isListening}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3Z" />
        <path
          fill="currentColor"
          d="M19 11a1 1 0 1 0-2 0 5 5 0 0 1-10 0 1 1 0 1 0-2 0 7 7 0 0 0 6 6.92V20H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.08A7 7 0 0 0 19 11Z"
        />
      </svg>
    </button>
  )
}

// The real hand-drawn example artifacts for each model tab — same
// convention as ZOMBIE_FIRES_STUDENT_MODEL_IMAGE above: lives in /public so
// a missing file degrades to a broken-image icon instead of failing the
// build. handleArtifactUpload (in StudentFeedbackPage) swaps either one out
// for the student's own uploaded photo.
const COVID_DESCRIPTIVE_MODEL_EXAMPLE_IMAGE = '/covid-descriptive-model-example.png'
const COVID_MECHANISTIC_MODEL_EXAMPLE_IMAGE = '/covid-mechanistic-model-example.png'

function StudentFeedbackPage({
  initialModelTab = 'descriptive',
  assignment = null,
}: {
  initialModelTab?: ModelTab
  // A lesson's confirmed Student Feedback Activities, from its link.
  assignment?: StudentAssignmentLink | null
}) {
  const [modelTab, setModelTab] = useState<ModelTab>(initialModelTab)
  const [activeActivity, setActiveActivity] = useState(0)
  // The model name belongs to the current submission: this activity (when
  // opened from a lesson link) and this model tab.
  const submissionKey = `${assignment ? activeActivity : 'task'}:${modelTab}`
  const [modelNames, setModelNames] = useState<Record<string, string>>({})
  // Only activities that involve a model ask for a name; the prototype's
  // own task is a modeling task.
  const currentActivity = assignment?.activities[activeActivity]
  const isModelSubmission = !currentActivity || /\bmodel/i.test(`${currentActivity.name} ${currentActivity.submission}`)
  // Each AI message's optional rating, by tab and message position.
  const [ratingsByTab, setRatingsByTab] = useState<Record<ModelTab, Record<number, FeedbackRating>>>({ descriptive: {}, mechanistic: {} })

  // Each tab's artifact is independent state — switching tabs must never
  // lose either one (see the ModelTab comment above). null means "showing
  // the starter reference diagram"; once the student uploads a photo of
  // their own drawing, this holds an object URL for it instead.
  const [descriptiveArtifactUrl, setDescriptiveArtifactUrl] = useState<string | null>(null)
  const [mechanisticArtifactUrl, setMechanisticArtifactUrl] = useState<string | null>(null)
  const artifactFileInputRef = useRef<HTMLInputElement>(null)

  const handleArtifactUpload = (tab: ModelTab, file: File | undefined) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const previousUrl = tab === 'descriptive' ? descriptiveArtifactUrl : mechanisticArtifactUrl
    if (previousUrl) URL.revokeObjectURL(previousUrl)
    if (tab === 'descriptive') setDescriptiveArtifactUrl(url)
    else setMechanisticArtifactUrl(url)
  }

  const [explanation, setExplanation] = useState(initialStudentExplanation)
  const explanationRef = useRef<HTMLTextAreaElement>(null)
  const [isExplanationListening, setIsExplanationListening] = useState(false)
  const explanationListenTimeoutRef = useRef<number | null>(null)

  // Descriptive and Mechanistic each keep their own conversation — switching
  // tabs must never lose or mix either one (same rule as the artifact state
  // above), so both live keyed by tab in one piece of state.
  const [feedbackMessagesByTab, setFeedbackMessagesByTab] = useState<Record<ModelTab, ChatMessage[]>>(initialFeedbackByTab)
  const feedbackMessages = feedbackMessagesByTab[modelTab]
  const [feedbackDraft, setFeedbackDraft] = useState('')
  const [isComposerListening, setIsComposerListening] = useState(false)
  const composerListenTimeoutRef = useRef<number | null>(null)
  const [isAiThinking, setIsAiThinking] = useState(false)
  const aiThinkingTimeoutRef = useRef<number | null>(null)
  const followUpCountRef = useRef<Record<ModelTab, number>>({ descriptive: 0, mechanistic: 0 })
  const chatScrollRef = useRef<HTMLDivElement | null>(null)

  const [isRevisionFlash, setIsRevisionFlash] = useState(false)
  const revisionFlashTimeoutRef = useRef<number | null>(null)
  // Tracks the two-button workflow (spec section 1): "Start Iterating" is
  // repeatable and never changes this; "Submit Final Revision" is the one
  // terminal action — once clicked, the button row is replaced with a
  // plain confirmation note, same convention as RevisionChatPanel's
  // "✓ Applied to Lesson" (see .inline-ai-applied-note).
  const [isFinalSubmitted, setIsFinalSubmitted] = useState(false)

  // The chat area is a fixed-height, internally scrolling pane (see
  // .deeper-analysis-chat, reused here) — keep it pinned to the latest
  // message as the conversation grows, same as Deeper AI Analysis.
  useEffect(() => {
    const container = chatScrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [feedbackMessages, isAiThinking])

  useEffect(() => {
    return () => {
      if (explanationListenTimeoutRef.current !== null) window.clearTimeout(explanationListenTimeoutRef.current)
      if (composerListenTimeoutRef.current !== null) window.clearTimeout(composerListenTimeoutRef.current)
      if (aiThinkingTimeoutRef.current !== null) window.clearTimeout(aiThinkingTimeoutRef.current)
      if (revisionFlashTimeoutRef.current !== null) window.clearTimeout(revisionFlashTimeoutRef.current)
    }
  }, [])

  // Both mic controls are mocked the same way (no real speech-to-thing API):
  // toggling "listening" on, then after a short pause, appending a canned
  // transcript — enough to demonstrate "type or speak" without a flaky
  // browser API dependency.
  const toggleExplanationMic = () => {
    if (isExplanationListening) {
      if (explanationListenTimeoutRef.current !== null) window.clearTimeout(explanationListenTimeoutRef.current)
      setIsExplanationListening(false)
      return
    }
    setIsExplanationListening(true)
    explanationListenTimeoutRef.current = window.setTimeout(() => {
      setExplanation((prev) =>
        `${prev.trim() ? `${prev.trim()} ` : ''}Also, I think the hydrophilic end is what lets the soap mix into the water in the first place.`,
      )
      setIsExplanationListening(false)
    }, 1800)
  }

  const toggleComposerMic = () => {
    if (isComposerListening) {
      if (composerListenTimeoutRef.current !== null) window.clearTimeout(composerListenTimeoutRef.current)
      setIsComposerListening(false)
      return
    }
    setIsComposerListening(true)
    composerListenTimeoutRef.current = window.setTimeout(() => {
      setFeedbackDraft((prev) =>
        `${prev.trim() ? `${prev.trim()} ` : ''}I think the hydrophobic tail pulls toward the virus's fatty envelope, away from the water.`,
      )
      setIsComposerListening(false)
    }, 1800)
  }

  const sendFeedbackMessage = () => {
    const text = feedbackDraft.trim()
    if (!text || isAiThinking) return
    const tab = modelTab
    setFeedbackMessagesByTab((prev) => ({ ...prev, [tab]: [...prev[tab], { role: 'teacher', text }] }))
    setFeedbackDraft('')
    setIsAiThinking(true)
    const count = followUpCountRef.current[tab]
    followUpCountRef.current = { ...followUpCountRef.current, [tab]: count + 1 }
    aiThinkingTimeoutRef.current = window.setTimeout(() => {
      setFeedbackMessagesByTab((prev) => ({
        ...prev,
        [tab]: [
          ...prev[tab],
          {
            role: 'ai',
            text: callAiModel('student-feedback', { message: text, followUpCount: count, modelTab: tab }, (request) =>
              mockStudentFeedbackReply(request.message, request.followUpCount, request.modelTab),
            ),
          },
        ],
      }))
      setIsAiThinking(false)
    }, 700)
  }

  // "Start Iterating" never touches the student's text itself — it just
  // brings the editable explanation back into focus, so the student decides
  // what (if anything) to revise based on the AI feedback they've read. It
  // stays available and repeatable throughout the formative loop (create →
  // Start Iterating → get feedback → revise → repeat).
  const handleStartIterating = () => {
    explanationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    explanationRef.current?.focus()
    setIsRevisionFlash(true)
    if (revisionFlashTimeoutRef.current !== null) window.clearTimeout(revisionFlashTimeoutRef.current)
    revisionFlashTimeoutRef.current = window.setTimeout(() => setIsRevisionFlash(false), 1200)
  }

  // "Submit Final Revision" is the one terminal action in this workflow —
  // it marks the formative loop as done and swaps the button row for a
  // plain confirmation note (see isFinalSubmitted above).
  const handleSubmitFinalRevision = () => {
    setIsFinalSubmitted(true)
  }

  return (
    <div className="student-workspace-layout">
      <section className="student-model-panel">
        {assignment ? (
          <div className="student-task-card student-assignment-card">
            <p className="card-label">Your Lesson</p>
            <h3>{assignment.lessonTitle}</h3>
            <p>
              Complete these {pluralize(assignment.activities.length, 'activity', 'activities')} in order, and submit your work for
              each one to get feedback.
            </p>
            <ol className="student-assignment-list">
              {assignment.activities.map((activity, index) => (
                <li key={`${index}-${activity.name}`}>
                  <button
                    type="button"
                    className={`student-assignment-item${activeActivity === index ? ' active' : ''}`}
                    aria-pressed={activeActivity === index}
                    onClick={() => setActiveActivity(index)}
                  >
                    <span className="student-assignment-step">Activity {index + 1}</span>
                    <strong>{activity.name}</strong>
                    <span>{activity.submission}</span>
                  </button>
                </li>
              ))}
            </ol>
            <p className="student-assignment-note">
              The modeling workspace below is the prototype’s example activity; submissions aren’t saved yet.
            </p>
          </div>
        ) : (
          <div className="student-task-card">
            <p className="card-label">Your Task</p>
            <h3>{studentTask.topic}</h3>
            <p>{studentTask.prompt}</p>
          </div>
        )}

        <div className="planning-tabs" role="tablist" aria-label="Model representation">
          {(Object.keys(modelTabLabels) as ModelTab[]).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={modelTab === tab}
              className={`planning-tab ${modelTab === tab ? 'active' : ''}`}
              onClick={() => setModelTab(tab)}
            >
              {modelTabLabels[tab]}
            </button>
          ))}
        </div>

        {modelTab === 'descriptive' ? (
          <div className="model-representation-area">
            <div className="model-task-prompt">
              <p className="model-task-prompt-label">Descriptive Model</p>
              {descriptiveModelPrompt.map((section) => (
                <div key={section.heading} className="model-task-prompt-section">
                  <p className="model-task-prompt-heading">{section.heading}</p>
                  <p>{section.instruction}</p>
                  <ul>
                    {section.labels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            <img
              src={descriptiveArtifactUrl ?? COVID_DESCRIPTIVE_MODEL_EXAMPLE_IMAGE}
              alt="Descriptive model of the coronavirus (protein, fatty envelope, genetic material) and a soap molecule (hydrophilic head, hydrophobic tail)"
              className="student-model-preview"
            />

            <div className="model-representation-actions">
              <input
                ref={artifactFileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(event) => handleArtifactUpload('descriptive', event.target.files?.[0])}
              />
              <button type="button" className="secondary-button" onClick={() => artifactFileInputRef.current?.click()}>
                Add Model
              </button>
            </div>
          </div>
        ) : (
          <div className="model-representation-area">
            <div className="model-task-prompt">
              <p className="model-task-prompt-label">Mechanistic Model</p>
              <p>{mechanisticModelPrompt}</p>
            </div>

            <img
              src={mechanisticArtifactUrl ?? COVID_MECHANISTIC_MODEL_EXAMPLE_IMAGE}
              alt="Mechanistic model of soap molecules trapping oil droplets in water"
              className="student-model-preview"
            />

            <div className="model-representation-actions">
              <input
                ref={artifactFileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(event) => handleArtifactUpload('mechanistic', event.target.files?.[0])}
              />
              <button type="button" className="secondary-button" onClick={() => artifactFileInputRef.current?.click()}>
                Add Model
              </button>
            </div>
          </div>
        )}

        {isModelSubmission && (
          <label className="model-name-field">
            <span>Name Your Model</span>
            <input
              type="text"
              placeholder="Give your model a short name describing its purpose."
              value={modelNames[submissionKey] ?? ''}
              onChange={(event) => setModelNames((prev) => ({ ...prev, [submissionKey]: event.target.value }))}
            />
          </label>
        )}

        <div className={`student-explanation-field${isRevisionFlash ? ' revision-flash' : ''}`}>
          <div className="student-explanation-header">
            <span>Explain your thinking</span>
            <span className="empty-state-support">Type your explanation, or use the microphone to speak it.</span>
          </div>
          <div className="student-explanation-input-row">
            <textarea
              ref={explanationRef}
              rows={6}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              placeholder="Explain how your model shows the structures of the coronavirus and soap, and how soap's structure helps it work with water..."
            />
            <MicButton isListening={isExplanationListening} onClick={toggleExplanationMic} label="your explanation" />
          </div>
          {isExplanationListening && <p className="mic-listening-note">🎤 Listening…</p>}
        </div>

        {isFinalSubmitted ? (
          <p className="inline-ai-applied-note">✓ Final revision submitted</p>
        ) : (
          <div className="model-representation-actions">
            <button type="button" className="primary-button" onClick={handleStartIterating}>
              Start Iterating
            </button>
            <button type="button" className="secondary-button" onClick={handleSubmitFinalRevision}>
              Submit Final Revision
            </button>
          </div>
        )}
      </section>

      {/* `ai-panel-${modelTab}` carries the subtle per-state tint (see
          .ai-panel-descriptive / .ai-panel-mechanistic in App.css) — the
          badge, progression note, and contextual text below all key off the
          same `modelTab` so the whole header changes together with the
          conversation and the model/work on the left. */}
      <section className={`student-ai-panel ai-panel-${modelTab}`}>
        <div className="panel-header compact ai-panel-header">
          <h3>AI Feedback</h3>
          <span className="badge ai-panel-badge">{modelTab === 'descriptive' ? 'Descriptive Model' : 'Mechanistic Model'}</span>
        </div>
        {modelTab === 'mechanistic' && (
          <p className="ai-panel-progression-note">🔗 {mechanisticProgressionNote}</p>
        )}
        <p className="empty-state-support deeper-analysis-subtitle">
          {modelTab === 'mechanistic'
            ? 'Use the structures you identified to explain how the interaction happens.'
            : 'Explore the structures and features shown in your model.'}
        </p>

        <div className="deeper-analysis-body">
          <div className="deeper-analysis-chat" ref={chatScrollRef}>
            {/* `ai-panel-chat-${modelTab}` recolors only the AI bubbles (see
                .ai-panel-chat-descriptive/.ai-panel-chat-mechanistic in
                App.css) — student bubbles stay the shared neutral gray from
                .teacher-message everywhere, unaffected by model tab. */}
            <ChatThread
              messages={feedbackMessages}
              className={`ai-panel-chat-${modelTab}`}
              renderAfterMessage={(message, index) =>
                message.role === 'ai' && (
                  <FeedbackRatingButtons
                    rating={ratingsByTab[modelTab][index]}
                    onChange={(next) =>
                      setRatingsByTab((prev) => {
                        const tabRatings = { ...prev[modelTab] }
                        if (next) tabRatings[index] = next
                        else delete tabRatings[index]
                        return { ...prev, [modelTab]: tabRatings }
                      })
                    }
                  />
                )
              }
            />
            {isAiThinking && <p className="empty-state-support">AI is thinking…</p>}
          </div>

          <div className="composer-box student-feedback-composer">
            <input
              type="text"
              placeholder="Reply to the feedback..."
              value={feedbackDraft}
              onChange={(event) => setFeedbackDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') sendFeedbackMessage()
              }}
              disabled={isAiThinking}
            />
            <MicButton isListening={isComposerListening} onClick={toggleComposerMic} label="your reply" />
            <button
              type="button"
              className="primary-button"
              onClick={sendFeedbackMessage}
              disabled={isAiThinking || !feedbackDraft.trim()}
            >
              Send
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Individual Student Reports — Class Feedback's one-student-at-a-time view,
// sitting between Class Statistics and Class Summary. Class Summary groups
// students by finding; this puts ONE student's initial and revised models
// and explanations side by side, with a short AI analysis underneath. The
// student's own work is the focus — the analysis is deliberately brief.
//
// PROTOTYPE MOCK DATA. The roster is real prototype data (every student who
// appears anywhere in Class Summary evidence), but the detailed reports
// below are hand-written mocks for four of those students. Their shape
// mirrors the planned backend (docs/partners-backend-design.dbml):
//   ArtifactVersion  ↔ student_artifact_versions (model image + paired
//                      explanation artifact, one row per version_number —
//                      earlier versions are kept, never overwritten)
//   analysis fields  ↔ individual_student_reports (needs new fields — see
//                      the hand-off notes for this feature)
// Only Jordan P.'s latest Mechanistic Model has a real scanned image; every
// other version is a text description of the drawing, rendered as a
// clearly-marked placeholder rather than a fake picture.
// ---------------------------------------------------------------------------

type ArtifactVersion = {
  versionNumber: number
  submittedAt: string
  modelImage?: string
  // Plain-language description of the drawing. Shown in place of the image
  // when there's no scan yet, and used as the image's alt text when there is.
  modelDescription: string
  explanation: string
}

// `uncertain` marks ideas the work only hints at — "do not present uncertain
// inferences as established misconceptions" — so they're shown as worth
// checking with the student rather than as findings.
type PotentialMisconception = {
  idea: string
  evidence: string
  uncertain?: boolean
}

type StudentModelWork = {
  versions: ArtifactVersion[]
  changesInUnderstanding: string[]
  potentialMisconceptions: PotentialMisconception[]
}

type IndividualStudentReport = {
  studentName: string
  models: Record<ModelTab, StudentModelWork>
}

const individualStudentReports: IndividualStudentReport[] = [
  {
    studentName: 'Jordan P.',
    models: {
      descriptive: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 1, 10:12 AM',
            modelDescription:
              'Single scene: a forest with flames and smoke above the ground, a thin brown “ground” line, and snow drawn on one side. No labels for peat or permafrost.',
            explanation:
              'My model shows a forest fire in the Arctic. There is smoke going up into the air and snow nearby because it is cold there.',
          },
          {
            versionNumber: 2,
            submittedAt: 'Oct 1, 10:41 AM',
            modelDescription:
              'Same scene split into Summer/Fall, Winter, and Spring panels. Labels added for peat, permafrost, snow, and smoke/CO₂. A burn scar is marked in the Spring panel.',
            explanation:
              'I split my model into seasons. Under the ground there is peat and permafrost. In winter there is snow on top. In spring there is a burn scar where last year’s fire was, and smoke and CO₂ go up into the atmosphere.',
          },
        ],
        changesInUnderstanding: [
          'Now includes what’s below the surface — peat and permafrost are drawn and labeled (Version 2).',
          'Seasonal panels and the Spring burn scar let the model show the fire returning to the same place.',
        ],
        potentialMisconceptions: [
          {
            idea: 'Ice, soil, and peat may not be distinguished from one another',
            evidence: 'All three are drawn as one brown underground band in Version 2.',
            uncertain: true,
          },
        ],
      },
      mechanistic: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 3, 9:58 AM',
            modelDescription:
              'Seasonal panels with an arrow from “fire” up to “smoke”. The fire is drawn only above ground in Summer and Spring; the Winter panel is snow with no fire.',
            explanation:
              'The fire burns in summer and makes smoke. In winter it’s too cold so there is just snow. Then in spring the fire comes back in the same place.',
          },
          {
            versionNumber: 2,
            submittedAt: 'Oct 3, 10:22 AM',
            modelDescription:
              'Adds a red zig-zag line underground connecting the Summer and Spring fires beneath the Winter snow. Smoke/CO₂ arrows now rise from the Winter panel too.',
            explanation:
              'I think the fire doesn’t actually go out in winter. It moves underground into the peat and keeps burning under the snow, and then it comes back up in spring. That’s why it is in the same place.',
          },
          {
            versionNumber: 3,
            submittedAt: 'Oct 3, 10:47 AM',
            modelImage: ZOMBIE_FIRES_STUDENT_MODEL_IMAGE,
            modelDescription:
              'Seasonal diagram (Summer/Fall, Winter, Spring) showing the fire moving underground as permafrost thaws, an underground fire in peat/permafrost labeled (matter) and (energy), smoke/CO₂ labeled (matter) rising in every season, and a burn scar from the previous season.',
            explanation:
              'My model shows the fire moving underground into the peat as the permafrost thaws. During winter, I think the fire keeps burning in the peat underneath the snow and ice, and then it can come back to the surface in spring. I labeled the peat and permafrost as matter and the fire as energy, and drew arrows from both of them up into the smoke and CO₂ leaving through the atmosphere.',
          },
        ],
        changesInUnderstanding: [
          'Shifted from “the fire goes out in winter” (Version 1) to “it keeps burning underground in the peat” — the core zombie-fire mechanism.',
          'Links thawing permafrost to the fire moving underground, a new cause-and-effect relationship (Version 3).',
          'Shows matter (peat → smoke/CO₂) entering the atmosphere in every season, not only when flames are visible.',
        ],
        potentialMisconceptions: [
          {
            idea: 'Treats fire as “energy” rather than a process that releases energy from peat',
            evidence: 'Version 3 labels “Fire (energy)”; the explanation says “the fire as energy.”',
          },
          {
            idea: 'Unsure whether ice and soil count as matter',
            evidence: 'Version 3 asks “Ice? Soil? Peat? (matter?)” without answering it.',
          },
          {
            idea: 'No account of what supplies oxygen to the underground fire',
            evidence: 'Not addressed in the model or explanation — may simply not have been considered yet.',
            uncertain: true,
          },
        ],
      },
    },
  },
  {
    studentName: 'Carlos M.',
    models: {
      descriptive: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 1, 10:09 AM',
            modelDescription: 'Flames and smoke rising from a flat ground line, with snow drawn to the side. Nothing is drawn below the ground.',
            explanation: 'I just drew flames and smoke coming from the ground without showing what was happening underneath.',
          },
          {
            versionNumber: 2,
            submittedAt: 'Oct 1, 10:36 AM',
            modelDescription: 'Adds a brown layer under the ground line labeled “peat” and a lighter layer below it labeled “frozen ground.” Smoke is labeled “smoke + CO₂.”',
            explanation: 'I added the peat and the frozen ground under the fire. The smoke has CO₂ in it that goes into the air.',
          },
        ],
        changesInUnderstanding: [
          'Adds peat and frozen ground (permafrost) below the surface, making the underground system visible.',
          'Labels smoke as containing CO₂ — a first sign of noticing what matter leaves the system.',
        ],
        potentialMisconceptions: [
          {
            idea: 'Relationship between snow, peat, and fire isn’t shown',
            evidence: 'In Version 2 the snow is still drawn off to the side rather than on top of the peat layer.',
            uncertain: true,
          },
        ],
      },
      mechanistic: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 3, 10:02 AM',
            modelDescription: 'Two separate fires — one labeled “summer fire,” one labeled “new fire (spring)” — with a large snow panel between them. No connection is drawn between the fires.',
            explanation: 'I think the winter fire goes out, and then a different fire starts in the same spot later because it gets hot and dry again.',
          },
          {
            versionNumber: 2,
            submittedAt: 'Oct 3, 10:30 AM',
            modelDescription: 'A dashed red line now runs under the snow panel connecting the summer and spring fires, labeled “heat underground.” The fires are still labeled as two separate fires.',
            explanation: 'I drew a line under the snow because there is still heat underground. The fire goes out in winter but the leftover heat makes it start again in the spring in the same spot.',
          },
        ],
        changesInUnderstanding: [
          'The drawing now connects the two fires underground — something persists between seasons.',
          'The explanation hasn’t changed in the same way: the fire still “goes out” and restarts, so the drawing may overstate the change in reasoning.',
        ],
        potentialMisconceptions: [
          {
            idea: 'Fire goes out in winter and a new fire starts in spring',
            evidence: 'Version 2: “The fire goes out in winter but the leftover heat makes it start again.”',
          },
          {
            idea: 'Carbon released isn’t traced back to the peat',
            evidence: 'Smoke/CO₂ appears above the fires, but neither version connects it to the peat being burned.',
          },
          {
            idea: 'May think of “heat” as a substance stored in the ground',
            evidence: 'The dashed line is labeled “heat underground” — possibly shorthand; worth asking.',
            uncertain: true,
          },
        ],
      },
    },
  },
  {
    studentName: 'Priya S.',
    models: {
      descriptive: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 1, 10:15 AM',
            modelDescription: 'Snow layer on top, a single orange underground band labeled “fire part,” and smoke rising through the snow.',
            explanation: 'I drew the snow on top and the fire underneath it, connected with a note saying the fire keeps going all winter. I didn’t really separate the peat from the fire.',
          },
          {
            versionNumber: 2,
            submittedAt: 'Oct 1, 10:44 AM',
            modelDescription: 'The underground band is split into a brown “peat” layer with orange glowing spots inside it labeled “fire (smoldering).” Snow on top, smoke/CO₂ rising.',
            explanation: 'Now the peat is its own layer and the fire is inside the peat, smoldering. The snow is on top the whole winter.',
          },
        ],
        changesInUnderstanding: [
          'Draws peat and fire as separate components, with the fire located inside the peat.',
          'Introduces “smoldering” to distinguish the underground fire from flames above ground.',
        ],
        potentialMisconceptions: [],
      },
      mechanistic: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 3, 10:05 AM',
            modelDescription: 'Arrow from “fire part” to “smoke” across three seasonal panels. Peat is not labeled separately.',
            explanation: 'The fire part keeps burning all winter and makes smoke. In spring it comes back up.',
          },
          {
            versionNumber: 2,
            submittedAt: 'Oct 3, 10:24 AM',
            modelDescription: 'Peat drawn as its own layer with the smoldering fire inside. An arrow goes from fire → smoke/CO₂.',
            explanation: 'The fire burns inside the peat all winter under the snow. The fire makes smoke and CO₂ that go up through the snow.',
          },
          {
            versionNumber: 3,
            submittedAt: 'Oct 3, 10:51 AM',
            modelDescription: 'Adds an arrow from peat → fire labeled “fuel,” and a “less peat” label in the Spring panel. Fire → smoke/CO₂ arrow unchanged.',
            explanation: 'The peat is the fuel for the fire, so the fire uses up the peat as it burns all winter. That’s why there is less peat in the spring. The fire makes smoke and CO₂ that go up into the atmosphere.',
          },
        ],
        changesInUnderstanding: [
          'Now describes peat as fuel that is used up as it burns, rather than treating peat and fire as one thing.',
          'The “less peat” label in Spring suggests she’s beginning to track matter leaving the biosphere over time.',
        ],
        potentialMisconceptions: [
          {
            idea: 'CO₂ is described as coming “from the fire” rather than from the peat',
            evidence: 'Version 3: “The fire makes smoke and CO₂.” May be shorthand, since she already says the peat is used up.',
            uncertain: true,
          },
        ],
      },
    },
  },
  {
    studentName: 'Emma K.',
    models: {
      descriptive: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 1, 10:20 AM',
            modelDescription: 'Ground line with snow on top and a small fire icon next to a tree. Smoke rising. Labels: “snow,” “fire,” “smoke.”',
            explanation: 'Zombie fires burn underground in the winter and start again in spring. They make smoke.',
          },
        ],
        changesInUnderstanding: [],
        potentialMisconceptions: [
          {
            idea: 'Underground components (peat, permafrost) are not represented',
            evidence: 'Only snow, fire, and smoke are labeled; the fire is drawn above ground though the explanation says it burns underground.',
          },
        ],
      },
      mechanistic: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Oct 3, 10:08 AM',
            modelDescription: 'Two panels: “Winter” (snow, no fire) and “Spring” (fire, smoke). An arrow labeled “dries out” points from Winter to Spring.',
            explanation: 'A new fire probably starts in spring once things dry out again.',
          },
          {
            versionNumber: 2,
            submittedAt: 'Oct 3, 10:33 AM',
            modelDescription: 'Same two panels. A small fire icon is added under the snow in the Winter panel. The “dries out” arrow is still there.',
            explanation: 'The fire keeps burning underground in the winter and then comes back in spring when things dry out.',
          },
        ],
        changesInUnderstanding: [
          'Now states the fire continues underground in winter, which Version 1 didn’t.',
          'The drawing changed only slightly and the “dries out” cause remains — the new sentence may be adopted wording rather than changed reasoning. Worth asking her to explain it in her own words.',
        ],
        potentialMisconceptions: [
          {
            idea: 'Spring fire is attributed to drying out, not to the fire that persisted underground',
            evidence: 'The “dries out” arrow is still the only causal link in Version 2.',
          },
          {
            idea: 'Matter and energy flow are not yet represented',
            evidence: 'Neither version identifies what burns or where the smoke’s matter comes from.',
          },
        ],
      },
    },
  },
]

const individualStudentReportsByName: Record<string, IndividualStudentReport> = Object.fromEntries(
  individualStudentReports.map((report) => [report.studentName, report]),
)

// Everyone who appears anywhere in Class Summary evidence for this
// assignment — the prototype's stand-in for the class roster. A real
// backend would scope this to the signed-in teacher's class via
// students.feedback_page_id.
const assignmentStudentRoster: string[] = Array.from(
  new Set(Object.values(allPatternRows).flatMap((row) => row.students.map((student) => student.name))),
).sort((a, b) => a.localeCompare(b))

// A searchable dropdown (ARIA combobox) over the assignment roster. Typing
// filters by name; arrow keys + Enter pick a student; Escape closes.
function StudentSearchSelect({
  students,
  selectedStudent,
  onSelect,
}: {
  students: readonly string[]
  selectedStudent: string | null
  onSelect: (name: string) => void
}) {
  const [query, setQuery] = useState(selectedStudent ?? '')
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  // When the box still shows the selected name, opening it should list
  // everyone, not just that one student.
  const normalizedQuery = query.trim().toLowerCase()
  const filteredStudents =
    !normalizedQuery || query === selectedStudent
      ? students
      : students.filter((name) => name.toLowerCase().includes(normalizedQuery))

  const choose = (name: string) => {
    onSelect(name)
    setQuery(name)
    setIsOpen(false)
  }

  return (
    <div className="student-search">
      <label htmlFor="student-search-input">
        <span>Select a student</span>
      </label>
      <input
        id="student-search-input"
        type="text"
        role="combobox"
        aria-expanded={isOpen}
        aria-controls="student-search-listbox"
        aria-autocomplete="list"
        aria-activedescendant={isOpen && filteredStudents[activeIndex] ? `student-option-${activeIndex}` : undefined}
        placeholder="Search students by name..."
        value={query}
        autoComplete="off"
        onFocus={(event) => {
          event.target.select()
          setIsOpen(true)
          setActiveIndex(0)
        }}
        onBlur={() => {
          setIsOpen(false)
          setQuery(selectedStudent ?? '')
        }}
        onChange={(event) => {
          setQuery(event.target.value)
          setIsOpen(true)
          setActiveIndex(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setIsOpen(true)
            setActiveIndex((index) => Math.min(index + 1, filteredStudents.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            setActiveIndex((index) => Math.max(index - 1, 0))
          } else if (event.key === 'Enter' && isOpen && filteredStudents[activeIndex]) {
            event.preventDefault()
            choose(filteredStudents[activeIndex])
          } else if (event.key === 'Escape') {
            setIsOpen(false)
          }
        }}
      />
      {isOpen && (
        <div className="standards-suggestions student-search-listbox" id="student-search-listbox" role="listbox">
          {filteredStudents.length === 0 ? (
            <p className="standards-empty">No students match “{query.trim()}”.</p>
          ) : (
            filteredStudents.map((name, index) => {
              const report = individualStudentReportsByName[name]
              const revisionCount = report
                ? Object.values(report.models).reduce((total, model) => total + model.versions.length - 1, 0)
                : 0
              return (
                <button
                  key={name}
                  id={`student-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={name === selectedStudent}
                  tabIndex={-1}
                  className={`standard-suggestion student-search-option${index === activeIndex ? ' active' : ''}`}
                  // mousedown, not click — fires before the input's blur
                  // closes the list.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(name)
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className="standard-suggestion-code">{name}</span>
                  <span className="standard-suggestion-description">
                    {report
                      ? `${revisionCount} ${revisionCount === 1 ? 'revision' : 'revisions'} across both models`
                      : 'No individual report yet'}
                  </span>
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

// Full-screen view of one model drawing so a teacher can read the student's
// handwriting. Escape or a click outside the image closes it.
function ArtifactImageLightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div className="artifact-lightbox" role="dialog" aria-modal="true" aria-label={alt} onClick={onClose}>
      <button type="button" className="artifact-lightbox-close" aria-label="Close enlarged model" onClick={onClose}>
        ×
      </button>
      <img src={src} alt={alt} onClick={(event) => event.stopPropagation()} />
    </div>
  )
}

// One submitted version: the model drawing, the explanation it was
// submitted with, and when/after what. `versionOptions` adds a version
// picker to the header when there are more versions to choose between.
function ArtifactVersionCard({
  studentName,
  modelTab,
  heading,
  version,
  versionOptions,
  onVersionChange,
  onExpandImage,
}: {
  studentName: string
  modelTab: ModelTab
  heading: string
  version: ArtifactVersion
  versionOptions?: readonly ArtifactVersion[]
  onVersionChange?: (versionNumber: number) => void
  onExpandImage: (src: string, alt: string) => void
}) {
  const imageAlt = `${studentName}'s ${modelTabLabels[modelTab]}, Version ${version.versionNumber}: ${version.modelDescription}`
  return (
    <article className="artifact-version-card">
      <header className="artifact-version-header">
        <div>
          <p className="card-label">{heading}</p>
          {versionOptions && versionOptions.length > 1 && onVersionChange ? (
            <select
              className="artifact-version-select"
              aria-label={`${heading} version`}
              value={version.versionNumber}
              onChange={(event) => onVersionChange(Number(event.target.value))}
            >
              {versionOptions.map((option) => (
                <option key={option.versionNumber} value={option.versionNumber}>
                  Version {option.versionNumber}
                </option>
              ))}
            </select>
          ) : (
            <h4>Version {version.versionNumber}</h4>
          )}
        </div>
        <p className="artifact-version-meta">{version.submittedAt}</p>
      </header>

      {version.modelImage ? (
        <button
          type="button"
          className="artifact-image-button"
          aria-label={`Enlarge ${studentName}'s Version ${version.versionNumber} model`}
          onClick={() => onExpandImage(version.modelImage!, imageAlt)}
        >
          <img src={version.modelImage} alt={imageAlt} className="student-artifact-image" />
          <span className="artifact-image-expand-hint">⤢ Click to enlarge</span>
        </button>
      ) : (
        <div className="artifact-image-placeholder" role="img" aria-label={imageAlt}>
          <span className="artifact-placeholder-tag">Mock artifact — image not available</span>
          <p>{version.modelDescription}</p>
        </div>
      )}

      <div className="artifact-explanation">
        <p className="card-label">Written explanation</p>
        <p className="student-quote">&ldquo;{version.explanation}&rdquo;</p>
      </div>
    </article>
  )
}

// Everything under one model-type tab: initial and revised work side by side
// (the main focus), then a short AI analysis (secondary). Keyed by student +
// tab by its parent, so switching either resets to the latest revision.
function StudentModelWorkView({
  studentName,
  modelTab,
  work,
}: {
  studentName: string
  modelTab: ModelTab
  work: StudentModelWork
}) {
  const { versions } = work
  const initialVersion = versions[0]
  const latestVersion = versions[versions.length - 1]
  const revisions = versions.slice(1)

  const [revisedVersion, setRevisedVersion] = useState(latestVersion.versionNumber)
  const [expandedImage, setExpandedImage] = useState<{ src: string; alt: string } | null>(null)

  const cardProps = {
    studentName,
    modelTab,
    onExpandImage: (src: string, alt: string) => setExpandedImage({ src, alt }),
  }

  return (
    <div className="student-model-work">
      <div className="artifact-compare-grid" aria-label="Student artifacts">
        <ArtifactVersionCard {...cardProps} heading="Initial" version={initialVersion} />
        {revisions.length > 0 ? (
          <ArtifactVersionCard
            {...cardProps}
            heading="Revised"
            version={revisions.find((version) => version.versionNumber === revisedVersion) ?? latestVersion}
            versionOptions={revisions}
            onVersionChange={setRevisedVersion}
          />
        ) : (
          <div className="artifact-version-card artifact-version-empty">
            <p className="card-label">Revised</p>
            <p className="empty-state-support">{studentName} hasn’t submitted a revision of this model yet.</p>
          </div>
        )}
      </div>

      <section className="student-ai-analysis" aria-label="AI Analysis">
        <div className="student-report-subheader">
          <h4>AI Analysis</h4>
          <span className="badge">AI-generated</span>
        </div>
        <div className="analysis-columns">
          <div className="analysis-block">
            <p className="analysis-block-title">Changes in Understanding</p>
            {work.changesInUnderstanding.length === 0 ? (
              <p className="empty-state-support">No revision yet, so there’s nothing to compare.</p>
            ) : (
              <ul className="analysis-list">
                {work.changesInUnderstanding.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="analysis-block">
            <p className="analysis-block-title">Potential Misconceptions</p>
            {work.potentialMisconceptions.length === 0 ? (
              <p className="empty-state-support">None identified in the latest submission.</p>
            ) : (
              <ul className="analysis-list misconception-list">
                {work.potentialMisconceptions.map((item) => (
                  <li key={item.idea}>
                    <span className="misconception-idea">{item.idea}</span>
                    {item.uncertain && <span className="tag misconception-uncertain-tag">Uncertain — check with student</span>}
                    <span className="misconception-evidence">{item.evidence}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {expandedImage && (
        <ArtifactImageLightbox src={expandedImage.src} alt={expandedImage.alt} onClose={() => setExpandedImage(null)} />
      )}
    </div>
  )
}

function IndividualStudentReportView({ report }: { report: IndividualStudentReport }) {
  const [modelTab, setModelTab] = useState<ModelTab>('descriptive')

  return (
    <div className="student-report">
      <div className="student-report-heading">
        <h4>{report.studentName}</h4>
        <span className="tag mock-data-tag">Prototype mock data</span>
      </div>

      <div className="planning-tabs" role="tablist" aria-label="Model type">
        {(Object.keys(modelTabLabels) as ModelTab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={modelTab === tab}
            className={`planning-tab ${modelTab === tab ? 'active' : ''}`}
            onClick={() => setModelTab(tab)}
          >
            {modelTabLabels[tab]}
          </button>
        ))}
      </div>

      <StudentModelWorkView
        key={`${report.studentName}-${modelTab}`}
        studentName={report.studentName}
        modelTab={modelTab}
        work={report.models[modelTab]}
      />
    </div>
  )
}

// Collapsed by default so it doesn't lengthen the page for teachers who
// only want the class-level view.
function StudentReportsSection() {
  const [isExpanded, setIsExpanded] = useState(false)
  const [selectedStudent, setSelectedStudent] = useState<string | null>(null)
  const selectedReport = selectedStudent ? individualStudentReportsByName[selectedStudent] : undefined

  return (
    <section className="report-panel student-reports-panel" aria-labelledby="student-reports-title">
      <div className="panel-header compact student-reports-header">
        <div>
          <h3 id="student-reports-title">Individual Student Reports</h3>
          <p className="empty-state-support student-reports-subtitle">
            Explore individual students’ artifacts, learning development, and misconceptions.
          </p>
        </div>
        <button
          type="button"
          className={isExpanded ? 'secondary-button' : 'primary-button'}
          aria-expanded={isExpanded}
          aria-controls="student-reports-body"
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? 'Hide Student Reports' : 'View Student Reports'}
        </button>
      </div>

      {isExpanded && (
        <div className="student-reports-body" id="student-reports-body">
          <StudentSearchSelect
            students={assignmentStudentRoster}
            selectedStudent={selectedStudent}
            onSelect={setSelectedStudent}
          />

          {!selectedStudent && (
            <p className="empty-state-support">Select a student to see their report.</p>
          )}
          {selectedStudent && !selectedReport && (
            <p className="empty-state-support student-report-unavailable">
              No individual report is available for {selectedStudent} in this prototype’s mock data yet. Their
              class-level evidence still appears in Class Summary below.
            </p>
          )}
          {selectedReport && <IndividualStudentReportView key={selectedReport.studentName} report={selectedReport} />}
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Class Feedback: Practice-Oriented Learning Objectives
//
// The Class Summary reads students' submitted work against the lesson's
// practice-oriented learning objectives — each learning objective together
// with the science practices it asks students to use. The analysis model
// gets the lesson context and the class-level patterns already found in the
// submissions (labels, counts, and where they came from — never student
// names or work), and returns two sections: where the work overlaps the
// objectives, and where there's room for improvement.
// ---------------------------------------------------------------------------

// The lesson the Class Feedback page is about, from its lesson plan.
type ClassFeedbackLessonContext = {
  lessonTitle: string
  topic: string
  gradeLevel: string
  practices: string[]
  // "1.A Obtain information..." — prefix and text, in lesson order.
  objectives: string[]
}

function lessonContextFor(lesson: LibraryLesson): ClassFeedbackLessonContext {
  const document = lesson.lessonPlan.document ?? (lesson.lessonPlan.hasDemoContent ? demoLessonDocument : undefined)
  const savedPractices = practiceOptions.filter((practice) => lesson.sciencePractices.includes(practice.id)).map((practice) => practice.label)
  if (!document) {
    return { lessonTitle: lesson.title, topic: lesson.topic, gradeLevel: formatLessonGrade(lesson.grade), practices: savedPractices, objectives: [] }
  }
  const stepText = (label: string) => segmentsToText(document.steps.find((step) => step.label === label)?.segments ?? []).trim()
  return {
    lessonTitle: lesson.title,
    topic: stepText('Topic') || lesson.topic,
    gradeLevel: stepText('Grade Level') || formatLessonGrade(lesson.grade),
    practices: [...document.practices],
    objectives: document.steps
      .filter((step) => step.label.startsWith('Learning Objective'))
      .map((step) => `${step.displayPrefix ? `${step.displayPrefix} ` : ''}${segmentsToText(step.segments).trim()}`),
  }
}

// Lessons whose student submissions have been analyzed (the prototype's
// demo class data belongs to its demo lesson).
const analyzedClassFeedbackLessonIds = ['climate-carbon-cycle']

type ClassSummaryFinding = {
  objectiveIndex: number
  practices: string[]
  summary: string
  nextStep?: string
  patternIds: string[]
}

type ClassSummaryOutput = { overlap: ClassSummaryFinding[]; areasForImprovement: ClassSummaryFinding[] }

const classSummaryInstructions = [
  'You analyze one class’s submitted science work (models and written explanations) for the lesson in "lesson".',
  'A practice-oriented learning objective is one of lesson.learningObjectives read together with the science practices it asks students to use (from lesson.sciencePractices). Judge the work by what students do with those practices — modeling, explaining, questioning, reasoning from evidence — not only by the content they mention.',
  'Use only the class-level patterns in "patterns"; never invent student work. Refer to students by count, never by name.',
  'overlap: for each objective, the patterns showing students demonstrating its targeted practices, strongest first, and a one-sentence summary of what that work shows students doing.',
  'areasForImprovement: for each objective, the patterns showing gaps — missing or incomplete practice moves, difficulties, or misconceptions — a one-sentence summary of the gap, and nextStep: one concrete instructional move.',
  'Group findings by objective in lesson order (objectiveIndex is 0-based), list the practices each finding concerns, and leave an objective out of a section when no pattern supports it.',
].join('\n')

const classSummarySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['overlap', 'areasForImprovement'],
  properties: Object.fromEntries(
    (['overlap', 'areasForImprovement'] as const).map((section) => [
      section,
      {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['objectiveIndex', 'practices', 'summary', 'patternIds', ...(section === 'areasForImprovement' ? ['nextStep'] : [])],
          properties: {
            objectiveIndex: { type: 'integer', minimum: 0 },
            practices: { type: 'array', items: { type: 'string' } },
            summary: { type: 'string' },
            ...(section === 'areasForImprovement' ? { nextStep: { type: 'string' } } : {}),
            patternIds: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    ]),
  ),
} as const

type ClassSummaryPatternInput = { id: string; label: string; studentCount: number; source: string }

// Every analyzed pattern, without student evidence.
const classSummaryPatterns: ClassSummaryPatternInput[] = [
  ...learningObjectiveOverlap.flatMap((group) =>
    group.ideas.map((row) => ({ id: row.id, label: row.label, studentCount: row.count, source: `Responses to objective ${group.objective.split(' ')[0]}` })),
  ),
  ...scienceInPracticePatterns.flatMap((group) =>
    group.patterns.map((row) => ({ id: row.id, label: row.label, studentCount: row.count, source: `Practice: ${group.practice}` })),
  ),
  ...misconceptionPatterns.map((row) => ({ id: row.id, label: row.label, studentCount: row.count, source: 'Misconceptions across responses and models' })),
]

// Stands in for the analysis model: its reading of each demo pattern —
// which objective it speaks to and whether it shows the targeted practice
// or a gap — plus the summaries it would write.
const mockClassSummaryJudgments: Record<string, { objective: number; finding: 'overlap' | 'improvement' }> = {
  'lo1a-permafrost-thawing': { objective: 0, finding: 'overlap' },
  'lo1a-earlier-spring-fires': { objective: 0, finding: 'overlap' },
  'lo1a-no-mechanism': { objective: 0, finding: 'improvement' },
  'misconception-common-everywhere': { objective: 0, finding: 'improvement' },
  'practice-models-system-components': { objective: 1, finding: 'overlap' },
  'lo1b-underground-persists': { objective: 1, finding: 'overlap' },
  'practice-models-matter-energy-flows': { objective: 1, finding: 'overlap' },
  'lo1b-matter-energy-labeled': { objective: 1, finding: 'overlap' },
  'practice-models-seasonal-change': { objective: 1, finding: 'overlap' },
  'lo1b-above-ground-only': { objective: 1, finding: 'improvement' },
  'misconception-no-matter-energy-distinction': { objective: 1, finding: 'improvement' },
  'misconception-new-fire-each-spring': { objective: 1, finding: 'improvement' },
  'lo1c-human-role': { objective: 2, finding: 'overlap' },
  'lo1c-carbon-amount': { objective: 2, finding: 'overlap' },
  'lo1c-restated-fact': { objective: 2, finding: 'improvement' },
}

const mockClassSummaryText: Record<number, { overlap: string; improvement: string; nextStep: string }> = {
  0: {
    overlap: 'Students obtained information from the images and readings and used it to reason about cause and effect, linking warming and thawing permafrost to fires that keep burning.',
    improvement: 'Some students noticed that zombie fires are unusual without using the evidence to name a cause, or generalized them to every wildfire.',
    nextStep: 'Have these students pick one piece of evidence and complete “This happens because…” before revising their models.',
  },
  1: {
    overlap: 'Most models include the key parts of the system and use arrows to show matter and energy moving to the atmosphere, often across seasons.',
    improvement: 'Some models show the fire only above ground or don’t separate matter (peat) from energy (fire), so the model can’t yet explain how the fire persists.',
    nextStep: 'Ask students to label each part of their model as matter or energy and add what happens underground in winter.',
  },
  2: {
    overlap: 'Many students asked testable questions about human influence and how much carbon the fires release.',
    improvement: 'A few students restated facts instead of asking a question that would move the investigation forward.',
    nextStep: 'Model turning one known fact into a “What would happen if…?” question for the Driving Question Board.',
  },
}

// The practices an objective asks for: any lesson practice whose key word
// appears in the objective.
function practicesForObjective(objective: string, practices: readonly string[]): string[] {
  const text = objective.toLowerCase()
  return practices.filter((practice) =>
    practice
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((word) => word.length >= 5)
      .some((word) => text.includes(word.slice(0, 5))),
  )
}

function mockClassSummaryReply(request: { lesson: ClassFeedbackLessonContext; patterns: ClassSummaryPatternInput[] }): string {
  const { lesson, patterns } = request
  const findings = (finding: 'overlap' | 'improvement'): ClassSummaryFinding[] =>
    lesson.objectives.flatMap((objective, objectiveIndex) => {
      const patternIds = patterns
        .filter((pattern) => mockClassSummaryJudgments[pattern.id]?.objective === objectiveIndex && mockClassSummaryJudgments[pattern.id].finding === finding)
        .sort((a, b) => b.studentCount - a.studentCount)
        .map((pattern) => pattern.id)
      const text = mockClassSummaryText[objectiveIndex]
      if (patternIds.length === 0 || !text) return []
      return [
        {
          objectiveIndex,
          practices: practicesForObjective(objective, lesson.practices),
          summary: finding === 'overlap' ? text.overlap : text.improvement,
          ...(finding === 'improvement' ? { nextStep: text.nextStep } : {}),
          patternIds,
        },
      ]
    })
  return JSON.stringify({ overlap: findings('overlap'), areasForImprovement: findings('improvement') })
}

function readClassSummaryOutput(raw: string): ClassSummaryOutput {
  const empty: ClassSummaryOutput = { overlap: [], areasForImprovement: [] }
  let data: Record<string, unknown>
  try {
    data = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return empty
  }
  const list = (value: unknown): ClassSummaryFinding[] =>
    (Array.isArray(value) ? value : [])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        objectiveIndex: typeof item.objectiveIndex === 'number' ? item.objectiveIndex : -1,
        practices: Array.isArray(item.practices) ? item.practices.filter((value): value is string => typeof value === 'string') : [],
        summary: typeof item.summary === 'string' ? item.summary : '',
        nextStep: typeof item.nextStep === 'string' ? item.nextStep : undefined,
        // Only patterns that were actually found in the submissions.
        patternIds: Array.isArray(item.patternIds) ? item.patternIds.filter((id): id is string => typeof id === 'string' && id in allPatternRows) : [],
      }))
      .filter((item) => item.objectiveIndex >= 0 && item.patternIds.length > 0)
  return { overlap: list(data.overlap), areasForImprovement: list(data.areasForImprovement) }
}

function analyzeClassSummary(lesson: ClassFeedbackLessonContext): ClassSummaryOutput {
  const raw = callAiModel(
    'class-feedback-summary',
    { instructions: classSummaryInstructions, responseSchema: classSummarySchema, lesson, patterns: classSummaryPatterns },
    (request) => mockClassSummaryReply(request),
  )
  return readClassSummaryOutput(raw)
}

function FeedbackDashboardPage({ lesson }: { lesson: LibraryLesson }) {
  // The lesson this page is about, and the class summary of its submitted
  // work (only lessons whose submissions have been analyzed have one).
  const [lessonContext] = useState(() => lessonContextFor(lesson))
  const [classSummary] = useState(() =>
    analyzedClassFeedbackLessonIds.includes(lesson.id) ? analyzeClassSummary(lessonContext) : null,
  )
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(defaultPatternId)
  const [facilitationQuestions, setFacilitationQuestions] = useState<FacilitationQuestion[]>(() =>
    classSummary ? generateFacilitationQuestions(lessonContext, classSummary, []) : [],
  )
  const [isRegeneratingQuestions, setIsRegeneratingQuestions] = useState(false)

  // The last two sets shown, so a regenerated set is new; older ones can
  // come back once the ideas run out.
  const recentQuestionsRef = useRef<string[]>(facilitationQuestions.map((question) => question.text))
  const regenerationTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (regenerationTimeoutRef.current !== null) window.clearTimeout(regenerationTimeoutRef.current)
    }
  }, [])

  const selectedPattern = selectedPatternId ? allPatternRows[selectedPatternId] : undefined

  const regenerateFacilitationQuestions = () => {
    setIsRegeneratingQuestions(true)
    regenerationTimeoutRef.current = window.setTimeout(() => {
      if (classSummary) {
        const next = generateFacilitationQuestions(lessonContext, classSummary, recentQuestionsRef.current)
        recentQuestionsRef.current = [...recentQuestionsRef.current, ...next.map((question) => question.text)].slice(-12)
        setFacilitationQuestions(next)
      }
      setIsRegeneratingQuestions(false)
    }, 900)
  }

  const [deeperChatMessages, setDeeperChatMessages] = useState<ChatMessage[]>([])
  const [deeperChatDraft, setDeeperChatDraft] = useState('')
  const deeperChatInputRef = useRef<HTMLInputElement>(null)
  const [isDeeperAiThinking, setIsDeeperAiThinking] = useState(false)
  // What Deeper AI Analysis answers class-wide questions from.
  const classAnalysisForAi: ClassAnalysisForAi | null = classSummary && {
    overlap: classSummary.overlap.map((finding) => ({
      objective: lessonContext.objectives[finding.objectiveIndex] ?? `Objective ${finding.objectiveIndex + 1}`,
      practices: finding.practices,
      summary: finding.summary,
      patterns: finding.patternIds.map((id) => classAnalysisPattern(allPatternRows[id])),
    })),
    areasForImprovement: classSummary.areasForImprovement.map((finding) => ({
      objective: lessonContext.objectives[finding.objectiveIndex] ?? `Objective ${finding.objectiveIndex + 1}`,
      practices: finding.practices,
      summary: finding.summary,
      nextStep: finding.nextStep,
      patterns: finding.patternIds.map((id) => classAnalysisPattern(allPatternRows[id])),
    })),
  }
  const [focusedStudent, setFocusedStudent] = useState<StudentEvidence | null>(null)
  const deeperAiTimeoutRef = useRef<number | null>(null)
  // Student Evidence and Deeper AI Analysis are one unified, single-scroll
  // workspace (see .evidence-workspace-scroll) rather than two independently
  // scrolling panes, so this ref targets the whole workspace's scroll
  // container, not just the chat transcript.
  const evidenceWorkspaceScrollRef = useRef<HTMLDivElement | null>(null)

  // Without this, the workspace would silently stay scrolled wherever the
  // teacher left it as new messages arrive below the fold, instead of
  // following the conversation down to the composer like every other chat
  // surface in the app. Guarded to skip the empty/not-thinking case —
  // otherwise this would also fire right after the pattern-change reset
  // below (which clears deeperChatMessages to a new empty array), fighting
  // that effect's scrollTop-to-0 and leaving the workspace stuck scrolled
  // to the bottom every time the teacher picks a new pattern.
  useEffect(() => {
    if (deeperChatMessages.length === 0 && !isDeeperAiThinking) return
    const container = evidenceWorkspaceScrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [deeperChatMessages, isDeeperAiThinking])

  // A new pattern means a new context for both the student evidence shown
  // and "Deeper AI Analysis" — start the conversation over rather than
  // carrying stale answers about a different group of students into the new
  // selection, and scroll the workspace back to the top so the teacher sees
  // the new Student Evidence header/context first, not wherever the
  // previous pattern's scroll position happened to land.
  useEffect(() => {
    setDeeperChatMessages([])
    setDeeperChatDraft('')
    setIsDeeperAiThinking(false)
    setFocusedStudent(null)
    if (deeperAiTimeoutRef.current !== null) {
      window.clearTimeout(deeperAiTimeoutRef.current)
      deeperAiTimeoutRef.current = null
    }
    if (evidenceWorkspaceScrollRef.current) evidenceWorkspaceScrollRef.current.scrollTop = 0
  }, [selectedPatternId])

  useEffect(() => {
    return () => {
      if (deeperAiTimeoutRef.current !== null) window.clearTimeout(deeperAiTimeoutRef.current)
    }
  }, [])

  const askDeeperAnalysis = (question: string) => {
    const text = question.trim()
    if (!text || !selectedPattern || isDeeperAiThinking) return
    setDeeperChatMessages((prev) => [...prev, { role: 'teacher', text }])
    setDeeperChatDraft('')
    setIsDeeperAiThinking(true)
    const pattern = selectedPattern
    const student = focusedStudent
    deeperAiTimeoutRef.current = window.setTimeout(() => {
      const reply = callAiModel(
        'class-feedback-analysis',
        { pattern, question: text, focusedStudent: student, classAnalysis: classAnalysisForAi },
        (request) => mockDeeperAnalysisReply(request.pattern, request.question, request.focusedStudent, request.classAnalysis),
      )
      setDeeperChatMessages((prev) => [...prev, { role: 'ai', text: reply }])
      setIsDeeperAiThinking(false)
    }, 700)
  }

  // Clicking the comment/"Ask AI" action on one student's evidence card
  // narrows Deeper AI Analysis to that student — every subsequent reply is
  // framed around their specific response/artifact until the teacher
  // focuses someone else or picks a different Class Summary pattern.
  const focusStudentInDeeperAnalysis = (student: StudentEvidence) => {
    setFocusedStudent(student)
    setDeeperChatMessages((prev) => [...prev, { role: 'ai', text: buildStudentFocusNote(student) }])
  }

  return (
    <div className="dashboard-page">
      <section className="dashboard-task-card">
        <p className="card-label">Assignment</p>
        <h3>{dashboardTask.topic}</h3>
        <p className="dashboard-task-question">{dashboardTask.question}</p>
      </section>

      <section className="dashboard-task-card lesson-context-card" aria-labelledby="lesson-context-heading">
        <p className="card-label" id="lesson-context-heading">
          Lesson Context
        </p>
        <dl className="lesson-context-grid">
          <div>
            <dt>Lesson Topic</dt>
            <dd>{lessonContext.topic}</dd>
          </div>
          <div>
            <dt>Grade Level</dt>
            <dd>{lessonContext.gradeLevel}</dd>
          </div>
          <div className="lesson-context-wide">
            <dt>Science Practices to Emphasize</dt>
            <dd>
              {lessonContext.practices.length > 0 ? (
                <span className="context-tags">
                  {lessonContext.practices.map((practice) => (
                    <span key={practice} className="tag">
                      {practice}
                    </span>
                  ))}
                </span>
              ) : (
                'Not set for this lesson'
              )}
            </dd>
          </div>
          {lessonContext.objectives.length > 0 && (
            <div className="lesson-context-wide">
              <dt>Learning Objectives</dt>
              <dd>
                <ul className="lesson-context-objectives">
                  {lessonContext.objectives.map((objective) => (
                    <li key={objective}>{objective}</li>
                  ))}
                </ul>
              </dd>
            </div>
          )}
        </dl>
      </section>

      <div className="metrics-row">
        {metricCards.map((metric) => (
          <div key={metric.label} className="metric-card">
            <p>{metric.label}</p>
            <strong>{metric.value}</strong>
            <span>{metric.trend}</span>
          </div>
        ))}
      </div>

      <StudentReportsSection />

      <div className="report-grid">
        <section className="report-panel class-summary-panel">
          <div className="panel-header compact">
            <h3>Class Summary</h3>
          </div>

          <h4 className="practice-objectives-heading">Practice-Oriented Learning Objectives</h4>
          {classSummary ? (
            ([
              { key: 'overlap', title: 'Overlap with Practice-Oriented Learning Objectives', className: 'summary-section-objective', findings: classSummary.overlap },
              { key: 'improvement', title: 'Areas for Improvement', className: 'summary-section-misconception', findings: classSummary.areasForImprovement },
            ] as const).map((section) => (
              <div key={section.key} className={`summary-section ${section.className}`}>
                <p className="summary-section-title">{section.title}</p>
                {section.findings.length === 0 ? (
                  <p className="empty-state-support">Nothing to report from the submitted work.</p>
                ) : (
                  section.findings.map((finding) => (
                    <div key={finding.objectiveIndex} className="pattern-group">
                      <p className="pattern-group-title">
                        Learning Objective: {lessonContext.objectives[finding.objectiveIndex] ?? `Objective ${finding.objectiveIndex + 1}`}
                      </p>
                      {finding.practices.length > 0 && (
                        <p className="finding-practices">Practices: {finding.practices.join(' · ')}</p>
                      )}
                      <p className="finding-summary">{finding.summary}</p>
                      {finding.nextStep && (
                        <p className="finding-next-step">
                          <strong>Next step:</strong> {finding.nextStep}
                        </p>
                      )}
                      <div className="pattern-row-list">
                        {finding.patternIds.map((id) => (
                          <PatternRowButton
                            key={id}
                            row={allPatternRows[id]}
                            isActive={selectedPatternId === id}
                            onSelect={setSelectedPatternId}
                          />
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ))
          ) : (
            <p className="empty-state-support">No student submissions have been analyzed for this lesson yet.</p>
          )}
        </section>

        <div className="right-column">
          {/* One unified, single-scroll Student Evidence workspace — Deeper
              AI Analysis is a section within it (see .deeper-analysis-section
              below), not a second standalone card with its own scrollbar. */}
          <section
            className={`report-panel right-panel evidence-workspace-panel${selectedPattern ? ` evidence-${selectedPattern.kind}` : ''}`}
          >
            <div className="evidence-workspace-scroll" ref={evidenceWorkspaceScrollRef}>
              <div className="panel-header">
                <h3>Student Evidence</h3>
              </div>
              {selectedPattern && (
                <p className={`evidence-context-row tag evidence-tag-${selectedPattern.kind}`}>
                  {selectedPattern.label} · {selectedPattern.count} students
                </p>
              )}

              {selectedPattern ? (
                <div className="student-list">
                  {selectedPattern.students.map((student) => {
                    // Priority order is always: name, the student's own words,
                    // then their actual model. A real image IS the artifact —
                    // a text caption describing it would just restate what the
                    // teacher can already see, so the caption only renders as a
                    // fallback for students with no scanned/photographed model.
                    const responseBlock = student.response && (
                      <p className="student-quote">&ldquo;{student.response}&rdquo;</p>
                    )
                    const imageBlock = student.artifactImage && (
                      <img
                        src={student.artifactImage}
                        alt={`${student.name}'s zombie fire model`}
                        className="student-artifact-image"
                      />
                    )
                    const artifactBlock = !student.artifactImage && student.artifact && (
                      <p className="student-artifact">{student.artifact}</p>
                    )
                    return (
                      <div
                        key={student.name}
                        className={`evidence-card${focusedStudent?.name === student.name ? ' student-focused' : ''}`}
                      >
                        <div className="student-header">
                          <h4>{student.name}</h4>
                        </div>
                        {responseBlock}
                        {imageBlock}
                        {artifactBlock}
                        <div className="student-footer">
                          <button
                            type="button"
                            className="student-ask-ai-button"
                            aria-label={`Ask AI about ${student.name}'s response`}
                            onClick={() => focusStudentInDeeperAnalysis(student)}
                          >
                            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
                              <path
                                fill="currentColor"
                                d="M4 4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h1v2.5a.5.5 0 0 0 .8.4L9.33 14H16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4Z"
                              />
                            </svg>
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="empty-state-support">Select a pattern on the left to see individual student evidence.</p>
              )}

              <div className="deeper-analysis-section">
                <div className="panel-header">
                  <h3>Deeper AI Analysis</h3>
                </div>

                <p className="empty-state-support deeper-analysis-subtitle">
                  Ask follow-up questions about the selected student responses and artifacts.
                </p>

                {selectedPattern ? (
                  <div className="deeper-analysis-body">
                    <div className="deeper-analysis-chat">
                      {deeperChatMessages.length === 0 && !isDeeperAiThinking ? (
                        <p className="deeper-analysis-chat-empty">Ask a question below to start the conversation.</p>
                      ) : (
                        <ChatThread messages={deeperChatMessages} />
                      )}
                      {isDeeperAiThinking && <p className="empty-state-support">AI is analyzing these responses…</p>}
                    </div>

                    {/* Example questions: clicking one only fills the input,
                        so the teacher can edit it before sending. */}
                    <div className="deeper-analysis-suggestions" role="group" aria-label="Example questions">
                      {deeperAnalysisStarterQuestions.map((question) => (
                        <button
                          key={question}
                          type="button"
                          className="practice-chip"
                          disabled={isDeeperAiThinking}
                          onClick={() => {
                            setDeeperChatDraft(question)
                            deeperChatInputRef.current?.focus()
                          }}
                        >
                          {question}
                        </button>
                      ))}
                    </div>

                    <div className="composer-box">
                      <input
                        ref={deeperChatInputRef}
                        type="text"
                        placeholder="Ask about these student responses..."
                        value={deeperChatDraft}
                        onChange={(event) => setDeeperChatDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') askDeeperAnalysis(deeperChatDraft)
                        }}
                        disabled={isDeeperAiThinking}
                      />
                      <button
                        type="button"
                        className="send-button"
                        aria-label="Send"
                        onClick={() => askDeeperAnalysis(deeperChatDraft)}
                        disabled={isDeeperAiThinking || !deeperChatDraft.trim()}
                      >
                        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false">
                          <path
                            fill="currentColor"
                            d="M3 10a1 1 0 0 1 1-1h9.09l-3.3-3.3a1 1 0 1 1 1.42-1.4l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 0 1-1.42-1.4l3.3-3.3H4a1 1 0 0 1-1-1Z"
                          />
                        </svg>
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="empty-state-support">Select a pattern on the left to enable deeper AI analysis.</p>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>

      <section className="questions-panel">
        <div className="panel-header compact">
          <h3>Suggested Facilitation Questions</h3>
          <button
            type="button"
            className="regenerate-button"
            onClick={regenerateFacilitationQuestions}
            disabled={isRegeneratingQuestions || !classSummary}
          >
            <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true" focusable="false">
              <path
                fill="currentColor"
                d="M10 4a6 6 0 0 1 5.29 3.17.75.75 0 1 1-1.33.7A4.5 4.5 0 1 0 14.4 13h-1.65a.75.75 0 0 1 0-1.5h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-1.46A6 6 0 1 1 10 4Z"
              />
            </svg>
            Regenerate Questions
          </button>
        </div>

        {isRegeneratingQuestions ? (
          <p className="empty-state-support">Generating new questions…</p>
        ) : facilitationQuestions.length === 0 ? (
          <p className="empty-state-support">Facilitation questions will appear once this lesson’s student submissions are analyzed.</p>
        ) : (
          // One group per category, in a fixed order, so a regenerated set
          // lands under the same headings.
          <div className="question-groups">
            {facilitationCategories.map((category) => {
              const questions = facilitationQuestions.filter((question) => question.category === category)
              if (questions.length === 0) return null
              const headingId = `facilitation-${category.toLowerCase().replace(/[^a-z]+/g, '-')}`
              return (
                <section key={category} className={`question-group ${headingId}`} aria-labelledby={headingId}>
                  <h4 className="question-category" id={headingId}>
                    {category}
                  </h4>
                  <ol className="question-list">
                    {questions.map((question) => (
                      <li key={question.text}>{question.text}</li>
                    ))}
                  </ol>
                </section>
              )
            })}
          </div>
        )}
      </section>

    </div>
  )
}

export default App
