import {
  Fragment,
  useCallback,
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
import { getTeacherSession, onTeacherSessionChange, signInTeacher, signOutTeacher, type TeacherSession } from './api/auth'
import {
  createClass as createRemoteClass,
  getTeacherProfile,
  listMyClasses,
  listRosters,
  registerStudentRoster,
  type ClassRecord,
  type RosterStudent,
} from './api/classes'
import { ApiError, toApiError } from './api/core'
import { listLessonsForClasses, saveLessonVersion, saveNewLesson, type LessonFields, type StoredLesson, type VersionCreatedBy } from './api/lessonPlanning'
import { authDebug, shortId } from './lib/authDebug'
import { appMode, readStoredDemoSession, setSessionDataMode, storeDemoSession, usesSupabase } from './lib/dataSource'
import './App.css'

type PageId =
  | 'login'
  | 'class-setup'
  | 'library'
  | 'lesson-generator'
  | 'student-feedback'
  | 'class-feedback-dashboard'
  | 'student-reports'

// The lesson workspace (generated lesson, AI suggestions, revisions, Edit
// Lesson) lives inside Lesson Planning — there's no separate nav page for it.
// `title` overrides `label` for the page heading when the two differ. The
// mock Login page renders full-screen (no header or page heading), but stays
// in the nav so demos can get back to it.
// `inNav: false` pages need a lesson/class context, so they're only reached
// from other pages, never from the navigation drawer. The drawer lists the
// rest in this order. Individual Student Reports opened from the drawer
// starts with no class, lesson, or student selected.
const PAGE_CONFIG: readonly { id: PageId; label: string; title?: string; inNav?: false }[] = [
  { id: 'login', label: 'Login' },
  { id: 'class-setup', label: 'Class Setup' },
  { id: 'lesson-generator', label: 'Lesson Planning' },
  { id: 'student-feedback', label: 'Student Feedback' },
  { id: 'class-feedback-dashboard', label: 'Class Feedback' },
  { id: 'student-reports', label: 'Individual Student Reports' },
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

// Who is using the app (see AppRoot): nobody yet, the demo (Explore Demo —
// mock teacher and mock data only), or a teacher signed in with Supabase.
type AppSession = { kind: 'none' } | { kind: 'demo' } | { kind: 'teacher'; teacher: TeacherSession }

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

// The page from the URL; with none, Login — or, once someone has entered the
// prototype (a signed-in teacher or the demo), where login leads.
function getInitialPage(enteredPrototype: boolean): PageId {
  // A Student Feedback link carries its assignment after "?".
  const hash = window.location.hash.replace('#', '').split('?')[0]
  // Old links to the retired standalone Lesson Workspace page land on
  // Lesson Planning, where that workspace now lives.
  if (hash === 'lesson-workspace') return 'lesson-generator'
  // Class Setup was briefly called Class Management.
  if (hash === 'class-management') return 'class-setup'
  const match = PAGE_CONFIG.find((page) => page.id === hash)
  if (match) return match.id
  return enteredPrototype ? getPostLoginPage() : 'login'
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
  { id: 'brainstorm', label: 'Brainstorm with AI', description: 'Talk through ideas; AI suggests form content', icon: '✦' },
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

// The real hand-drawn COVID Virus example artifacts, one per model — same
// /public convention. Student Feedback shows them as the starting models
// (handleArtifactUpload swaps either one out for the student's own photo),
// and the COVID Virus Class Feedback mock uses them as one student's work.
const COVID_DESCRIPTIVE_MODEL_EXAMPLE_IMAGE = '/covid-descriptive-model-example.png'
const COVID_MECHANISTIC_MODEL_EXAMPLE_IMAGE = '/covid-mechanistic-model-example.png'

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

// COVID Virus — the Period 1 Life Science class's analyzed work for the
// lesson's one assignment and its two student products, Descriptive and Mechanistic. Mock
// data: the students are that class's roster, and Bianca S.'s models are
// the real COVID example artifacts Student Feedback starts from.
const covidDescriptivePatterns: PatternRow[] = [
  {
    id: 'covid-d-virus-structures-labeled',
    label: 'Labels the virus’s protein, fatty envelope, and genetic material',
    count: 15,
    kind: 'objective',
    students: [
      {
        name: 'Bianca S.',
        artifact: 'Labeled diagram of the coronavirus (protein, fatty envelope, genetic material) and two soap molecules (hydrophilic head, hydrophobic tail).',
        artifactImage: COVID_DESCRIPTIVE_MODEL_EXAMPLE_IMAGE,
      },
      {
        name: 'Kai D.',
        artifact: 'Coronavirus drawn as a circle with spikes labeled “protein,” an outer ring labeled “fatty envelope,” and squiggles inside labeled “genetic material.”',
      },
    ],
  },
  {
    id: 'covid-d-soap-two-ends',
    label: 'Draws the soap molecule with a hydrophilic head and a hydrophobic tail',
    count: 12,
    kind: 'objective',
    students: [
      {
        name: 'Bianca S.',
        artifactImage: COVID_DESCRIPTIVE_MODEL_EXAMPLE_IMAGE,
        artifact: 'Soap molecules with the head labeled “hydrophilic (likes water)” and the tail labeled “hydrophobic (likes fat/oil).”',
      },
      {
        name: 'Nia Y.',
        artifact: 'Soap molecule drawn as a circle with a zigzag tail; the head is labeled “likes water” and the tail “likes oil.”',
      },
    ],
  },
  {
    id: 'covid-d-fat-attraction',
    label: 'Notes that the soap’s hydrophobic tail and the virus’s fatty envelope are both associated with fat',
    count: 7,
    kind: 'objective',
    students: [
      {
        name: 'Owen F.',
        response: 'The tail of the soap likes fat, and the outside of the virus is fatty, so I drew an arrow between them.',
        artifact: 'Arrow labeled “both fatty?” from the soap tail to the virus envelope.',
      },
      { name: 'Rosa A.', response: 'The fatty envelope and the soap tail are the same kind of thing — they both like fat.' },
    ],
  },
  {
    id: 'covid-d-envelope-unlabeled',
    label: 'Draws the virus without labeling the fatty envelope',
    count: 6,
    kind: 'objective',
    students: [
      { name: 'Eli N.', artifact: 'Coronavirus with spikes labeled “protein” and inner squiggles labeled “genetic material”; the outer layer has no label.' },
      { name: 'Sam H.', artifact: 'Coronavirus drawn as a spiky ball with only “virus” written beside it.' },
    ],
  },
  {
    id: 'covid-d-ends-swapped',
    label: 'Labels the soap molecule’s hydrophilic and hydrophobic ends the wrong way around',
    count: 4,
    kind: 'misconception',
    students: [
      {
        name: 'Gabe B.',
        response: 'The head is hydrophobic because it’s the part that touches the water.',
        artifact: 'Soap molecule with the round head labeled “hydrophobic” and the tail labeled “hydrophilic.”',
      },
      { name: 'Hana I.', response: 'I think hydrophobic means it likes water, so that’s the head.' },
    ],
  },
  {
    id: 'covid-d-no-relationship',
    label: 'Draws the virus and the soap separately, without showing how their structures relate',
    count: 9,
    kind: 'objective',
    students: [
      { name: 'Isaac P.', artifact: 'Virus and soap molecule drawn on opposite sides of the page with no arrows or notes between them.' },
      { name: 'Quinn T.', response: 'I drew both parts like the directions said, but I didn’t connect them.' },
    ],
  },
]

const covidMechanisticPatterns: PatternRow[] = [
  {
    id: 'covid-m-parts-labeled',
    label: 'Labels which end of each soap molecule faces the oil and which faces the water',
    count: 8,
    kind: 'objective',
    students: [
      { name: 'Mateo R.', artifact: 'Oil droplet in the middle with soap tails labeled “tail → oil” pointing in and heads labeled “head → water” pointing out.' },
      { name: 'Willa Y.', response: 'I labeled the heads facing the water and the tails facing the oil, because that’s what each part likes.' },
    ],
  },
  {
    id: 'covid-m-single-molecule',
    label: 'Shows only one soap molecule, so many molecules working together isn’t represented',
    count: 7,
    kind: 'objective',
    students: [
      { name: 'Dana G.', artifact: 'A single soap molecule touching one oil drop, with an arrow labeled “soap cleans.”' },
      { name: 'Tariq O.', response: 'I only drew one soap because I thought one would be enough to show it.' },
    ],
  },
  {
    id: 'covid-m-soap-surrounds-oil',
    label: 'Shows soap molecules surrounding oil with their hydrophilic heads facing the water',
    count: 10,
    kind: 'objective',
    students: [
      {
        name: 'Bianca S.',
        artifact: 'Beaker of water with soap molecules clustered around three oil droplets, heads facing out — labeled “Soap traps the oil.”',
        artifactImage: COVID_MECHANISTIC_MODEL_EXAMPLE_IMAGE,
      },
      { name: 'Mateo R.', artifact: 'Oil droplet surrounded by a ring of soap molecules, tails in and heads out into the water.' },
    ],
  },
  {
    id: 'covid-m-tail-into-envelope',
    label: 'Shows the soap’s hydrophobic tail pushing into the virus’s fatty envelope',
    count: 12,
    kind: 'objective',
    students: [
      {
        name: 'Bianca S.',
        response:
          'In my model I drew the soap’s hydrophobic tail sticking into the virus’s fatty envelope, since both of those are supposed to be attracted to fat.',
      },
      { name: 'Jada W.', artifact: 'Virus envelope with several soap tails stuck into it and a crack drawn across the envelope.' },
    ],
  },
  {
    id: 'covid-m-no-water-role',
    label: 'Doesn’t show how water and the hydrophilic heads carry the trapped oil or virus away',
    count: 10,
    kind: 'objective',
    students: [
      {
        name: 'Bianca S.',
        response: 'I’m not totally sure yet how the hydrophilic end helps rinse it away with water — I want to add that to my mechanistic model.',
      },
      { name: 'Fatima U.', artifact: 'Soap molecules around the virus, but no water or rinsing is shown.' },
    ],
  },
  {
    id: 'covid-m-soap-kills',
    label: 'Describes soap as “killing” the virus rather than breaking apart its structure',
    count: 5,
    kind: 'misconception',
    students: [
      { name: 'Caleb Z.', response: 'The soap kills the virus, so it can’t make you sick anymore.' },
      { name: 'Lena K.', response: 'Soap is poison to germs, so it kills them.' },
    ],
  },
]

// A flat lookup across all sections and lessons, keyed by row id, so the
// individual-evidence panel can resolve whichever row the teacher last
// clicked regardless of which section it came from.
const allPatternRows: Record<string, PatternRow> = Object.fromEntries(
  [
    ...learningObjectiveOverlap.flatMap((group) => group.ideas),
    ...scienceInPracticePatterns.flatMap((group) => group.patterns),
    ...misconceptionPatterns,
    ...covidDescriptivePatterns,
    ...covidMechanisticPatterns,
  ].map((row) => [row.id, row]),
)

// The Zombie Fires assignment's patterns: everything analyzed for it.
const zombieFiresPatternIds: string[] = [
  ...learningObjectiveOverlap.flatMap((group) => group.ideas),
  ...scienceInPracticePatterns.flatMap((group) => group.patterns),
  ...misconceptionPatterns,
].map((row) => row.id)

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
  'Ask about the work the assignment in "assignment" asked for.',
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
  // The assignment whose work was analyzed.
  assignment: { id: string; title: string; prompt: string }
}

// The demo model's question ideas for the Zombie Fires lesson, each tied to
// the patterns it responds to. The mock ranks them by the class's learning
// needs; a real model writes its own from the same request.
type MockFacilitationQuestion = FacilitationQuestion & { basedOn: string[] }

const zombieFiresQuestionBank: MockFacilitationQuestion[] = [
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


// The COVID Virus assignments' question ideas, the same way.
const covidDescriptiveQuestionBank: MockFacilitationQuestion[] = [
  {
    category: 'Whole-class prompts',
    text: 'Which structures in your virus drawing have labels, and which still need one?',
    basedOn: ['covid-d-envelope-unlabeled', 'covid-d-virus-structures-labeled'],
  },
  {
    category: 'Whole-class prompts',
    text: 'How did you decide which end of the soap molecule is hydrophilic?',
    basedOn: ['covid-d-ends-swapped', 'covid-d-soap-two-ends'],
  },
  {
    category: 'Whole-class prompts',
    text: 'Which part of the virus do you think a soap molecule would touch first, and how could your drawing show that?',
    basedOn: ['covid-d-no-relationship', 'covid-d-fat-attraction'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'Compare your soap molecules: do you agree on which end likes water and which likes fat?',
    basedOn: ['covid-d-ends-swapped'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'What could you add to your partner’s drawing to show how the virus and the soap are related?',
    basedOn: ['covid-d-no-relationship'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'Find a label in your partner’s model you would describe differently. What would you change?',
    basedOn: ['covid-d-virus-structures-labeled'],
  },
  {
    category: 'Debrief',
    text: 'Which label in your model are you least sure about, and how could you check it?',
    basedOn: ['covid-d-ends-swapped', 'covid-d-envelope-unlabeled'],
  },
  {
    category: 'Debrief',
    text: 'What from your descriptive model will you need when you draw how soap works?',
    basedOn: ['covid-d-fat-attraction', 'covid-d-no-relationship'],
  },
]

const covidMechanisticQuestionBank: MockFacilitationQuestion[] = [
  {
    category: 'Whole-class prompts',
    text: 'What happens to the oil after the soap molecules surround it? Where does your model show that?',
    basedOn: ['covid-m-no-water-role', 'covid-m-soap-surrounds-oil'],
  },
  {
    category: 'Whole-class prompts',
    text: 'Why might one soap molecule not be enough? How could your model show many working together?',
    basedOn: ['covid-m-single-molecule'],
  },
  {
    category: 'Whole-class prompts',
    text: 'Instead of saying soap “kills” the virus, what does your model show happening to the fatty envelope?',
    basedOn: ['covid-m-soap-kills', 'covid-m-tail-into-envelope'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'In your partner’s model, which end of the soap faces the oil and which faces the water? Do you agree?',
    basedOn: ['covid-m-parts-labeled', 'covid-m-soap-surrounds-oil'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'How does your model use the hydrophilic head to explain why rinsing with water matters?',
    basedOn: ['covid-m-no-water-role'],
  },
  {
    category: 'Peer-to-peer discussion',
    text: 'What would your partner need to add to show the virus’s envelope breaking apart?',
    basedOn: ['covid-m-tail-into-envelope', 'covid-m-soap-kills'],
  },
  {
    category: 'Debrief',
    text: 'Which part of your descriptive model helped you most when you drew the mechanism?',
    basedOn: ['covid-m-parts-labeled'],
  },
  {
    category: 'Debrief',
    text: 'What is one thing your model still can’t explain about why handwashing works?',
    basedOn: ['covid-m-no-water-role', 'covid-m-single-molecule'],
  },
]

// The demo question ideas for each Class Feedback assignment.
const mockFacilitationQuestionBanks: Record<string, MockFacilitationQuestion[]> = {
  'zombie-fires': zombieFiresQuestionBank,
  'covid-descriptive': covidDescriptiveQuestionBank,
  'covid-mechanistic': covidMechanisticQuestionBank,
}

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
    questions: pickFacilitationQuestions(mockFacilitationQuestionBanks[request.assignment.id] ?? [], request.classAnalysis, request.previousQuestions).map(
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
  assignmentId: string,
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
        (mockFacilitationQuestionBanks[assignmentId] ?? []).filter((question) => question.category === category && !seen.has(question.text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())),
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
  assignment: ClassFeedbackAssignment,
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
    { instructions: facilitationQuestionInstructions, responseSchema: facilitationQuestionSchema, lesson, classAnalysis, previousQuestions, assignment: { id: assignment.id, title: assignment.title, prompt: assignment.task.question } },
    (request) => mockFacilitationQuestionReply(request),
  )
  return readFacilitationQuestions(raw, classAnalysis, previousQuestions, assignment.id)
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

// The COVID Virus lesson's saved plan — mock data like the Zombie Fires
// lesson above, built around the COVID-19 handwashing activity Student
// Feedback demonstrates (its two prompts and model types). It has no
// pending AI suggestions.
const covidLessonSteps: LessonStep[] = [
  { label: 'Topic', segments: [{ text: 'COVID-19 & Handwashing: Structure and Function' }] },
  { label: 'Grade Level', segments: [{ text: 'Grades 6–8' }] },
  { label: 'Lesson Duration', segments: [{ text: '50 minutes (5 + 10 + 15 + 15 + 5 min across 5 activities)' }] },
  {
    label: 'Standards',
    sectionHeading: 'Standards',
    displayPrefix: '',
    listStyle: 'bullet',
    afterSection: 'practices',
    segments: [{ text: 'MS-PS1-1 (entered by you)' }],
  },
  {
    label: 'Learning Objective 1',
    sectionHeading: 'Learning Objectives',
    leadIn: 'By the end of the lesson, students will be able to:',
    displayPrefix: '1.A',
    segments: [
      {
        text: 'Develop a model of the coronavirus and a soap molecule that identifies their structures: protein, fatty envelope, and genetic material; hydrophilic and hydrophobic portions.',
      },
    ],
  },
  {
    label: 'Learning Objective 2',
    displayPrefix: '1.B',
    segments: [{ text: 'Use a model to explain how the structure of soap helps it break apart the virus’s fatty envelope and mix oil with water.' }],
  },
  {
    label: 'Engage',
    sectionHeading: 'Instructional Sequence',
    duration: 5,
    segments: [{ text: 'Students share why washing hands with soap might work better than rinsing with water alone; the class records their ideas.' }],
  },
  {
    label: 'Explore',
    duration: 10,
    segments: [{ text: 'In pairs, students examine images of the coronavirus and a soap molecule and list the structures they notice in each.' }],
  },
  {
    label: 'Descriptive Model',
    duration: 15,
    segments: [
      { text: 'Students ' },
      { text: 'develop a descriptive model', bold: true },
      { text: ': they draw and label the coronavirus (protein, fatty envelope, genetic material) and a soap molecule (hydrophilic and hydrophobic portions), then get AI feedback on their drawing.' },
    ],
  },
  {
    label: 'Mechanistic Model',
    duration: 15,
    segments: [
      { text: 'Students ' },
      { text: 'develop a mechanistic model', bold: true },
      { text: ' showing how soap molecules, oil, and water interact, and ' },
      { text: 'construct an explanation', bold: true },
      { text: ' of how the structure of soap helps it break apart the virus’s fatty envelope.' },
    ],
  },
  {
    label: 'Debrief',
    duration: 5,
    segments: [{ text: 'Pairs compare their models and revise one part using what they learned, noting what they changed and why.' }],
  },
  {
    label: 'Materials',
    sectionHeading: 'Additional Customization',
    listStyle: 'bullet',
    segments: [
      { text: 'Images of the coronavirus and a soap molecule' },
      { text: 'Dish soap, cooking oil, and water for a short demonstration' },
      { text: 'Student Feedback links for the Descriptive and Mechanistic models' },
    ],
  },
]

const covidLessonDocument: LessonDocument = {
  id: 'covid-virus',
  title: 'COVID Virus: Structure and Function of Soap',
  steps: covidLessonSteps,
  practices: ['Develop and Use Models', 'Construct Explanations'],
  suggestions: {},
  suggestionSummaries: {},
  revisionSegments: {},
  workflows: {},
}

// A demo lesson's saved Lesson Planning form, so opening the lesson for its
// class shows the form filled in alongside the saved plan.
type PlanningFormSeed = {
  gradeLevel: string
  topic: string
  framework: StandardsFrameworkId
  standards: string[]
  customStandards: string[]
  practices: string[]
  learningObjectives: string
  instructionalSequence: string
  pacingSelection: string
  customPacingMinutes: string
  priorInstruction: string
  subsequentInstruction: string
  differentiation: string
  materialsAndEquipment: string
}

// The form text for a saved lesson's objectives and sequence, from its steps.
const lessonStepText = (steps: readonly LessonStep[], labels: readonly string[]) =>
  labels.map((label) => steps.find((step) => step.label === label)).filter((step): step is LessonStep => Boolean(step))

function savedObjectivesText(steps: readonly LessonStep[]): string {
  return steps
    .filter((step) => step.label.startsWith('Learning Objective'))
    .map((step) => `${step.displayPrefix ? `${step.displayPrefix} ` : ''}${segmentsToText(step.segments)}`)
    .join('\n')
}

function savedSequenceText(steps: readonly LessonStep[], labels: readonly string[]): string {
  return lessonStepText(steps, labels)
    .map((step, index) => `${index + 1}. ${step.label}${step.duration ? ` (${step.duration} min)` : ''}: ${segmentsToText(step.segments)}`)
    .join('\n')
}

function savedMaterialsText(steps: readonly LessonStep[], labels: readonly string[]): string {
  return lessonStepText(steps, labels)
    .flatMap((step) => step.segments.map((segment) => segment.text))
    .join('\n')
}

const demoLessonFormSeeds: Record<string, PlanningFormSeed> = {
  'zombie-fires': {
    gradeLevel: '9-12',
    topic: segmentsToText(demoLessonSteps[0].segments),
    framework: 'NGSS',
    standards: ['HS-LS2-3', 'HS-LS2-4', 'HS-LS2-5', 'HS-ESS2-6'],
    customStandards: [],
    practices: ['modeling', 'explanation'],
    learningObjectives: savedObjectivesText(demoLessonSteps),
    instructionalSequence: savedSequenceText(demoLessonSteps, ['Engage', 'Explore', 'Explain', 'Elaborate', 'Evaluate', 'Assessment']),
    pacingSelection: '60',
    customPacingMinutes: '',
    priorInstruction: '',
    subsequentInstruction: '',
    differentiation: '',
    materialsAndEquipment: savedMaterialsText(demoLessonSteps, ['Materials', 'Equipment & Technology']),
  },
  'covid-virus': {
    gradeLevel: '6-8',
    topic: segmentsToText(covidLessonSteps[0].segments),
    framework: 'NGSS',
    standards: [],
    customStandards: ['MS-PS1-1'],
    practices: ['modeling', 'explanation'],
    learningObjectives: savedObjectivesText(covidLessonSteps),
    instructionalSequence: savedSequenceText(covidLessonSteps, ['Engage', 'Explore', 'Descriptive Model', 'Mechanistic Model', 'Debrief']),
    pacingSelection: 'custom',
    customPacingMinutes: '50',
    priorInstruction: '',
    subsequentInstruction: '',
    differentiation: '',
    materialsAndEquipment: savedMaterialsText(covidLessonSteps, ['Materials']),
  },
}

// Each demo class's mock lesson, loaded when the class is chosen in Class
// Setup (a demonstration shortcut — there's no class-to-lesson picker).
const demoClassLessonIds: Record<string, string> = {
  'period-4-earth-science': 'zombie-fires',
  'period-1-life-science': 'covid-virus',
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
  isSaving,
  draft,
  onDraftChange,
  onSend,
  onApply,
  onClose,
}: {
  label: string
  state: SectionRevisionState
  isThinking: boolean
  // A lesson version is being saved; Apply to Lesson waits for it.
  isSaving: boolean
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
              disabled={isThinking || isSaving || (isEditingProposal && !proposalDraft.trim())}
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

type AppProps = {
  session: AppSession
  // Where to open after a session change (sign-in, Explore Demo, leaving the demo).
  entryPage: PageId | null
  onSignIn: (email: string, password: string) => Promise<string | null>
  onExploreDemo: () => Promise<string | null>
  onExitDemo: () => void
}

function App({ session, entryPage, onSignIn, onExploreDemo, onExitDemo }: AppProps) {
  // A bare URL opens on the mock Login page; existing #page links still
  // jump straight to that page. Read once at init (not in an effect) so the
  // hash-writing effect below can't overwrite it first.
  // A signed-in teacher's app never opens on Login: the session can reach
  // AppRoot (through onAuthStateChange) before sign-in has set where to go,
  // while the URL still says #login.
  const [activePage, setActivePage] = useState<PageId>(() => {
    const page = entryPage ?? getInitialPage(session.kind !== 'none')
    const start = session.kind === 'teacher' && page === 'login' ? getPostLoginPage() : page
    authDebug('App start', { session: session.kind, entryPage, startPage: start })
    return start
  })
  const enteredPrototypeRef = useRef(session.kind !== 'none')
  useEffect(() => {
    enteredPrototypeRef.current = session.kind !== 'none'
  }, [session.kind])
  // Supabase login for this session (never in the demo — see usesSupabase).
  const realAuth = usesSupabase('auth')
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
  // Supabase Mode: a new lesson version is saved only when the teacher
  // confirms a change — Apply to Lesson ('ai_teacher') or saving their
  // manual edits ('teacher'). Each confirmation is one request, saved once
  // the change it confirms has rendered.
  // A request is saving until its save finishes (saves run in order, so the
  // newest finished request means none is pending).
  const [versionRequest, setVersionRequest] = useState<{ id: number; createdBy: VersionCreatedBy } | null>(null)
  const [finishedVersionRequestId, setFinishedVersionRequestId] = useState(0)
  const isSavingVersion = versionRequest !== null && versionRequest.id !== finishedVersionRequestId
  const requestLessonVersion = (createdBy: VersionCreatedBy) => {
    if (lessonPersistence !== 'supabase' || !workspaceLessonId || !remoteLessonIdsRef.current.has(workspaceLessonId)) return
    setVersionRequest((prev) => ({ id: (prev?.id ?? 0) + 1, createdBy }))
  }
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
    requestLessonVersion('ai_teacher')
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
  // The planning option that generated the lesson in the workspace (null
  // for a lesson opened from the Library). Once set, Lesson Planning grays
  // out the other options until the teacher starts something new.
  const [lessonGeneratedWith, setLessonGeneratedWith] = useState<PlanningMethod | null>(null)
  // Bumped by Start New to give Lesson Planning a fresh form, conversation,
  // and activity (and when a saved lesson is opened, to load its form).
  const [planningSessionKey, setPlanningSessionKey] = useState(0)
  // A demo lesson's saved planning form, loaded with its lesson; null for a
  // blank form.
  const [planningFormSeed, setPlanningFormSeed] = useState<PlanningFormSeed | null>(null)
  // The demo lesson Generate Lesson Plan shows, when a demo class was opened
  // from Class Setup and its lesson hasn't been generated yet.
  const [pendingDemoLesson, setPendingDemoLesson] = useState<LibraryLesson | null>(null)
  // The lesson shown in the workspace.
  const [lessonDocument, setLessonDocument] = useState<LessonDocument>(demoLessonDocument)
  // The lesson's Student Feedback Activities, and the Library lesson the
  // workspace lesson is saved as (if any) so they stay with it.
  const [feedbackActivities, setFeedbackActivities] = useState<FeedbackActivity[]>(() => identifyFeedbackActivities(null))
  const [workspaceLessonId, setWorkspaceLessonId] = useState<string | null>(null)
  // The Student Feedback URL the app opened on, if any (see StudentFeedbackRoute).
  const [initialStudentRoute] = useState(readStudentFeedbackRoute)
  // The assignment a Student Feedback link opened, if the page came from one.
  const [studentAssignment, setStudentAssignment] = useState<StudentAssignmentLink | null>(initialStudentRoute?.link ?? null)
  // The class whose students sign in to Student Feedback, when the URL or a
  // Library card named one.
  const [studentFeedbackClassId, setStudentFeedbackClassId] = useState<string | null>(initialStudentRoute?.classId ?? null)
  // A Library lesson's demo assignment open on Student Feedback (the URL's `task`).
  const [studentFeedbackTask, setStudentFeedbackTask] = useState<{ lessonId: string; taskId: string } | null>(() =>
    initialStudentRoute?.taskId ? { lessonId: initialStudentRoute.lessonId, taskId: initialStudentRoute.taskId } : null,
  )
  // Who is signed in to Student Feedback, by class: their class Student ID.
  const [studentSignIns, setStudentSignIns] = useState<Record<string, string>>({})
  // Individual Student Reports: the lesson, class, student, and model type
  // it shows (kept in the URL), and the page its Back button returns to.
  const [studentReportsRoute, setStudentReportsRoute] = useState<StudentReportsRoute | null>(readStudentReportsRoute)
  const [studentReportsReturnTo, setStudentReportsReturnTo] = useState<PageId | null>(null)
  // The Class Summary finding selected on Class Feedback — kept here so
  // Back from a student's report lands on the same finding.
  const [classFeedbackPatternId, setClassFeedbackPatternId] = useState<string | null>(defaultPatternId)
  // The Class Feedback assignment shown (null: the lesson's first), kept
  // for the same reason.
  const [classFeedbackAssignmentId, setClassFeedbackAssignmentId] = useState<string | null>(null)
  // Class Feedback's Model / Explanation selection, kept with the assignment.
  const [classFeedbackWorkType, setClassFeedbackWorkType] = useState<WorkType>('model')
  // A different lesson starts with no revisions, conversations, dismissed
  // suggestions, or manual edits carried over from the previous one.
  const showLessonDocument = (
    document: LessonDocument,
    libraryLessonId: string | null,
    activities: FeedbackActivity[] = identifyFeedbackActivities(libraryLessonId),
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
  const [studentFeedbackTab, setStudentFeedbackTab] = useState<ModelTab>(
    () => (initialStudentRoute && findDemoAssignment(initialStudentRoute.lessonId, initialStudentRoute.taskId)?.modelTab) || 'descriptive',
  )

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
    libraryLessons.find((lesson) => lesson.id === classFeedbackAssignments[0].lessonId) ??
    initialLibraryLessons[0]

  // Keep the AI gateway's list of student identifiers in step with the
  // registry, so new or renamed students are redacted from AI requests too.
  useEffect(() => {
    syncAiRosterGuard(students)
  }, [students])

  // Mirror each class's active Student IDs for the Student Feedback login in
  // other tabs (see readStoredLoginRosters). A tab opened from a student link
  // starts from the seeded classes, so it doesn't overwrite the teacher's
  // saved rosters until something in it actually changes.
  const [seededClassesFromLink] = useState(() => (initialStudentRoute !== null ? libraryClasses : null))
  const lastStoredClasses = useRef<LibraryClass[] | null>(seededClassesFromLink)
  useEffect(() => {
    if (lastStoredClasses.current === libraryClasses) return
    lastStoredClasses.current = libraryClasses
    // Only mock rosters are mirrored — real Student IDs never go to the browser.
    if (!usesSupabase('classes')) storeLoginRosters(libraryClasses)
  }, [libraryClasses])

  // A Supabase teacher's classes and lessons still come from the mock data
  // until those integrations are on, and onboarding status isn't stored in
  // the database yet, so they're treated as returning teachers.
  const signedInTeacher = session.kind === 'teacher' ? session.teacher : null
  const [teacherAccounts, setTeacherAccounts] = useState<Record<string, TeacherAccount>>(() => ({
    [DEMO_TEACHER_EMAIL]: { email: DEMO_TEACHER_EMAIL, onboardingComplete: true, state: null, district: '' },
    ...(signedInTeacher
      ? { [signedInTeacher.email]: { email: signedInTeacher.email, onboardingComplete: true, state: null, district: '' } }
      : {}),
  }))
  // Pages opened without logging in (e.g. a #library link) act as the demo
  // teacher, so the prototype stays navigable. With Supabase Auth, teacher
  // pages need a session instead (see needsTeacherLogin).
  const [currentTeacherEmail, setCurrentTeacherEmail] = useState(signedInTeacher?.email ?? DEMO_TEACHER_EMAIL)
  const currentAccount: TeacherAccount = teacherAccounts[currentTeacherEmail] ?? {
    email: currentTeacherEmail,
    onboardingComplete: false,
    state: null,
    district: '',
  }
  // Supabase Mode with the `classes` integration: a signed-in teacher's
  // classes and rosters come from the database (loaded once per session —
  // AppRoot gives each session a fresh App). Mock classes stay in state for
  // the pages that still use mock data, but they belong to the demo teacher,
  // so they never show up as this teacher's.
  const remoteClasses = usesSupabase('classes') && session.kind === 'teacher'
  const [remoteClassesStatus, setRemoteClassesStatus] = useState<{ state: 'idle' | 'loading' | 'ready' | 'error'; message?: string }>(() => ({
    state: remoteClasses ? 'loading' : 'idle',
  }))
  const [remoteTeacherName, setRemoteTeacherName] = useState('')
  useEffect(() => {
    if (!remoteClasses || session.kind !== 'teacher') return
    let active = true
    const email = session.teacher.email
    ;(async () => {
      authDebug('classes: loading')
      const [profile, classRecords] = await Promise.all([getTeacherProfile(), listMyClasses()])
      authDebug('classes: loaded', { hasProfile: profile !== null, classes: classRecords.length })
      const rosters = await listRosters(classRecords.map((record) => record.classId))
      if (!active) return
      const teacher = { name: profile?.userName ?? '', email }
      const loadedClasses = classRecords.map((record, index) => libraryClassFromRecord(record, rosters[record.classId] ?? [], teacher, index))
      // The classes' saved lessons (Lesson Planning integration).
      let loaded = loadedClasses
      if (usesSupabase('lessonPlanning')) {
        try {
          const stored = await listLessonsForClasses(classRecords.map((record) => record.classId))
          if (!active) return
          const framework = (currentAccount.state ?? 'NGSS') as StandardsFrameworkId
          const lessons = stored.map((item, index) => libraryLessonFromStored(item, index, email, framework))
          remoteLessonIdsRef.current = new Set(stored.map((item) => item.lessonId))
          for (const item of stored) {
            const content = readSavedLessonContent(item.currentVersion?.content)
            if (content) lessonFormsRef.current.set(item.lessonId, content.form)
          }
          loaded = loadedClasses.map((classroom) => ({
            ...classroom,
            lessonIds: stored.filter((item) => item.classId === classroom.id).map((item) => item.lessonId),
          }))
          setLibraryLessons((prev) => [...prev.filter((lesson) => lesson.ownerEmail !== email), ...lessons])
          authDebug('lessons: loaded', { lessons: stored.length })
        } catch (error) {
          if (!active) return
          setRemoteLessonsError(`Couldn’t load your lessons: ${toApiError(error).message}`)
        }
      }
      const loadedStudents = new Map<string, Student>()
      for (const roster of Object.values(rosters)) {
        for (const student of roster) loadedStudents.set(student.studentId, { id: student.studentId, name: student.studentName })
      }
      setRemoteTeacherName(teacher.name)
      setLibraryClasses((prev) => [...prev.filter((classroom) => classroom.ownerEmail !== email), ...loaded])
      setStudents((prev) => [...prev.filter((student) => !loadedStudents.has(student.id)), ...loadedStudents.values()])
      setRemoteClassesStatus({ state: 'ready' })
    })().catch((error) => {
      authDebug('classes: failed', { message: toApiError(error).message })
      if (active) setRemoteClassesStatus({ state: 'error', message: toApiError(error, 'Couldn’t load your classes.').message })
    })
    return () => {
      active = false
    }
    // Loaded once per teacher session (the session never changes within an App).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Lesson Planning in Supabase Mode (`lessonPlanning` integration, a
  // signed-in teacher): lessons are saved through partners-save-lesson /
  // update_lesson_version and loaded with the classes. A teacher with the
  // integration off gets a clear "not saved" message, never a mock save.
  const lessonPersistence: 'mock' | 'supabase' | 'off' =
    session.kind !== 'teacher' ? 'mock' : usesSupabase('lessonPlanning') ? 'supabase' : 'off'
  const [lessonSaveStatus, setLessonSaveStatus] = useState<{ kind: 'saving' | 'saved' | 'error' | 'info'; message: string; retry?: VersionCreatedBy } | null>(null)
  const [remoteLessonsError, setRemoteLessonsError] = useState<string | null>(null)
  const [isSavingLesson, setIsSavingLesson] = useState(false)
  // Lessons that live in Supabase, the form each was made from, and what was
  // last saved for the lesson in the workspace (so only real changes save).
  const remoteLessonIdsRef = useRef(new Set<string>())
  const lessonFormsRef = useRef(new Map<string, PlanningLessonDetails>())
  const lastSavedLessonRef = useRef<{ lessonId: string; snapshot: string } | null>(null)

  // Class Setup's writes in Supabase Mode: creating a class saves it;
  // editing a class and changing a roster aren't connected yet.
  const classSetupRemote = remoteClasses
    ? {
        createClass: async (values: ClassFormValues): Promise<LibraryClass> => {
          const record = await createRemoteClass({ className: values.name, gradeLevel: values.gradeLevel, period: values.period })
          const index = libraryClasses.filter((classroom) => classroom.ownerEmail === currentTeacherEmail).length
          return libraryClassFromRecord(record, [], { name: values.teacherName.trim() || remoteTeacherName, email: currentTeacherEmail }, index)
        },
        // Adds students with app-generated Student IDs through
        // register_student_roster, then reads the roster back.
        registerStudents: async (classroom: LibraryClass, names: readonly string[]): Promise<RegisteredStudents> => {
          const before = (await listRosters([classroom.id]))[classroom.id] ?? []
          const ids = planStudentIds(before, studentIdPrefixFor(classroom.teacherName || remoteTeacherName, classroom.name), names.length)
          await registerStudentRoster(
            classroom.id,
            names.map((name, index) => ({ studentName: name, studentPseudonym: ids[index] })),
          )
          const after = (await listRosters([classroom.id]))[classroom.id] ?? []
          // Success only when every new student is in the roster read back
          // from Supabase — never on the RPC's word alone.
          const missing = names.filter((_, index) => !after.some((student) => student.studentPseudonym === ids[index]))
          if (missing.length > 0) {
            throw new ApiError(
              `${joinLabels(missing)} ${missing.length === 1 ? 'wasn’t' : 'weren’t'} found in the saved roster, so ${missing.length === 1 ? 'it' : 'they'} may not have been saved. Please refresh and check before adding again.`,
              { code: 'not_saved' },
            )
          }
          const duplicates = duplicateStudentIds(after)
          return {
            classroom: { ...classroom, ...rosterFieldsFor(after) },
            students: after.map((student) => ({ id: student.studentId, name: student.studentName })),
            added: names.map((name, index) => {
              const saved = after.find((student) => student.studentPseudonym === ids[index])
              return { key: saved?.studentId ?? null, name, studentId: ids[index] }
            }),
            warning:
              duplicates.length > 0
                ? `More than one student in this class now has ${joinLabels(duplicates)} — someone may have added students at the same time. Please check the roster.`
                : null,
          }
        },
        editBlocked: 'Editing classes isn’t connected to Supabase yet.',
        rosterBlocked: 'Renaming or removing students isn’t connected to Supabase yet.',
      }
    : session.kind === 'teacher'
      ? // A Supabase teacher with the `classes` integration off: Class Setup
        // must not look like it saves when nothing reaches the database, so
        // every write explains instead of falling back to the mock data.
        {
          createClass: async (): Promise<LibraryClass> => {
            throw new ApiError(classSetupNotConnected, { code: 'not_connected' })
          },
          registerStudents: async (): Promise<RegisteredStudents> => {
            throw new ApiError(classSetupNotConnected, { code: 'not_connected' })
          },
          editBlocked: classSetupNotConnected,
          rosterBlocked: classSetupNotConnected,
        }
      : null

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
    setStudentFeedbackClassId(null)
    setStudentFeedbackTask(null)
    setClassFeedbackLessonId(null)
    setPlanningTarget(null)
    setStartCreatingClass(false)
    setClassFeedbackPatternId(defaultPatternId)
    setClassFeedbackAssignmentId(null)
    if (page === 'library' && selectedClassId) expandLibraryClass(selectedClassId)
    // From the drawer, reports start unselected (and have no page to go back to).
    if (page === 'student-reports') {
      setStudentReportsRoute(null)
      setStudentReportsReturnTo(null)
    }
    setActivePage(page)
  }

  // Opens Individual Student Reports; Back returns to the page it was
  // opened from (with that page's context left as it was).
  const openStudentReports = (route: StudentReportsRoute) => {
    if (activePage !== 'student-reports') setStudentReportsReturnTo(activePage)
    setStudentReportsRoute(route)
    setActivePage('student-reports')
  }

  // The student's class Student ID, or null if they aren't on the roster.
  const classStudentIdFor = (classId: string, studentName: string): string | null => {
    const classroom = libraryClasses.find((item) => item.id === classId)
    const student = classroom && students.find((item) => classroom.studentIds.includes(item.id) && item.name === studentName)
    return classroom && student ? (classroom.studentCodes[student.id] ?? null) : null
  }

  // From Student Evidence on Class Feedback: that student's report for the
  // same assignment and student work (Model or Explanation), in the class
  // whose submissions the evidence came from.
  const handleOpenStudentReport = (lesson: LibraryLesson, studentName: string, assignmentId: string) => {
    const classId = analyzedSubmissionClassIds[lesson.id] ?? null
    const assignment = classFeedbackAssignments.find((item) => item.id === assignmentId)
    openStudentReports({
      lessonId: lesson.id,
      classId,
      studentId: classId ? classStudentIdFor(classId, studentName) : null,
      modelTab: assignment?.modelTabs[0] ?? 'descriptive',
      assignmentId,
      work: classFeedbackWorkType,
    })
  }

  // From a Library lesson card: that lesson and class, no student yet.
  const handleOpenStudentReports = (lesson: LibraryLesson, classroom: LibraryClass | null) => {
    setLibraryContext(null)
    const assignment = classFeedbackAssignmentsFor(lesson.id)[0]
    openStudentReports({
      lessonId: lesson.id,
      classId: classroom?.id ?? null,
      studentId: null,
      modelTab: assignment?.modelTabs[0] ?? 'descriptive',
      assignmentId: assignment?.id ?? null,
      work: 'model',
    })
  }

  const handleStudentReportsBack = () => setActivePage(studentReportsReturnTo ?? 'library')

  const handleCreateClassFromLibrary = () => {
    navigateTo('class-setup')
    setStartCreatingClass(true)
  }

  const resetGeneratedLesson = () => {
    if (generateLessonTimeoutRef.current !== null) window.clearTimeout(generateLessonTimeoutRef.current)
    setIsGeneratingLesson(false)
    setLessonGenerated(false)
    setLessonGeneratedWith(null)
    setPendingDemoLesson(null)
  }

  // Start New on Lesson Planning: clears the workspace lesson, form,
  // conversation, and activity, and restores every planning option. A
  // class the page was opened for stays its class, but the next lesson is
  // saved as a new one.
  const handleStartNewPlanning = () => {
    resetGeneratedLesson()
    setWorkspaceLessonId(null)
    setLibraryContext(null)
    setPlanningTarget((target) => (target ? { classId: target.classId, savedLessonId: null } : null))
    setPlanningTab('none')
    setPlanningFormSeed(null)
    setPlanningSessionKey((key) => key + 1)
  }

  // Add Lesson always starts a new, blank lesson — never a demo lesson.
  const handleAddLessonToClass = (classroom: LibraryClass) => {
    resetGeneratedLesson()
    setPlanningFormSeed(null)
    setPlanningSessionKey((key) => key + 1)
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

  // Supabase Mode: saves a generated or uploaded lesson for the class
  // Lesson Planning was opened for — a new lesson, or a new version when
  // re-generating one that's already saved. The lesson joins the Library
  // only once Supabase confirms it; failures are shown, never hidden.
  const persistPlannedLesson = async (
    details: PlanningLessonDetails,
    document: LessonDocument,
    lessonSourceKind: 'generated' | 'uploaded',
    uploadedFileName?: string,
  ) => {
    if (lessonPersistence === 'off') {
      setLessonSaveStatus({ kind: 'error', message: 'This lesson isn’t saved: Lesson Planning isn’t connected to Supabase in this configuration. Add “lessonPlanning” to VITE_SUPABASE_INTEGRATIONS.' })
      return
    }
    if (!planningTarget || !planningTargetClass) {
      setLessonSaveStatus({ kind: 'info', message: 'This lesson isn’t saved because it isn’t linked to a class. To save it, open Lesson Planning from a class (Class Setup → Continue to Lesson Planning, or Library → Add Lesson).' })
      return
    }
    if (!usesSupabase('classes')) {
      setLessonSaveStatus({ kind: 'error', message: 'This lesson isn’t saved: saving lessons needs the classes integration too (VITE_SUPABASE_INTEGRATIONS=auth,classes,lessonPlanning).' })
      return
    }
    const title = lessonTitleFrom(details, uploadedFileName)
    const fields = lessonFieldsFrom(details, title, planningTargetClass.gradeLevel)
    if (!fields.grade_level) {
      setLessonSaveStatus({ kind: 'error', message: 'This lesson isn’t saved: choose a grade level first.' })
      return
    }
    const { classId, savedLessonId } = planningTarget
    const existingId = savedLessonId && remoteLessonIdsRef.current.has(savedLessonId) ? savedLessonId : null
    const studentProducts = identifyFeedbackActivities(existingId)
    const content = lessonContentFrom(effectiveLessonDocument(document, {}, {}), details, studentProducts)
    const framework = (currentAccount.state ?? 'NGSS') as StandardsFrameworkId
    setIsSavingLesson(true)
    setLessonSaveStatus({ kind: 'saving', message: 'Saving to your Library…' })
    try {
      const saved = existingId
        ? await saveLessonVersion({ lessonId: existingId, content, createdBy: lessonSourceKind === 'uploaded' ? 'teacher' : 'ai', fields })
        : await saveNewLesson({ classId, lessonSource: lessonSourceKind, fields, content })
      const lessonId = saved.lessonId
      remoteLessonIdsRef.current.add(lessonId)
      lessonFormsRef.current.set(lessonId, details)
      const savedDocument = { ...content.document, id: lessonId }
      lastSavedLessonRef.current = { lessonId, snapshot: JSON.stringify(savedDocument) }
      const record = (bannerColor: string): LibraryLesson => ({
        ...createLibraryLessonFromPlanning(lessonId, details, bannerColor, currentTeacherEmail, uploadedFileName, savedDocument),
        title,
        lessonPlan: { hasDemoContent: true, document: savedDocument, feedbackActivities: studentProducts, formSeed: formSeedFromDetails(details, framework) },
      })
      if (existingId) {
        setLibraryLessons((prev) => prev.map((lesson) => (lesson.id === lessonId ? record(lesson.bannerColor) : lesson)))
      } else {
        setLibraryLessons((prev) => [...prev, record(lessonBannerColors[prev.filter((lesson) => lesson.ownerEmail === currentTeacherEmail).length % lessonBannerColors.length])])
        setLibraryClasses((prev) =>
          prev.map((classroom) => (classroom.id === classId ? { ...classroom, lessonIds: [...classroom.lessonIds, lessonId] } : classroom)),
        )
        setPlanningTarget({ classId, savedLessonId: lessonId })
      }
      setWorkspaceLessonId(lessonId)
      setLessonSaveStatus({
        kind: 'saved',
        message: existingId ? `Saved as version ${saved.versionNumber}.` : `Saved to your Library for ${classDisplayName(planningTargetClass)}.`,
      })
    } catch (error) {
      setLessonSaveStatus({ kind: 'error', message: `This lesson wasn’t saved: ${toApiError(error, 'Couldn’t save the lesson.').message}` })
    } finally {
      setIsSavingLesson(false)
    }
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
    const generatedId = `${workspaceLessonId}-feedback-activities`
    setLibraryLessons((prev) =>
      prev.map((lesson) => {
        if (lesson.id !== workspaceLessonId) return lesson
        // The lesson has one assignment link: the confirmed products update
        // it in place (a demo lesson's own, e.g. COVID Virus's) rather than
        // adding a second one. Unconfirming removes only a link made here.
        const existing = lesson.studentFeedback.find((assignment) => assignment.link)
        const id = existing?.id ?? generatedId
        const updated = link ? { id, title: joinLabels(next.map((activity) => activity.name)), modelTab: 'descriptive' as const, link } : null
        const others = lesson.studentFeedback.filter((assignment) => assignment.id !== id)
        return {
          ...lesson,
          lessonPlan: { ...lesson.lessonPlan, feedbackActivities: next },
          studentFeedback: updated ? [...others, updated] : id === generatedId ? others : lesson.studentFeedback,
        }
      }),
    )
  }

  // Returns an error message for the login form, or null on success. A
  // first login with an unknown email creates the account, like Create
  // Account does.
  // Signing in with Supabase is handled by AppRoot, which then opens a fresh
  // app for the teacher.
  const handleLogin = async (credentials: MockLoginCredentials): Promise<string | null> => {
    if (!realAuth) return handleMockLogin(credentials)
    // New accounts need a teacher profile row too, which isn't connected
    // yet; existing test accounts log in normally.
    if (credentials.mode === 'create') return 'Creating accounts isn’t connected to Supabase yet. Log in with an existing teacher account.'
    return onSignIn(credentials.email, credentials.password)
  }

  // Explore Demo: AppRoot signs out any Supabase session and starts the demo
  // (a fresh app in Supabase Mode); here it opens as the mock demo teacher.
  const handleExploreDemo = async (): Promise<string | null> => {
    const error = await onExploreDemo()
    if (error) return error
    setCurrentTeacherEmail(DEMO_TEACHER_EMAIL)
    setSelectedClassId(null)
    navigateTo(getPostLoginPage())
    return null
  }

  // Going to Login from the demo leaves it.
  useEffect(() => {
    if (session.kind === 'demo' && activePage === 'login') onExitDemo()
  }, [session.kind, activePage, onExitDemo])

  const handleMockLogin = ({ email: rawEmail, mode, state, district }: MockLoginCredentials): string | null => {
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
    // A demo class opens its saved mock lesson (demonstration only);
    // any other class starts a new lesson for it.
    const demoLesson = libraryLessons.find((lesson) => lesson.id === demoClassLessonIds[classroom.id])
    if (demoLesson) {
      setSelectedClassId(classroom.id)
      openDemoClassLesson(demoLesson, classroom)
    } else {
      handleAddLessonToClass(classroom)
    }
  }

  // Only lessons with prototype content behind them reveal the generated
  // lesson workspace; the rest open on the blank planning form so the
  // teacher never sees one lesson's content under another lesson's title.
  // Opens a saved lesson on Lesson Planning: its plan in the workspace and,
  // for a demo lesson, its saved planning form. Nothing is generated or
  // saved, so the mock lesson is never overwritten.
  const openSavedLesson = (lesson: LibraryLesson, classroom: LibraryClass | null, source: 'library' | 'class-setup') => {
    resetGeneratedLesson()
    const document = lesson.lessonPlan.document ?? demoLessonDocument
    showLessonDocument(document, lesson.id, lesson.lessonPlan.feedbackActivities ?? identifyFeedbackActivities(lesson.id))
    setLessonGenerated(lesson.lessonPlan.hasDemoContent)
    setPlanningFormSeed(demoLessonFormSeeds[lesson.id] ?? lesson.lessonPlan.formSeed ?? null)
    setPlanningSessionKey((key) => key + 1)
    // A lesson saved in Supabase stays linked to its class, so re-generating
    // saves a new version of it.
    const isRemote = remoteLessonIdsRef.current.has(lesson.id)
    setPlanningTarget(isRemote && classroom ? { classId: classroom.id, savedLessonId: lesson.id } : null)
    setLessonSaveStatus(
      isRemote && !lesson.lessonPlan.document ? { kind: 'error', message: 'This lesson’s saved content couldn’t be read, so it can’t be shown.' } : null,
    )
    setLibraryContext({ lesson, className: classroom ? classDisplayName(classroom) : undefined, page: 'lesson-generator', source })
    setActivePage('lesson-generator')
  }

  const handleOpenLessonPlan = (lesson: LibraryLesson, classroom: LibraryClass | null) => openSavedLesson(lesson, classroom, 'library')

  // From Class Setup, a demo class's lesson starts with the planning options
  // collapsed (the form is filled in behind "Create a new lesson") and an
  // empty workspace; Generate Lesson Plan then shows the saved
  // mock lesson (see handleGenerateLessonPlan). Nothing is saved.
  const openDemoClassLesson = (lesson: LibraryLesson, classroom: LibraryClass) => {
    resetGeneratedLesson()
    setPendingDemoLesson(lesson)
    setWorkspaceLessonId(lesson.id)
    setPlanningFormSeed(demoLessonFormSeeds[lesson.id] ?? null)
    setPlanningSessionKey((key) => key + 1)
    setPlanningTarget(null)
    setPlanningTab('none')
    setLibraryContext({ lesson, className: classDisplayName(classroom), page: 'lesson-generator', source: 'class-setup' })
    setActivePage('lesson-generator')
  }

  const handleOpenStudentFeedback = (
    lesson: LibraryLesson,
    assignment: StudentFeedbackAssignment,
    classroom: LibraryClass | null,
  ) => {
    setStudentFeedbackTab(assignment.modelTab)
    setStudentAssignment(assignment.link ?? null)
    setStudentFeedbackClassId(classroom?.id ?? null)
    setStudentFeedbackTask(assignment.link ? null : { lessonId: lesson.id, taskId: assignment.id })
    setLibraryContext({ lesson, className: classroom ? classDisplayName(classroom) : undefined, page: 'student-feedback', assignmentTitle: assignment.title })
    setActivePage('student-feedback')
  }

  const handleOpenClassFeedback = (lesson: LibraryLesson, classroom: LibraryClass | null) => {
    setClassFeedbackLessonId(lesson.id)
    setLibraryContext({ lesson, className: classroom ? classDisplayName(classroom) : undefined, page: 'class-feedback-dashboard' })
    setActivePage('class-feedback-dashboard')
  }

  const handleGenerateLessonPlan = (details: PlanningLessonDetails) => {
    if (isGeneratingLesson || isSavingLesson) return
    setLessonSaveStatus(null)
    // Generate Lesson is on the form and in Brainstorm with AI.
    const method: PlanningMethod = planningTab === 'brainstorm' ? 'brainstorm' : 'create'
    // A demo class's form, still as saved: show its saved mock lesson (with
    // its AI suggestions). If the teacher changed the form, generate from
    // what they entered instead — never saved over the mock lesson.
    const seed = pendingDemoLesson ? demoLessonFormSeeds[pendingDemoLesson.id] : undefined
    const unchanged =
      seed &&
      details.topic.trim() === seed.topic.trim() &&
      details.gradeLevel === seed.gradeLevel &&
      details.learningObjectives.trim() === seed.learningObjectives.trim() &&
      details.instructionalSequence.trim() === seed.instructionalSequence.trim()
    if (pendingDemoLesson && unchanged) {
      const saved = pendingDemoLesson.lessonPlan.document ?? demoLessonDocument
      showLessonDocument(saved, pendingDemoLesson.id, pendingDemoLesson.lessonPlan.feedbackActivities ?? identifyFeedbackActivities(pendingDemoLesson.id))
    } else if (lessonPersistence !== 'mock') {
      // Supabase Mode: shown now, saved (or the reason it isn't) right after.
      const document = generateLessonDocument(details)
      const keepId = planningTarget?.savedLessonId && remoteLessonIdsRef.current.has(planningTarget.savedLessonId) ? planningTarget.savedLessonId : null
      showLessonDocument(document, keepId)
      if (keepId) lastSavedLessonRef.current = { lessonId: keepId, snapshot: JSON.stringify(effectiveLessonDocument({ ...document, id: keepId }, {}, {})) }
      void persistPlannedLesson(details, document, 'generated')
    } else {
      const document = generateLessonDocument(details)
      showLessonDocument(document, saveLessonForPlanningTarget(details, document))
    }
    setPendingDemoLesson(null)
    setLessonSource('ai-generated')
    setIsGeneratingLesson(true)
    generateLessonTimeoutRef.current = window.setTimeout(() => {
      setLessonGenerated(true)
      setLessonGeneratedWith(method)
      setIsGeneratingLesson(false)
    }, 900)
  }

  // Upload is only wired up when adding a lesson to a class (see
  // onUploadLesson on LessonPlanningPanel): it saves the file as that class's
  // lesson and opens it in the workspace the same way Generate does.
  const handleUploadLesson = (file: File, details: PlanningLessonDetails) => {
    if (isGeneratingLesson || isSavingLesson) return
    setLessonSaveStatus(null)
    // Uploaded files aren't read yet, so the prototype shows its demo lesson.
    if (lessonPersistence !== 'mock') {
      showLessonDocument(demoLessonDocument, null)
      void persistPlannedLesson(details, demoLessonDocument, 'uploaded', file.name)
    } else {
      showLessonDocument(demoLessonDocument, saveLessonForPlanningTarget(details, demoLessonDocument, file.name))
    }
    setLessonSource('uploaded')
    setIsGeneratingLesson(true)
    generateLessonTimeoutRef.current = window.setTimeout(() => {
      setLessonGenerated(true)
      setLessonGeneratedWith('upload')
      setIsGeneratingLesson(false)
    }, 900)
  }

  // Supabase Mode: a confirmed change (Apply to Lesson, or saving manual
  // edits) becomes exactly one new version of the lesson — content and
  // lesson fields together (update_lesson_version). Nothing else saves a
  // version. Saves run one at a time, in the order they were confirmed.
  const revisedLesson = revisionEditor.revisedLesson
  const handledVersionRequestRef = useRef(0)
  const versionSaveQueueRef = useRef<Promise<void>>(Promise.resolve())
  useEffect(() => {
    if (!versionRequest || versionRequest.id === handledVersionRequestRef.current) return
    handledVersionRequestRef.current = versionRequest.id
    const { id: requestId, createdBy } = versionRequest
    // requestLessonVersion only asks for a remote lesson open in the workspace.
    const lessonId = workspaceLessonId!
    const effective = effectiveLessonDocument({ ...lessonDocument, id: lessonId }, manualEdits, revisedLesson)
    const snapshot = JSON.stringify(effective)
    const form = lessonFormsRef.current.get(lessonId)
    const lesson = libraryLessons.find((item) => item.id === lessonId)
    const classroom = libraryClasses.find((item) => item.lessonIds.includes(lessonId))
    const activities = feedbackActivities
    versionSaveQueueRef.current = versionSaveQueueRef.current.then(async () => {
      if (!form || !lesson) {
        setLessonSaveStatus({ kind: 'error', message: 'Your changes aren’t saved: this lesson’s saved form couldn’t be found. Reload the page and try again.' })
        setFinishedVersionRequestId(requestId)
        return
      }
      // Saving manual edits that change nothing adds no version.
      const last = lastSavedLessonRef.current
      if (createdBy === 'teacher' && last?.lessonId === lessonId && last.snapshot === snapshot) {
        setFinishedVersionRequestId(requestId)
        return
      }
      setLessonSaveStatus({ kind: 'saving', message: 'Saving your changes…' })
      // A failed save leaves the teacher's changes in the lesson on screen
      // (only the Library copy waits for a confirmed save), so Try again saves them.
      try {
        const saved = await saveLessonVersion({
          lessonId,
          content: lessonContentFrom(effective, form, activities),
          createdBy,
          fields: lessonFieldsFrom(form, lesson.title, classroom?.gradeLevel ?? ''),
        })
        lastSavedLessonRef.current = { lessonId, snapshot }
        setLibraryLessons((prev) =>
          prev.map((item) => (item.id === lessonId ? { ...item, lessonPlan: { ...item.lessonPlan, document: effective } } : item)),
        )
        setLessonSaveStatus({ kind: 'saved', message: `Changes saved as version ${saved.versionNumber}.` })
      } catch (error) {
        setLessonSaveStatus({
          kind: 'error',
          message: `Your changes weren’t saved: ${toApiError(error, 'Couldn’t save the changes.').message.replace(/[.!?]?$/, '.')} They’re still in the lesson below.`,
          retry: createdBy,
        })
      } finally {
        setFinishedVersionRequestId(requestId)
      }
    })
    // Only a confirmation saves; the lesson's current content is read when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionRequest])

  const canvasProps: LessonWorkspaceCanvasProps = {
    saveStatus: lessonSaveStatus,
    isSavingVersion,
    onEditsSaved: () => requestLessonVersion('teacher'),
    onRetrySave: requestLessonVersion,
    editor: revisionEditor,
    lesson: lessonDocument,
    lessonLinkId,
    linkClasses: myClasses
      .filter((classroom) => classroom.lessonIds.includes(lessonLinkId))
      .map((classroom) => ({ id: classroom.id, label: classDisplayName(classroom) })),
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

  // The class an activity planned on Lesson Planning belongs to: the class
  // Lesson Planning was opened for, else the classes holding the Library
  // lesson open in the workspace. Never a default or selected class — with
  // neither, the activity has no class and no link.
  const activityLinkClasses: LinkClass[] = (
    planningTargetClass
      ? [planningTargetClass]
      : workspaceLessonId
        ? myClasses.filter((classroom) => classroom.lessonIds.includes(workspaceLessonId))
        : []
  ).map((classroom) => ({ id: classroom.id, label: classDisplayName(classroom) }))

  const planningPanelProps = {
    planningTab,
    setPlanningTab,
    revisionEditor,
    isSavingVersion,
    // A teacher's own state framework comes first; NGSS otherwise.
    defaultFramework: (currentAccount.state ?? 'NGSS') as StandardsFrameworkId,
    formSeed: planningFormSeed,
    // A saved demo lesson opened as-is (from the Library), not generated here.
    savedLessonOpen: planningFormSeed !== null && lessonGenerated && lessonGeneratedWith === null,
    classGradeLevel: activityLinkClasses.length === 1 ? (myClasses.find((classroom) => classroom.id === activityLinkClasses[0].id)?.gradeLevel ?? null) : null,
  }

  // Student Feedback's URL names the lesson's assignment and the class (see
  // StudentFeedbackRoute), so it can be reloaded or shared as is.
  useEffect(() => {
    let hash: string = activePage
    if (activePage === 'student-feedback') {
      const classId = studentAssignment?.classId ?? studentFeedbackClassId
      if (studentAssignment) {
        hash = studentFeedbackHash({ lessonId: studentAssignment.lessonId, classId, taskId: null, link: studentAssignment })
      } else if (studentFeedbackTask) {
        hash = studentFeedbackHash({ lessonId: studentFeedbackTask.lessonId, classId, taskId: studentFeedbackTask.taskId, link: null })
      }
    }
    if (activePage === 'student-reports' && studentReportsRoute) hash = studentReportsHash(studentReportsRoute)
    window.location.hash = hash
  }, [activePage, studentAssignment, studentFeedbackClassId, studentFeedbackTask, studentReportsRoute])

  useEffect(() => {
    // Follows a link opened in this tab — a Student Feedback link included.
    const handleHashChange = () => {
      const route = readStudentFeedbackRoute()
      const demoAssignment = route ? findDemoAssignment(route.lessonId, route.taskId) : null
      setStudentAssignment(route?.link ?? null)
      setStudentFeedbackClassId(route?.classId ?? null)
      setStudentFeedbackTask(route?.taskId ? { lessonId: route.lessonId, taskId: route.taskId } : null)
      if (demoAssignment) setStudentFeedbackTab(demoAssignment.modelTab)
      const reportsRoute = readStudentReportsRoute()
      if (reportsRoute) setStudentReportsRoute(reportsRoute)
      setActivePage(getInitialPage(enteredPrototypeRef.current))
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

  // The class whose students may sign in to Student Feedback: a link names
  // its class; a Library card passes the class it was opened under; the main
  // nav's demo page uses its demo class.
  const studentLoginClassId = studentAssignment
    ? (studentAssignment.classId ?? studentFeedbackClassId)
    : (studentFeedbackClassId ?? demoStudentFeedbackClassId)

  // With Supabase Auth, every teacher page needs a signed-in teacher;
  // Student Feedback stays open to students.
  // Leaving the demo in Supabase Mode: AppRoot is about to open a fresh app
  // at Login, so don't show the demo's (mock) login form meanwhile.
  if (appMode === 'supabase' && session.kind === 'demo' && activePage === 'login') return null
  const needsTeacherLogin = realAuth && session.kind !== 'teacher' && activePage !== 'student-feedback'
  if (activePage === 'login' || needsTeacherLogin) {
    return <LoginPage authKind={realAuth ? 'supabase' : 'mock'} onLogin={handleLogin} onExploreDemo={handleExploreDemo} />
  }

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
              onOpenStudentReports: handleOpenStudentReports,
            }}
            onAddLesson={handleAddLessonToClass}
          />
        )}

        {remoteLessonsError && (activePage === 'library' || activePage === 'lesson-generator') && (
          <p className="roster-error" role="alert">
            {remoteLessonsError}
          </p>
        )}
        {activePage === 'class-setup' && remoteClassesStatus.state === 'loading' && (
          <p className="empty-state-support" role="status">
            Loading your classes…
          </p>
        )}
        {activePage === 'class-setup' && remoteClassesStatus.state === 'error' && (
          <p className="roster-error" role="alert">
            {remoteClassesStatus.message}
          </p>
        )}
        {activePage === 'class-setup' && remoteClassesStatus.state !== 'loading' && (
          <ClassSetupPage
            key={currentTeacherEmail}
            remote={classSetupRemote}
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
            key={planningSessionKey}
            lessonGeneratedWith={lessonGeneratedWith}
            onStartNew={handleStartNewPlanning}
            onGenerateLessonPlan={handleGenerateLessonPlan}
            onUploadLesson={planningTargetClass ? handleUploadLesson : undefined}
            lessonGenerated={lessonGenerated}
            isGeneratingLesson={isGeneratingLesson}
            canvasProps={canvasProps}
            planningPanelProps={planningPanelProps}
            activityClasses={activityLinkClasses}
          />
        )}
        {activePage === 'student-feedback' && (
          <StudentLoginGate
            key={studentLoginClassId ?? 'no-class'}
            classId={studentLoginClassId}
            lessonTitle={
              studentAssignment?.lessonTitle ??
              libraryLessons.find((lesson) => lesson.id === studentFeedbackTask?.lessonId)?.title ??
              null
            }
            classes={libraryClasses}
            signIns={studentSignIns}
            onSignIn={(classId, studentId) => setStudentSignIns((prev) => ({ ...prev, [classId]: studentId }))}
            onSignOut={(classId) =>
              setStudentSignIns((prev) => {
                const next = { ...prev }
                delete next[classId]
                return next
              })
            }
          >
            {/* Keyed by lesson and assignment, so another lesson never keeps
                this one's conversation or work. */}
            <StudentFeedbackPage
              key={`${studentAssignment?.lessonId ?? studentFeedbackTask?.lessonId ?? ''}:${studentFeedbackTask?.taskId ?? ''}:${studentFeedbackTab}:${
                studentAssignment ? studentAssignmentHash(studentAssignment) : ''
              }`}
              lessonId={studentAssignment?.lessonId ?? studentFeedbackTask?.lessonId ?? null}
              lessonTitle={
                studentAssignment?.lessonTitle ?? libraryLessons.find((lesson) => lesson.id === studentFeedbackTask?.lessonId)?.title ?? null
              }
              initialModelTab={studentFeedbackTab}
              assignment={studentAssignment}
            />
          </StudentLoginGate>
        )}
        {activePage === 'class-feedback-dashboard' && (
          <FeedbackDashboardPage
            key={classFeedbackLesson.id}
            lesson={classFeedbackLesson}
            assignmentId={classFeedbackAssignmentId}
            onAssignmentChange={setClassFeedbackAssignmentId}
            workType={classFeedbackWorkType}
            onWorkTypeChange={setClassFeedbackWorkType}
            selectedPatternId={classFeedbackPatternId}
            onSelectPattern={setClassFeedbackPatternId}
            onOpenStudentReport={(studentName, assignmentId) => handleOpenStudentReport(classFeedbackLesson, studentName, assignmentId)}
          />
        )}
        {activePage === 'student-reports' && (
          <StudentReportsPage
            route={studentReportsRoute}
            lesson={studentReportsRoute ? (libraryLessons.find((lesson) => lesson.id === studentReportsRoute.lessonId) ?? null) : null}
            classroom={studentReportsRoute?.classId ? (libraryClasses.find((classroom) => classroom.id === studentReportsRoute.classId) ?? null) : null}
            students={students}
            classes={myClasses}
            lessons={libraryLessons}
            onRouteChange={setStudentReportsRoute}
            backLabel={PAGE_CONFIG.find((page) => page.id === (studentReportsReturnTo ?? 'library'))?.label ?? 'Library'}
            onBack={studentReportsReturnTo ? handleStudentReportsBack : null}
          />
        )}
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
              {PAGE_CONFIG.filter((page) => page.inNav !== false).map((page) => (
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
// Brainstorm with AI — an open conversation that feeds the lesson form
//
// The teacher talks through their lesson idea in any order, and the
// assistant responds as a planning partner — feedback, critique, and
// instructional guidance — instead of walking through the form question by
// question. When something the teacher says fits a lesson form field (the
// seven required fields or the optional Additional Customization fields),
// it's picked up as a *suggestion*: shown for review, editable, and written
// to the form only when the teacher applies it. Applying never silently
// overwrites the form — it fills an empty field or adds to what's there, and
// replacing is always an explicit choice. The Lesson Planning Notes summary
// shows each field as in the form (✓), suggested (✦), or not added yet, as
// the bridge between brainstorming and Generate Lesson — for information
// only; brainstorming never requires any field. Picking up fields is done
// locally; the assistant's wording comes from the (mock) model through
// callAiModel like every other AI reply.
// ---------------------------------------------------------------------------

type BrainstormField =
  // Required
  | 'gradeLevel'
  | 'topic'
  | 'standards'
  | 'practices'
  | 'learningObjectives'
  | 'instructionalSequence'
  | 'pacing'
  // Optional (Additional Customization)
  | 'priorInstruction'
  | 'subsequentInstruction'
  | 'differentiation'
  | 'materialsAndEquipment'
  | 'lessonTemplate'
  | 'rubric'

// A read-only view of the lesson form.
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

// Form fields filled with the teacher's own wording.
type BrainstormTextField =
  | 'topic'
  | 'learningObjectives'
  | 'instructionalSequence'
  | 'priorInstruction'
  | 'subsequentInstruction'
  | 'differentiation'
  | 'materialsAndEquipment'

// What the assistant picked up from the conversation for one form field.
// It stays a suggestion — the form doesn't change — until the teacher
// applies it. For standards and practices, `options` are everything that was
// suggested and `value` the ones still selected.
type BrainstormSuggestion =
  | { field: BrainstormTextField; value: string }
  | { field: 'gradeLevel'; value: string }
  | { field: 'standards' | 'practices'; value: string[]; options: string[] }
  | { field: 'pacing'; value: { selection: string; customMinutes: string } }

type BrainstormSuggestions = Partial<Record<BrainstormField, BrainstormSuggestion>>

type BrainstormStep = {
  field: BrainstormField
  label: string
  shortLabel: string
  // How the assistant brings the field up when it's still open.
  question: string
  optional?: boolean
  // Lesson Template / Rubric: attached as a file, never picked up from chat.
  upload?: boolean
}

// Form order: the seven required fields, then Additional Customization.
const brainstormSteps: BrainstormStep[] = [
  { field: 'gradeLevel', label: 'Grade level', shortLabel: 'Grade level', question: 'Which grade band is this lesson for?' },
  { field: 'topic', label: 'Topic', shortLabel: 'Topic', question: 'What topic or phenomenon will students explore?' },
  { field: 'standards', label: 'Standards', shortLabel: 'Standards', question: 'Which standards should this lesson address?' },
  {
    field: 'practices',
    label: 'Science Practices to Emphasize',
    shortLabel: 'Practices',
    question: 'Which science practices — modeling, explanation, or argumentation — should students emphasize?',
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
    question: 'What sequence of activities do you have in mind?',
  },
  { field: 'pacing', label: 'Pacing / Duration', shortLabel: 'Pacing', question: 'How long is the lesson?' },
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
    question: 'What materials, equipment, or technology will you use?',
    optional: true,
  },
  {
    field: 'lessonTemplate',
    label: 'Lesson Template',
    shortLabel: 'Template',
    question: 'Do you have an existing lesson template you’d like the lesson to follow?',
    optional: true,
    upload: true,
  },
  {
    field: 'rubric',
    label: 'Rubric',
    shortLabel: 'Rubric',
    question: 'Do you have a rubric for evaluating students’ products?',
    optional: true,
    upload: true,
  },
]

const brainstormStepFor = (field: BrainstormField) => brainstormSteps.find((step) => step.field === field)!
const requiredBrainstormSteps = brainstormSteps.filter((step) => !step.optional)

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

const gradeBandLabel = (gradeLevel: string) =>
  gradeLevel === '6-8' ? 'Grades 6–8' : gradeLevel === '9-12' ? 'Grades 9–12' : gradeLevel

const pacingLabel = (selection: string, customMinutes: string) =>
  selection === 'custom'
    ? `${customMinutes.trim()} minutes`
    : (pacingOptions.find((option) => option.id === selection)?.label ?? '')

const practiceLabels = (ids: readonly string[]) =>
  practiceOptions.filter((practice) => ids.includes(practice.id)).map((practice) => practice.label)

// A form field's current value, written out in full.
function brainstormAnswerText(field: BrainstormField, form: LessonFormSnapshot): string {
  switch (field) {
    case 'gradeLevel':
      return gradeBandLabel(form.gradeLevel)
    case 'standards':
      return [...form.standards, ...form.customStandards].join(', ')
    case 'pacing':
      return pacingLabel(form.pacingSelection, form.customPacingMinutes)
    case 'practices':
      return practiceLabels(form.practices).join(', ')
    case 'lessonTemplate':
      return form.lessonTemplateName
    case 'rubric':
      return form.rubricName
    default:
      return form[field]
  }
}

// A suggestion written out in full, the way it would read in the form.
function suggestionText(suggestion: BrainstormSuggestion): string {
  switch (suggestion.field) {
    case 'gradeLevel':
      return gradeBandLabel(suggestion.value)
    case 'standards':
      return suggestion.value.join(', ')
    case 'practices':
      return practiceLabels(suggestion.value).join(', ')
    case 'pacing':
      return pacingLabel(suggestion.value.selection, suggestion.value.customMinutes)
    default:
      return suggestion.value
  }
}

const normalizeForCompare = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

// Whether the form already says what the suggestion says (e.g. the teacher
// typed it in themselves), so there's nothing left to review.
function isSuggestionInForm(suggestion: BrainstormSuggestion, form: LessonFormSnapshot): boolean {
  switch (suggestion.field) {
    case 'gradeLevel':
      return form.gradeLevel === suggestion.value
    case 'standards':
      return suggestion.options.every((code) => form.standards.includes(code))
    case 'practices':
      return suggestion.options.every((id) => form.practices.includes(id))
    case 'pacing':
      return (
        durationMinutes(form.pacingSelection, form.customPacingMinutes) ===
        durationMinutes(suggestion.value.selection, suggestion.value.customMinutes)
      )
    default:
      return normalizeForCompare(form[suggestion.field]).includes(normalizeForCompare(suggestion.value))
  }
}

// A later message adds to an earlier suggestion for the same field rather
// than discarding it; a grade band or duration is simply the newest one.
function mergeSuggestion(previous: BrainstormSuggestion | undefined, next: BrainstormSuggestion): BrainstormSuggestion {
  if (!previous || previous.field !== next.field) return next
  if (
    (previous.field === 'standards' || previous.field === 'practices') &&
    (next.field === 'standards' || next.field === 'practices')
  ) {
    const union = (a: readonly string[], b: readonly string[]) => [...a, ...b.filter((item) => !a.includes(item))]
    return { field: next.field, value: union(previous.value, next.value), options: union(previous.options, next.options) }
  }
  if (previous.field === 'gradeLevel' || previous.field === 'pacing' || next.field === 'gradeLevel' || next.field === 'pacing') {
    return next
  }
  const earlier = previous.value as string
  const later = next.value as string
  return normalizeForCompare(earlier).includes(normalizeForCompare(later))
    ? previous
    : { field: next.field as BrainstormTextField, value: `${earlier} ${later}` }
}

const shortenSummaryText = (text: string) => {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > 24 ? `${clean.slice(0, 22)}…` : clean
}

type FormSummaryItem = { field: BrainstormField; label: string; value: string | null; optional: boolean }

// One bubble in Brainstorm's Lesson Planning Notes: whether a field is
// added comes from the form's actual values, so it reflects manual edits and applied
// suggestions, and never counts a suggestion that hasn't been applied.
function formCompletionSummary(form: LessonFormSnapshot): FormSummaryItem[] {
  const valueFor = (field: BrainstormField): string => {
    switch (field) {
      case 'standards': {
        const all = [...form.standards, ...form.customStandards]
        return all.length > 1 ? `${shortenSummaryText(all[0])} +${all.length - 1}` : shortenSummaryText(all[0])
      }
      case 'pacing':
        return form.pacingSelection === 'custom'
          ? `${form.customPacingMinutes.trim()} min (custom)`
          : (pacingOptions.find((option) => option.id === form.pacingSelection)?.label ?? form.pacingSelection)
      case 'practices':
        return form.practices.length === 1
          ? (practiceLabels(form.practices)[0] ?? '1 selected')
          : `${form.practices.length} selected`
      default:
        return shortenSummaryText(brainstormAnswerText(field, form))
    }
  }
  return brainstormSteps.map((step) => ({
    field: step.field,
    label: step.shortLabel,
    value: isBrainstormFieldFilled(step.field, form) ? valueFor(step.field) : null,
    optional: Boolean(step.optional),
  }))
}

// ---- Picking up lesson information from what the teacher says ----

const sentencesOf = (text: string) =>
  text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)

const sequenceMarkerPattern =
  /\b(first(ly)?|start(ing)? (with|by|off)|begin(ning)? (with|by)|then|after that|afterwards?|finally|launch|wrap up|end (with|by)|followed by)\b/gi
const countSequenceMarkers = (sentence: string) => sentence.match(sequenceMarkerPattern)?.length ?? 0

// Sentence-level fields, most specific first; a sentence feeds at most one.
const sentenceFieldPatterns: { field: BrainstormTextField; pattern: RegExp }[] = [
  {
    field: 'subsequentInstruction',
    pattern: /\b(next (lesson|class|week|unit)|after this (lesson|unit)|follow-?up lesson|following lesson|later in the unit)\b/i,
  },
  {
    field: 'priorInstruction',
    pattern: /\b(already (know|knows|learned|studied|covered|understand)|previous(ly)?|prior (knowledge|lessons?|instruction)|misconceptions?|last (week|lesson|unit))\b/i,
  },
  {
    field: 'differentiation',
    pattern: /\b(ells?|english (language )?learners|multilingual|ieps?|504|accommodat\w*|differentiat\w*|struggl\w*|advanced (students|learners)|reading levels?|special education|scaffold\w*)\b/i,
  },
  {
    field: 'learningObjectives',
    pattern: /\b((students|they|kids) (will|should|can|need to)|be able to|by the end|learning (goals?|objectives?)|objectives?|i want (students|them|my students|my class) to)\b/i,
  },
  {
    field: 'materialsAndEquipment',
    pattern: /\b(materials?|equipment|supplies|lab (equipment|materials|safety)|laptops?|chromebooks?|tablets?|ipads?|kits?|probes?|microscopes?|beakers?|goggles|poster paper|chart paper|simulations?)\b/i,
  },
]

const topicPatterns = [
  /\b(?:topic|phenomenon|unit|lesson|focus) (?:is|will be|is about|is on|focuses on)\s+([^.;!?\n]+)/i,
  /\b(?:lesson|unit) (?:on|about)\s+([^.;!?\n]+)/i,
  /\b(?:teach(?:ing)?|cover(?:ing)?|explor(?:e|ing)|investigat(?:e|ing)|study(?:ing)?)\s+(?:about\s+)?([^.;!?\n]+)/i,
  /\blearn(?:ing)? about\s+([^.;!?\n]+)/i,
]

// The topic part of a phrase like "teaching 9th grade photosynthesis to my
// class" → "Photosynthesis" (or "teaching my students about wildfires" →
// "Wildfires"), or null if it doesn't read like a topic.
function cleanTopic(raw: string): string | null {
  const topic = (/\babout\s+(.+)/i.exec(raw)?.[1] ?? raw)
    // Stops before what the teacher says *about* the topic ("…about volcanoes
    // more engaging" → "volcanoes").
    .split(/,|\s+(?:with|for|to|so|because|since|and (?:i|we|they|students)|where|using|in (?:my|our)|this|next|by|more|less|better|engaging|interesting|fun)\b/i)[0]
    .replace(/\b\d+(st|nd|rd|th)?[\s-]*grade(rs)?\b|\bgrade\s*\d+\b|\b(middle|high)[\s-]school\b/gi, '')
    .replace(/^\s*(?:the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!topic || topic.split(' ').length > 8) return null
  if (/^(them|it|this|that|these|those|how|what|why|my|our|students?|kids|class|lessons?|ideas?)\b/i.test(topic)) return null
  return topic.charAt(0).toUpperCase() + topic.slice(1)
}

// Every form field the teacher's message gives information for, as
// suggestions. `pending` (suggestions not yet reviewed) fills in context —
// e.g. a grade band mentioned earlier — but nothing here touches the form.
function extractLessonSuggestions(
  message: string,
  form: LessonFormSnapshot,
  pending: BrainstormSuggestions,
): BrainstormSuggestion[] {
  const text = message.trim()
  const lower = text.toLowerCase()
  const found: BrainstormSuggestion[] = []

  let gradeLevel: string | null = null
  if (/\b(6|7|8)(th)?[\s-]*grade|grades?\s*(6|7|8)\b|middle[\s-]school/.test(lower)) gradeLevel = '6-8'
  else if (/\b(9|10|11|12)(th)?[\s-]*grade|grades?\s*(9|10|11|12)\b|high[\s-]school|freshm[ae]n|sophomores?/.test(lower)) gradeLevel = '9-12'
  if (gradeLevel) found.push({ field: 'gradeLevel', value: gradeLevel })

  const minutes = /\b(\d{2,3})[\s-]*(?:min(?:ute)?s?)\b/.exec(lower)?.[1]
  if (minutes && Number(minutes) > 0) {
    const preset = pacingOptions.find((option) => option.id === minutes)
    found.push({
      field: 'pacing',
      value: preset ? { selection: preset.id, customMinutes: '' } : { selection: 'custom', customMinutes: minutes },
    })
  }

  const practicePatterns: Record<string, RegExp> = {
    modeling: /\bmodel(s|ing|ling)?\b/,
    explanation: /\b(construct(ing)? explanations?|explanations?|(students?|they) (will |should |can )?explain)\b/,
    argumentation: /\b(argu(e|ing|ment|mentation)|claims? (and|with|from) evidence|evidence-based)\b/,
  }
  const practices = practiceOptions.filter((practice) => practicePatterns[practice.id]?.test(lower)).map((practice) => practice.id)
  if (practices.length > 0) found.push({ field: 'practices', value: practices, options: practices })

  let topic: string | null = null
  for (const pattern of topicPatterns) {
    const match = pattern.exec(text)
    topic = match ? cleanTopic(match[1]) : null
    if (topic) break
  }
  if (topic) found.push({ field: 'topic', value: topic })

  const codes = (text.match(/\b(?:MS|HS)-[A-Z]{2,4}\d-\d\b/gi) ?? [])
    .map((code) => code.toUpperCase())
    .filter((code, index, all) => all.indexOf(code) === index && scienceStandardsBank.some((standard) => standard.code === code))
  if (codes.length > 0) {
    found.push({ field: 'standards', value: codes, options: codes })
  } else if ((topic || gradeLevel) && form.standards.length + form.customStandards.length === 0 && !pending.standards) {
    // With a topic and a grade band known (from this message, an earlier
    // suggestion, or the form), suggest the closest verified standards.
    const pendingText = (field: BrainstormField) => {
      const suggestion = pending[field]
      return suggestion && typeof suggestion.value === 'string' ? suggestion.value : ''
    }
    const band = gradeLevel ?? (pendingText('gradeLevel') || form.gradeLevel)
    const subject = topic ?? (pendingText('topic') || form.topic)
    const suggested = band && subject ? suggestStandards(form.framework, band, subject, [], 2).map((standard) => standard.code) : []
    if (suggested.length > 0) found.push({ field: 'standards', value: suggested, options: suggested })
  }

  const sentences = sentencesOf(text)
  const sequenceSentenceCount = sentences.filter((sentence) => countSequenceMarkers(sentence) > 0).length
  const bySentence = new Map<BrainstormTextField, string[]>()
  for (const sentence of sentences) {
    const markers = countSequenceMarkers(sentence)
    const specific = sentenceFieldPatterns.slice(0, 3).find((item) => item.pattern.test(sentence))
    const field: BrainstormTextField | undefined =
      specific?.field ??
      (markers >= 2 || (markers > 0 && sequenceSentenceCount >= 2)
        ? 'instructionalSequence'
        : sentenceFieldPatterns.slice(3).find((item) => item.pattern.test(sentence))?.field)
    // A bare question to the assistant isn't lesson content.
    if (!field || (sentence.endsWith('?') && field !== 'instructionalSequence')) continue
    bySentence.set(field, [...(bySentence.get(field) ?? []), sentence])
  }
  for (const [field, parts] of bySentence) found.push({ field, value: parts.join(' ') })

  return found.filter((suggestion) => {
    if (isSuggestionInForm(suggestion, form)) return false
    const existing = pending[suggestion.field]
    return !existing || suggestionText(existing) !== suggestionText(suggestion)
  })
}

// ---- The assistant's reply ----

// What the teacher chose to plan when they opened Brainstorm with AI. It's
// sent with every request, so it shapes the assistant's guidance, not just
// its greeting.
type BrainstormFocus = 'lesson' | 'practice'

const brainstormFocusOptions: { id: BrainstormFocus; label: string; description: string; icon: string }[] = [
  {
    id: 'lesson',
    label: 'Whole Lesson',
    description: 'Brainstorm a lesson plan.',
    icon: '✎',
  },
  {
    id: 'practice',
    label: 'Science Practice Activity',
    description: 'Design a practice-focused activity.',
    icon: '⚗',
  },
]

type BrainstormReplyRequest =
  // `activityContext`: the grade and topic already known (from the class or
  // the conversation) when a science practice activity starts.
  | { kind: 'start'; focus: BrainstormFocus; keptExistingAnswers: boolean; activityContext?: ActivityContext }
  // The teacher changed focus partway through; the conversation carries on.
  | { kind: 'switch'; focus: BrainstormFocus; lesson: BrainstormLessonView; activityContext?: ActivityContext }
  | {
      kind: 'reply'
      focus: BrainstormFocus
      message: string
      // Form fields this message gave suggestions for.
      noticedFields: BrainstormField[]
      noticedLabels: string[]
      lesson: BrainstormLessonView
      // Required fields that are neither in the form nor suggested, and how
      // to bring each one up.
      stillOpen: { field: BrainstormField; question: string }[]
      // Required fields covered only by suggestions not yet applied.
      requiredAwaitingReview: number
      // Science practices the teacher picked with the practice bubbles
      // (practiceOptions ids) — the activity should integrate all of them.
      focusPracticeIds: string[]
      // This message is the teacher's Continue from the practice bubbles.
      fromPracticeSelection: boolean
      // An activity draft is already in the workspace (practice focus).
      hasActivityDraft: boolean
      // The grade and topic known so far (practice focus), and which of
      // them this message gave or changed.
      activityContext: ActivityContext
      contextUpdate: { grade: boolean; topic: boolean }
    }

// Science Practice Activity context sent with each brainstorm message.
type PracticeReplyContext = {
  focusPracticeIds: readonly string[]
  fromPracticeSelection: boolean
  hasActivityDraft: boolean
  activityContext: ActivityContext
  contextUpdate: { grade: boolean; topic: boolean }
}

// The lesson so far, from the form or, where empty there, suggestions.
type BrainstormLessonView = { topic: string; objectives: string; sequence: string; practices: string; practiceIds: string[] }

function brainstormLessonView(form: LessonFormSnapshot, suggestions: BrainstormSuggestions): BrainstormLessonView {
  const current = (field: BrainstormField) => {
    if (isBrainstormFieldFilled(field, form)) return brainstormAnswerText(field, form)
    const suggestion = suggestions[field]
    return suggestion ? suggestionText(suggestion) : ''
  }
  const suggestedPractices = suggestions.practices
  return {
    topic: current('topic'),
    objectives: current('learningObjectives'),
    sequence: current('instructionalSequence'),
    practices: current('practices'),
    practiceIds:
      form.practices.length > 0
        ? [...form.practices]
        : suggestedPractices?.field === 'practices'
          ? suggestedPractices.value
          : [],
  }
}

function brainstormReplyRequest(
  focus: BrainstormFocus,
  message: string,
  found: readonly BrainstormSuggestion[],
  form: LessonFormSnapshot,
  suggestions: BrainstormSuggestions,
  practice: PracticeReplyContext,
): BrainstormReplyRequest {
  const notInForm = requiredBrainstormSteps.filter((step) => !isBrainstormFieldFilled(step.field, form))
  return {
    focusPracticeIds: [...practice.focusPracticeIds],
    fromPracticeSelection: practice.fromPracticeSelection,
    hasActivityDraft: practice.hasActivityDraft,
    activityContext: practice.activityContext,
    contextUpdate: practice.contextUpdate,
    kind: 'reply',
    focus,
    message,
    noticedFields: found.map((suggestion) => suggestion.field),
    noticedLabels: found.map((suggestion) => brainstormStepFor(suggestion.field).label),
    lesson: brainstormLessonView(form, suggestions),
    stillOpen: notInForm.filter((step) => !suggestions[step.field]).map((step) => ({ field: step.field, question: step.question })),
    requiredAwaitingReview: notInForm.filter((step) => suggestions[step.field]).length,
  }
}

const joinLabels = (labels: readonly string[]) =>
  labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`

// What the assistant knows about each science practice, for the Science
// Practice Activity focus: what it means, an activity idea, and what an
// activity needs for students to really engage in it.
const practiceCoaching: Record<
  string,
  { name: string; mentions: RegExp; explain: string; idea: (topic: string) => string; needs: RegExp; missing: string }
> = {
  modeling: {
    name: 'developing and using models',
    mentions: /\bmodel(s|ing|ling)?\b/,
    explain:
      'Developing and using models means students build a representation of how something works and use it to predict and explain — for example, sketching how sound travels through air, predicting what happens in a vacuum, then revising the sketch after a bell-jar demo.',
    idea: (topic) =>
      `For ${topic || 'your topic'}, have students sketch an initial model of what they think is happening, use it to predict a new observation or data set, then revise it with a partner and annotate what changed and why.`,
    needs: /\b(revis|test|predict|mechanism|cause|evidence)\w*/i,
    missing:
      'Right now students build the model but don’t use it — have them use it to predict or explain something new, then revise it when the evidence doesn’t fit.',
  },
  explanation: {
    name: 'constructing explanations',
    mentions: /\b(explanations?|explain(ing)?|claim[- ]evidence|cer)\b/,
    explain:
      'Constructing explanations means students make a claim about why something happens and connect it to evidence with reasoning — for example, “Ice melts faster on metal because metal transfers thermal energy faster, as our temperature data show.”',
    idea: (topic) =>
      `For ${topic || 'your topic'}, give students a puzzling observation, have them draft a claim–evidence–reasoning explanation, then trade with a partner who checks whether the reasoning really links the evidence to the claim before they revise.`,
    needs: /\b(evidence|reason\w*|claim)\b/i,
    missing:
      'Consider asking students to connect their claim to specific evidence with reasoning, so the activity produces an explanation rather than a description.',
  },
  argumentation: {
    name: 'engaging in argument from evidence',
    mentions: /\b(argu(e|ing|ment|mentation)|debate|counter-?argument)\b/,
    explain:
      'Engaging in argument from evidence means students defend and critique claims with evidence — for example, two groups with different food web models debating which one better fits the population data, then revising.',
    idea: (topic) =>
      `For ${topic || 'your topic'}, pose two competing claims, give groups a set of evidence cards, and have them argue for the better-supported claim — then each group responds to one counterargument from another group.`,
    needs: /\b(critique|counter|compet|disagree|debate|respond|rebut|question each other)\w*/i,
    missing:
      'For real argumentation, students need to respond to each other — build in a step where groups critique a competing claim or answer a counterargument.',
  },
}

// The bubbles under the Science Practice Activity welcome message. Teachers
// can pick any number before Continue, or skip them and just type.
const practiceFocusBubbles: { id: string; label: string }[] = [
  { id: 'modeling', label: 'Developing and Using Models' },
  { id: 'explanation', label: 'Constructing Explanations' },
  { id: 'argumentation', label: 'Engaging in Argument from Evidence' },
]

// One activity idea that weaves two or more practices together, so each
// practice feeds the next instead of becoming a separate task.
function integratedPracticeIdea(ids: readonly string[], topic: string): string {
  const has = (id: string) => ids.includes(id)
  const subject = topic || 'your topic'
  const names = joinLabels(ids.map((id) => practiceCoaching[id]?.name).filter(Boolean))
  const lead = `${names.charAt(0).toUpperCase()}${names.slice(1)} fit well into one activity, with each practice feeding the next.`
  if (has('modeling') && has('explanation') && has('argumentation')) {
    return `${lead} For ${subject}, students sketch an initial model of the phenomenon, use it to construct an explanation of why it happens, then argue from evidence with another group about whose explanation the data better supports — and revise their models based on that discussion.`
  }
  if (has('modeling') && has('explanation')) {
    return `${lead} For ${subject}, students develop a model of what’s happening, then use it as the reasoning in an explanation of the phenomenon — revising the model wherever their explanation doesn’t hold up against the evidence.`
  }
  if (has('modeling') && has('argumentation')) {
    return `${lead} For ${subject}, groups build competing models, then argue from evidence about which one better accounts for a new observation — and revise their own model in light of the strongest critique.`
  }
  return `${lead} For ${subject}, students draft explanations for a puzzling observation, then pair with a group whose explanation differs and argue from evidence about which is better supported — revising their own explanation afterward.`
}

// ---- Teaching context for a practice activity ----
//
// A practice activity is designed for the teacher's grade level and topic,
// which the assistant asks for in the conversation (never through the
// lesson form). The mock model can only use them through keyword-matched
// topic notes and grade-band templates — it doesn't understand topics.

type GradeBand = 'K-2' | '3-5' | '6-8' | '9-12'
type ActivityGrade = { label: string; band: GradeBand }
// What the teacher has told the assistant so far; each is null until given.
type ActivityContext = { grade: ActivityGrade | null; topic: string | null; phenomenon: string | null }

const emptyActivityContext: ActivityContext = { grade: null, topic: null, phenomenon: null }

const gradeBandFor = (grade: number): GradeBand => (grade <= 2 ? 'K-2' : grade <= 5 ? '3-5' : grade <= 8 ? '6-8' : '9-12')

const gradeWords: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
}

// Matches any grade phrase, so it can be stripped from a message.
const gradePhrasePattern =
  /\b(?:(?:1[0-2]|[1-9])(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)[\s-]*grade(?:rs?)?\b|\bgrades?\s*(?:1[0-2]|[1-9])\b|\b(?:middle|high|elementary)[\s-]school(?:ers?)?\b|\bkindergarten(?:ers?)?\b|\b(?:freshm[ae]n|sophomores?|juniors|seniors)\b/gi

// "8th-grade students", "grade 8", "eighth graders", "middle school" → a grade.
function extractActivityGrade(text: string): ActivityGrade | null {
  const lower = text.toLowerCase()
  if (/\bkindergarten/.test(lower)) return { label: 'Kindergarten', band: 'K-2' }
  const numbered =
    /\b(1[0-2]|[1-9])(?:st|nd|rd|th)?[\s-]*grade/.exec(lower)?.[1] ??
    /\bgrades?\s*(1[0-2]|[1-9])\b/.exec(lower)?.[1] ??
    String(gradeWords[/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)[\s-]*grade/.exec(lower)?.[1] ?? ''] ?? '')
  const grade = Number(numbered) || ({ freshman: 9, freshmen: 9, sophomore: 10, sophomores: 10, juniors: 11, seniors: 12 } as Record<string, number>)[
    /\b(freshm[ae]n|sophomores?|juniors|seniors)\b/.exec(lower)?.[1] ?? ''
  ]
  if (grade) return { label: `Grade ${grade}`, band: gradeBandFor(grade) }
  if (/\bmiddle[\s-]school/.test(lower)) return { label: 'Middle school (Grades 6–8)', band: '6-8' }
  if (/\bhigh[\s-]school/.test(lower)) return { label: 'High school (Grades 9–12)', band: '9-12' }
  if (/\belementary/.test(lower)) return { label: 'Elementary school (Grades 3–5)', band: '3-5' }
  return null
}

const titleSmallWords = /^(and|or|of|the|a|an|in|on|to|for|with|at|by|from)$/
function titleCaseTopic(topic: string): string {
  return topic
    .split(' ')
    .map((word, index) => (index > 0 && titleSmallWords.test(word.toLowerCase()) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ')
}

// The topic and phenomenon in a message. `answeringContext` is set when the
// assistant just asked for them, so a bare answer ("8th grade, ecosystems")
// counts as the topic.
function extractActivityTopic(message: string, answeringContext: boolean): { topic: string | null; phenomenon: string | null } {
  const text = message.trim()
  // A phenomenon is often a question ("the phenomenon is why ice melts…"),
  // which the lesson topic patterns skip.
  const phenomenon = /\bphenomenon is\s+([^.;!?\n]+)/i.exec(text)?.[1].trim() ?? null
  const changed = /\b(?:change|switch)\w* (?:the |our )?(?:topic|unit) to\s+([^.;!?\n]+)/i.exec(text)?.[1]
  let topic = changed ? cleanTopic(changed) : null
  if (!topic && !phenomenon) {
    for (const pattern of topicPatterns) {
      const match = pattern.exec(text)
      topic = match ? cleanTopic(match[1]) : null
      if (topic) break
    }
  }
  if (!topic && !phenomenon && answeringContext && !/\?\s*$/.test(text)) {
    const about = /\babout\s+([^.;!?\n]+)/i.exec(text)?.[1]
    const rest = (about ?? text)
      .replace(gradePhrasePattern, ' ')
      .replace(
        /\b(i'?m|i’m|i am|i|we'?re|we’re|we are|we|they'?re|they’re|they|them|are|is|am|be|in|at|of|on|a|an|the|this|that|year|now|currently|right|both|so|yes|ok|okay|teaching|teach|my|our|students?|kids|class(es)?|graders?|level|science|it'?s|it’s|the topic is|topic)\b/gi,
        ' ',
      )
      .replace(/[,.;:!-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    // A topic needs at least one real word, not leftover letters.
    if (rest && rest.split(' ').length <= 6 && /[a-z]{3,}/i.test(rest)) topic = cleanTopic(rest)
  }
  return { topic: topic ? titleCaseTopic(topic) : null, phenomenon }
}

// Built-in notes for common topics: what students could model, predict,
// explain, and argue about. Matched by keyword only — a topic outside these
// gets general wording (see generalTopicNotes).
type TopicNotes = {
  // What the notes cover, shown to the teacher.
  covers: string
  matches: RegExp
  phenomenon: string
  // What students model, and what the model should include.
  system: string
  parts: string
  // Something students use the model to predict.
  prediction: string
  // Data or observations students use as evidence.
  evidence: string
  // The how/why question students explain.
  question: string
  // Competing claims to argue between.
  claims: [string, string]
  // What the model is called ("food web model").
  product: string
}

const topicNotesBank: TopicNotes[] = [
  // The two demo lessons (their activity drafts use prewritten templates —
  // see templateActivityDraft — and the chat matches them).
  {
    covers: 'the Zombie Fires demo lesson',
    matches: /zombie|peat|permafrost|overwinter/,
    phenomenon: 'zombie fires smolder underground through the Arctic winter and flare up again in spring',
    system: 'how matter (peat carbon) and energy (fire) flow between the biosphere and atmosphere',
    parts: 'the peat layer, permafrost, fire, and atmosphere, with arrows for carbon and energy',
    prediction: 'how carbon release changes as permafrost thaws',
    evidence: 'CO₂ emissions data from recent Arctic fire seasons',
    question: 'how zombie fires keep burning under snow and ice',
    claims: ['warming temperatures drive zombie fires', 'human land use plays the bigger role'],
    product: 'zombie fire model',
  },
  {
    covers: 'the COVID Virus demo lesson',
    matches: /covid|coronavirus|sars|\bvirus|soap|hand ?wash/,
    phenomenon: 'washing hands with soap breaks apart the virus that causes COVID-19',
    system: 'the virus’s structure and how it enters and replicates in host cells',
    parts: 'spike proteins, the fatty envelope, genetic material, and a soap molecule’s hydrophilic head and hydrophobic tail',
    prediction: 'what happens to the virus’s fatty envelope when soap is added',
    evidence: 'a demonstration of soap breaking up oil in water',
    question: 'why washing with soap protects against infection',
    claims: ['handwashing with soap is more effective', 'hand sanitizer is more effective'],
    product: 'virus model',
  },
  {
    covers: 'the water cycle',
    matches: /water cycle|groundwater|precipitation|puddle/,
    phenomenon: 'puddles disappear after a rainstorm, and dew forms on grass overnight',
    system: 'how water moves between the land, oceans, and atmosphere',
    parts: 'where water is stored, how it moves, and what energy drives each change',
    prediction: 'how fast a puddle will disappear on a hot day compared with a cold one',
    evidence: 'observations of evaporation and condensation in covered and uncovered containers',
    question: 'where the water in a puddle goes',
    claims: ['the water soaks into the ground', 'the water evaporates into the air as water vapor'],
    product: 'water cycle model',
  },
  {
    covers: 'ecosystems, food webs, and energy flow',
    matches: /ecosystem|food (web|chain)|producer|consumer|decomposer|predator|prey|trophic|biome|habitat|population/,
    phenomenon: 'after wolves returned to Yellowstone, the elk population dropped and streamside plants grew back',
    system: 'the food web — how energy moves from the sun to producers, consumers, and decomposers',
    parts: 'the organisms, arrows showing the direction energy flows, and how much energy reaches each level',
    prediction: 'what happens to the other populations if one species is removed',
    evidence: 'population data from before and after a change, such as wolves returning to Yellowstone',
    question: 'why an ecosystem supports far fewer top predators than producers',
    claims: [
      'removing a top predator helps an ecosystem because more prey survive',
      'removing a top predator harms an ecosystem because prey overconsume the producers',
    ],
    product: 'food web model',
  },
  {
    covers: 'photosynthesis and cellular respiration',
    matches: /photosynth|cellular respiration|chloroplast|glucose|plant growth|plants? (make|grow|get)/,
    phenomenon: 'a tiny seed grows into a tree weighing tons, while the soil around it barely changes',
    system: 'how a plant takes in carbon dioxide, water, and light energy and turns them into the sugars it uses to grow',
    parts: 'the inputs and outputs, where they enter and leave the plant, and where the energy comes from',
    prediction: 'how a plant’s growth changes with less light or less carbon dioxide',
    evidence: 'data from a plant-growth or Elodea oxygen-bubble experiment under different light levels',
    question: 'where a growing tree’s mass comes from',
    claims: ['most of a tree’s mass comes from the soil', 'most of a tree’s mass comes from carbon dioxide in the air'],
    product: 'photosynthesis model',
  },
  {
    covers: 'matter, particles, and thermal energy',
    matches: /states? of matter|phase change|melt|freez|boil|evaporat|condens|thermal|heat|temperature|particle|insulat|conduct/,
    phenomenon: 'an ice cube melts faster on a metal tray than on a plastic one, even though both are at room temperature',
    system: 'how particles move and how thermal energy transfers between objects',
    parts: 'particles drawn at different temperatures and arrows showing which way thermal energy moves',
    prediction: 'which material will melt an ice cube fastest',
    evidence: 'temperature and melting-time measurements for different materials',
    question: 'why some materials feel colder than others at the same temperature',
    claims: ['metal is colder than plastic', 'metal transfers thermal energy away from your hand faster than plastic'],
    product: 'particle model',
  },
  {
    covers: 'chemical reactions and conservation of matter',
    matches: /chemical (reaction|change)|reactant|conservation of (mass|matter)|\batoms?\b|molecule/,
    phenomenon: 'a sealed bag of baking soda and vinegar puffs up, but its mass stays the same',
    system: 'how atoms rearrange during a chemical reaction',
    parts: 'the atoms in the reactants and products, showing that none are created or destroyed',
    prediction: 'how the mass will compare before and after the reaction in an open versus a closed container',
    evidence: 'mass measurements before and after a reaction',
    question: 'why mass seems to disappear in an open container but not a closed one',
    claims: ['mass is lost when a reaction makes gas', 'mass is conserved, and the gas escapes the open container'],
    product: 'atom-level model',
  },
  {
    covers: 'forces and motion',
    matches: /force|motion|newton|friction|gravity|momentum|collision|speed|velocity|accelerat/,
    phenomenon: 'in a crash-test video, the dummy keeps moving forward when the car suddenly stops',
    system: 'the forces acting on an object and how they change its motion',
    parts: 'force arrows (size and direction) on each object before, during, and after an interaction',
    prediction: 'how the motion changes if the mass or the force changes',
    evidence: 'distance and time data from cart or ramp trials',
    question: 'why a moving object keeps moving or changes direction',
    claims: ['a moving object needs a constant force to keep moving', 'a moving object keeps moving unless a net force acts on it'],
    product: 'force diagram',
  },
  {
    covers: 'weather, climate, and Earth’s energy balance',
    matches: /weather|climate|greenhouse|global warming|atmospher|air mass|storm|hurricane/,
    phenomenon: 'the average temperature where you live has risen over the last 50 years',
    system: 'how energy from the sun enters and leaves Earth’s atmosphere',
    parts: 'incoming sunlight, energy radiated back to space, and how greenhouse gases change what escapes',
    prediction: 'what happens to temperature if greenhouse gas levels keep rising',
    evidence: 'temperature and carbon dioxide graphs over time',
    question: 'why Earth’s average temperature is rising',
    claims: ['rising temperatures are mainly caused by natural cycles', 'rising temperatures are mainly caused by greenhouse gases from human activity'],
    product: 'energy-balance model',
  },
  {
    covers: 'plate tectonics and Earth’s surface',
    matches: /plate|tectonic|earthquake|volcano|rock cycle|erosion|landform|mountain|fossil|continent/,
    phenomenon: 'matching fossils and rock layers are found on continents separated by an ocean',
    system: 'how Earth’s plates move and shape the surface over time',
    parts: 'the plates, the direction they move, and what forms at their boundaries',
    prediction: 'where earthquakes and volcanoes are most likely to happen',
    evidence: 'maps of earthquake, volcano, and fossil locations',
    question: 'why earthquakes and volcanoes cluster in certain places',
    claims: ['the continents have always been where they are now', 'the continents have moved over millions of years'],
    product: 'plate boundary model',
  },
  {
    covers: 'waves, sound, and light',
    matches: /wave|sound|light|vibrat|reflect|refract|wavelength|frequenc/,
    phenomenon: 'a straw looks bent where it enters a glass of water',
    system: 'how a wave carries energy from a source through a material',
    parts: 'the source, the material it travels through, and how the wave changes along the way',
    prediction: 'what happens to the sound or light when the material changes',
    evidence: 'observations from tuning forks, slinkies, or light passing through different materials',
    question: 'how energy travels from the source to your ear or eye',
    claims: ['sound travels by air moving from the source to your ear', 'sound travels as a vibration passed from particle to particle'],
    product: 'wave model',
  },
  {
    covers: 'heredity and genetics',
    matches: /gene|heredit|inherit|\bdna\b|trait|allele|mutation|offspring/,
    phenomenon: 'two brown-eyed parents have a blue-eyed child',
    system: 'how traits pass from parents to offspring through genes',
    parts: 'each parent’s alleles, how they combine, and the resulting traits',
    prediction: 'the chances of offspring having a particular trait',
    evidence: 'family pedigree data and expected versus observed offspring ratios',
    question: 'how a child can have a trait neither parent shows',
    claims: ['offspring are a blend of their parents’ traits', 'offspring get one allele from each parent, and some alleles can stay hidden'],
    product: 'inheritance model',
  },
  {
    covers: 'natural selection and evolution',
    matches: /evolution|natural selection|adaptation|species|variation|extinct/,
    phenomenon: 'peppered moths changed from mostly light to mostly dark during the Industrial Revolution',
    system: 'how variation and selection change a population over generations',
    parts: 'variation among individuals, the environmental pressure, who survives and reproduces, and the next generation',
    prediction: 'how the population would change if the environment changed again',
    evidence: 'counts of light and dark moths over many years',
    question: 'why the moth population changed color',
    claims: ['individual moths changed color to survive', 'darker moths survived and reproduced more, so the population changed'],
    product: 'natural selection model',
  },
  {
    covers: 'cells and body systems',
    matches: /\bcells?\b|organelle|body system|digest|circulat|respiratory|immune|heart|lung/,
    phenomenon: 'your heart rate and breathing both speed up during exercise',
    system: 'how body systems and cells work together to keep the body running',
    parts: 'the organs and cells involved and what moves between them',
    prediction: 'what happens when one part of the system can’t keep up',
    evidence: 'heart rate and breathing data before and after exercise',
    question: 'why heart rate and breathing increase together during exercise',
    claims: ['the heart and lungs work independently', 'the heart and lungs work together to deliver the oxygen cells need for energy'],
    product: 'body systems model',
  },
  {
    covers: 'the Sun, Earth, and Moon',
    matches: /\bmoon\b|phases|season|solar system|planet|orbit|eclipse|\bstars?\b/,
    phenomenon: 'the Moon seems to change shape over the course of a month',
    system: 'how the Sun, Earth, and Moon are positioned and lit over time',
    parts: 'the positions of the Sun, Earth, and Moon, and which side of the Moon is lit',
    prediction: 'what the Moon will look like a week from now',
    evidence: 'a month of Moon observations or photos',
    question: 'why the Moon’s shape seems to change',
    claims: ['Earth’s shadow causes the Moon’s phases', 'the phases depend on how much of the Moon’s lit side we can see'],
    product: 'Sun–Earth–Moon model',
  },
  {
    covers: 'electricity and circuits',
    matches: /circuit|electric|current|battery|magnet/,
    phenomenon: 'a bulb lights in one circuit but not in another built from the same parts',
    system: 'how electric current flows through a circuit',
    parts: 'the battery, wires, and bulbs, and the path the current takes',
    prediction: 'what happens to the brightness when another bulb is added',
    evidence: 'bulb brightness in different circuit arrangements',
    question: 'why a bulb lights in some arrangements but not others',
    claims: ['current gets used up by the first bulb', 'current flows in a complete loop and is the same all the way around a series circuit'],
    product: 'circuit model',
  },
]

// Wording for a topic the bank doesn't cover: built from the teacher's own
// words, with nothing claimed about the topic itself.
function generalTopicNotes(topic: string, phenomenon: string | null): TopicNotes {
  const subject = topic.toLowerCase()
  return {
    covers: '',
    matches: /$^/,
    phenomenon: phenomenon ?? `an observation or data set about ${subject} that students can’t yet fully explain`,
    system: `what is happening in ${phenomenon ?? subject} and what causes it`,
    parts: 'the key parts, how they interact, and what causes the change students observe',
    prediction: `a new observation about ${subject}`,
    evidence: `data or observations about ${subject} that you provide`,
    question: phenomenon ?? `how or why the phenomenon in ${subject} happens`,
    claims: [`one explanation of ${phenomenon ?? subject} is better supported`, 'a competing explanation is'],
    product: 'model',
  }
}

// How each practice looks at a grade band.
type GradeBandSupport = {
  // How students build a model, and what that model is.
  model: string
  modelMedium: string
  // The form an explanation takes, and what it's called as a product.
  explainWith: string
  explanationProduct: string
  // How students argue.
  argue: string
  revision: string
  // Supports to build in.
  scaffold: string
  // Shorter forms for chat replies.
  modelShort: string
  explainShort: string
  argueShort: string
  scaffoldShort: string
}

const gradeBandSupports: Record<GradeBand, GradeBandSupport> = {
  'K-2': {
    model: 'draw and label a picture',
    modelMedium: 'a labeled drawing',
    explainWith: 'the sentence frame “I think ___ because I saw ___”',
    explanationProduct: 'sentence-frame explanation',
    argue: 'talk as a whole class, using “I agree / I disagree because…”, about',
    revision: 'add to or change their drawing in a different color',
    scaffold: 'picture cards, hands-on observation, and sentence frames; keep each part short and do the writing together',
    modelShort: 'draw and label a picture',
    explainShort: 'use a sentence frame to explain',
    argueShort: 'talk as a class about',
    scaffoldShort: 'picture cards and sentence frames',
  },
  '3-5': {
    model: 'draw a labeled diagram with arrows',
    modelMedium: 'a labeled diagram with arrows',
    explainWith: 'a claim and two pieces of evidence, using sentence starters',
    explanationProduct: 'claim with two pieces of evidence',
    argue: 'debate with a partner, then share with the class which evidence convinced them, about',
    revision: 'revise their diagram in a different color and say what changed',
    scaffold: 'a word bank, sentence starters, and partner talk before writing',
    modelShort: 'draw a labeled diagram',
    explainShort: 'write a claim with two pieces of evidence explaining',
    argueShort: 'debate with a partner about',
    scaffoldShort: 'a word bank and sentence starters',
  },
  '6-8': {
    model: 'build a diagram with labeled parts and arrows showing interactions',
    modelMedium: 'a diagram with labeled parts and interaction arrows',
    explainWith: 'a claim–evidence–reasoning (CER) explanation',
    explanationProduct: 'CER explanation',
    argue: 'argue in small groups, using evidence cards, about',
    revision: 'revise their model and annotate what changed and why',
    scaffold: 'a CER organizer, evidence cards, and a model checklist (parts, interactions, cause)',
    modelShort: 'build a labeled diagram with interaction arrows',
    explainShort: 'write a CER explaining',
    argueShort: 'argue in small groups about',
    scaffoldShort: 'a CER organizer and evidence cards',
  },
  '9-12': {
    model: 'build a model of the underlying mechanism, with quantitative relationships where the data allow',
    modelMedium: 'a mechanistic model',
    explainWith: 'an explanation that applies scientific principles to the data',
    explanationProduct: 'written explanation applying scientific principles',
    argue: 'evaluate competing claims, weighing the strength and limitations of the evidence, about',
    revision: 'revise their model and justify each change with evidence',
    scaffold: 'raw data to analyze, a critique protocol, and an expectation that students address the limits of their evidence',
    modelShort: 'build a mechanistic model',
    explainShort: 'use scientific principles and data to explain',
    argueShort: 'evaluate competing claims about',
    scaffoldShort: 'raw data and a critique protocol',
  },
}

// Everything the mock model knows to tailor an activity, once the grade and
// topic are known.
type ActivityTeaching = { grade: ActivityGrade; topic: string; notes: TopicNotes; matched: boolean; support: GradeBandSupport }

function activityTeaching(context: ActivityContext): ActivityTeaching | null {
  if (!context.grade || !context.topic) return null
  const text = `${context.topic} ${context.phenomenon ?? ''}`.toLowerCase()
  const matched = topicNotesBank.find((notes) => notes.matches.test(text))
  const notes = matched
    ? { ...matched, ...(context.phenomenon ? { phenomenon: context.phenomenon } : {}) }
    : generalTopicNotes(context.topic, context.phenomenon)
  return { grade: context.grade, topic: context.topic, notes, matched: Boolean(matched), support: gradeBandSupports[context.grade.band] }
}

// "Grade 8 students", "middle school students", "kindergartners".
function gradeAudience(grade: ActivityGrade): string {
  if (grade.label === 'Kindergarten') return 'kindergartners'
  return grade.label.startsWith('Grade') ? `${grade.label} students` : `${grade.label.split(' (')[0].toLowerCase()} students`
}

// One activity idea for the practices, tailored to the grade and topic.
function contextualActivityIdea(ids: readonly string[], teaching: ActivityTeaching): string {
  const { grade, topic, notes, support, matched } = teaching
  const has = (id: string) => ids.includes(id)
  // Two sentences: the idea, then its anchor phenomenon (or, for a topic
  // without notes, that the idea is general).
  // One practice gets its fuller form; combined practices stay brief so each
  // feeds the next in one sentence.
  const steps: string[] = []
  const single = ids.length === 1
  if (has('modeling')) steps.push(single ? `${support.modelShort} (a ${notes.product}) and use it to predict ${notes.prediction}` : `${support.modelShort} (a ${notes.product})`)
  if (has('explanation')) steps.push(has('modeling') ? `use it to explain ${notes.question}` : `${support.explainShort} ${notes.question}`)
  if (has('argumentation')) {
    steps.push(
      single
        ? `${support.argueShort} ${notes.question}`
        : `${support.argueShort} which ${has('explanation') ? 'explanation' : 'model'} the evidence best supports`,
    )
  }
  const revised = has('modeling') ? 'model' : has('explanation') ? 'explanation' : 'claim'
  const audience = gradeAudience(grade)
  const idea = `${audience.charAt(0).toUpperCase()}${audience.slice(1)} studying ${topic.toLowerCase()} could ${steps.join(', then ')}, and finally revise their ${revised}.`
  return matched
    ? `${idea} A phenomenon to anchor it: ${notes.phenomenon.replace(/[.!]$/, '')}.`
    : `${idea} I don’t have built-in notes on ${topic.toLowerCase()}, so this idea is general.`
}

// Which grade and/or topic is still missing, as the question to ask.
function missingContextQuestion(context: ActivityContext): string | null {
  if (!context.grade && !context.topic) return 'What grade level and science topic are you teaching?'
  if (!context.grade) return 'What grade level are you teaching?'
  if (!context.topic) return 'What science topic are you teaching?'
  return null
}

// Simple topic-based cues for which practices could fit — a mock heuristic
// for the prototype, not a validated pedagogical recommendation. The
// teacher always makes the choice.
const practiceFitCues: { id: string; cue: RegExp; reason: (topic: string) => string }[] = [
  {
    id: 'modeling',
    cue: /cycle|system|ecosystem|food (web|chain)|structure|cell|virus|body|organ|energy|matter|atom|molecule|particle|reaction|weather|climate|season|moon|earth|plate|rock|water|wave|sound|light|force|motion|circuit|electric|magnet|fire|heat/,
    reason: (topic) => `a model helps students show the processes behind ${topic}`,
  },
  {
    id: 'explanation',
    cue: /why|cause|adapt|trait|inherit|disease|germ|cell|reaction|weather|season|erosion|heat|sound|light|phase|state|change|handwash|soap/,
    reason: (topic) => `students can explain what causes the patterns they see in ${topic}`,
  },
  {
    id: 'argumentation',
    cue: /climate|carbon|vaccin|covid|evolution|natural selection|resource|pollution|human impact|invasive|conservation|renewable|fire|ecosystem|biodiversity|health/,
    reason: (topic) => `students can weigh competing claims about ${topic} with evidence`,
  },
]

// Up to two practices whose cues match the topic (models and explanations
// when nothing matches).
function suggestedPracticesFor(teaching: ActivityTeaching): string[] {
  const topic = teaching.topic.toLowerCase()
  const fits = practiceFitCues.filter((fit) => fit.cue.test(topic)).map((fit) => fit.id)
  return fits.length > 0 ? fits.slice(0, 2) : ['modeling', 'explanation']
}

// A topic mid-sentence: lowercase, except acronyms ("COVID Virus" → "COVID virus").
function topicInSentence(topic: string): string {
  return topic
    .split(' ')
    .map((word) => (/[A-Z].*[A-Z]/.test(word) ? word : word.toLowerCase()))
    .join(' ')
}

// Once the grade and topic are known: which practices could fit, and why,
// then the teacher picks (or proposes another) — nothing is selected for them.
function practiceSuggestionReply(teaching: ActivityTeaching): string {
  const ids = suggestedPracticesFor(teaching)
  const topic = topicInSentence(teaching.topic)
  const reasons = ids.map((id) => practiceFitCues.find((fit) => fit.id === id)!.reason(topic))
  return chatReply({
    say: [
      `For ${gradeAudience(teaching.grade)} studying ${topic}, ${joinLabels(ids.map((id) => practiceCoaching[id].name))} could fit — ${joinLabels(reasons)}.`,
      'That’s a quick topic-based starting point, so go with what fits your class.',
    ],
    ask: 'Which practices would you like to focus on — select one or more below, or suggest a different one?',
  })
}

// A message that only gave the grade/topic (or picked practices) — not yet
// any discussion of the activity itself.
function isContextOnlyMessage(text: string, context: ActivityContext): boolean {
  if (/^i’d like to focus on\b/i.test(text.trim())) return true
  const lower = text.toLowerCase()
  // Naming a practice ("let's focus on constructing explanations") is
  // context too, not an activity idea.
  const practiceWords =
    /\b(develop(ing)?|us(e|ing)|models?|model(l)?ing|construct(ing)?|explanations?|explain(ing)?|engag(e|ing)|argu(e|ing|ment|mentation)|from|evidence|practices?|focus(ing)?|science)\b/g
  const mentionsContext =
    new RegExp(gradePhrasePattern.source, 'i').test(lower) ||
    [context.topic, context.phenomenon].some((part) => part && lower.includes(part.toLowerCase())) ||
    /\b(topic|unit|phenomenon)\b/.test(lower) ||
    Object.values(practiceCoaching).some((coaching) => coaching.mentions.test(lower))
  if (!mentionsContext) return false
  let rest = lower.replace(gradePhrasePattern, ' ').replace(practiceWords, ' ')
  for (const part of [context.topic, context.phenomenon]) if (part) rest = rest.replace(part.toLowerCase(), ' ')
  rest = rest.replace(
    /\b(i'?m|i’m|i am|we'?re|we’re|we are|they'?re|they’re|they are|teaching|teach|my|our|students?|kids|class(es)?|graders?|about|the|a|an|and|on|unit|topic|is|it'?s|it’s|actually|now|in|of|to|switch\w*|change\w*|let'?s|let’s|phenomenon|instead|grade|level)\b/g,
    ' ',
  )
  return rest.split(/[^a-z]+/).filter(Boolean).length < 3
}

// ---- Science Practice Activity drafts ----
//
// Science Practice Activity mode doesn't go through the lesson form: the
// brainstorm produces an Activity Draft in the right-side workspace, which
// the teacher confirms, then confirms its student-work collection
// opportunities before getting a Student Feedback link.

// A point in the activity where students submit work for feedback. All of
// an activity's opportunities belong to one assignment (one link), in order.
type CollectionOpportunity = { id: string; name: string; submission: string }

type ActivityDraft = {
  title: string
  gradeLabel: string
  topic: string
  // practiceOptions ids, in bubble order.
  practiceIds: string[]
  description: string
  // Which mock template wrote it: a demo lesson's prewritten one, or the
  // generic template filled in with the teacher's topic and practices.
  template: ActivityTemplateId
  // The activity's two student product types (what a removed one comes back as).
  products: CollectionOpportunity[]
  goal: string
  sequence: { name: string; text: string }[]
  // Grade-level supports built into the activity.
  supports: string
  // AI-identified; the teacher reviews them before the link is created.
  collection: CollectionOpportunity[]
  // What the teacher said in the brainstorm that shaped this draft.
  incorporated: string[]
  // Which built-in topic notes shaped the draft, or '' when none matched
  // and the wording is general.
  topicNotesUsed: string
}

// What Generate Activity Draft sends to the AI model: the practices, the
// teaching context, and the teacher's side of the brainstorm (never the
// lesson form).
type ActivityDraftRequest = {
  practiceIds: string[]
  context: { grade: ActivityGrade; topic: string; phenomenon: string | null }
  teacherMessages: string[]
}

// The student work collected for feedback. For the prototype every lesson
// and activity collects the same two student products within one
// assignment — a Model and an Explanation. Initial and revised submissions
// are versions of these products, never separate items or assignments.
const studentProducts: readonly CollectionOpportunity[] = [
  { id: 'model', name: 'Model', submission: 'Students develop a scientific model to represent their understanding of the phenomenon.' },
  { id: 'explanation', name: 'Explanation', submission: 'Students explain the scientific phenomenon using their models and supporting evidence.' },
]

// Lessons whose mock data collects other products than the Model and
// Explanation — still two products in one assignment. Their ids match the
// lesson's Class Feedback data (ClassFeedbackAssignment.productId).
const lessonStudentProducts: Record<string, readonly CollectionOpportunity[]> = {
  'covid-virus': [
    {
      id: 'descriptive',
      name: 'Descriptive',
      submission: 'Students describe the structure and key components of the COVID-19 virus and its interaction with host cells.',
    },
    { id: 'mechanistic', name: 'Mechanistic', submission: 'Students develop a model explaining how the virus enters host cells and replicates.' },
  ],
}

function studentProductsFor(lessonId: string | null): readonly CollectionOpportunity[] {
  return (lessonId && lessonStudentProducts[lessonId]) || studentProducts
}

function practiceCollectionPoints(): CollectionOpportunity[] {
  return studentProducts.map((product) => ({ ...product }))
}

const practiceTitleNames: Record<string, string> = {
  modeling: 'Modeling',
  explanation: 'Explaining',
  argumentation: 'Arguing from Evidence',
}

const practiceGoalVerbs: Record<string, string> = {
  modeling: 'develop and use a model',
  explanation: 'construct an evidence-based explanation',
  argumentation: 'argue from evidence',
}

// Is this teacher message an idea for the activity (rather than a question
// or the practice bubbles' Continue)?
function isActivityIdea(message: string): boolean {
  const text = message.trim()
  return !/\?\s*$/.test(text) && !/^i’d like to focus on\b/i.test(text) && text.split(/\s+/).length >= 6
}

// The prototype's prewritten activity templates for its two demo lessons,
// chosen by the teaching topic; any other topic gets the generic template.
type ActivityTemplateId = 'zombie-fires' | 'covid-virus' | 'generic'

const activityTemplateLabels: Record<Exclude<ActivityTemplateId, 'generic'>, string> = {
  'zombie-fires': 'Zombie Fires (Earth Science)',
  'covid-virus': 'COVID Virus (Life Science)',
}

function activityTemplateFor(topic: string | null, phenomenon: string | null = null): ActivityTemplateId {
  const text = `${topic ?? ''} ${phenomenon ?? ''}`.toLowerCase()
  if (/zombie|peat|permafrost|overwinter/.test(text)) return 'zombie-fires'
  if (/covid|coronavirus|sars|\bvirus|soap|hand ?wash/.test(text)) return 'covid-virus'
  return 'generic'
}

// The two student products an activity collects: the COVID demo's
// Descriptive and Mechanistic, otherwise the Model and Explanation.
function activityProductsFor(template: ActivityTemplateId): CollectionOpportunity[] {
  return studentProductsFor(template === 'covid-virus' ? 'covid-virus' : null).map((product) => ({ ...product }))
}

// A demo lesson's prewritten activity, with the steps for each selected
// practice. Fixed mock content — it doesn't change with the conversation.
function templateActivityDraft(
  template: Exclude<ActivityTemplateId, 'generic'>,
  practiceIds: readonly string[],
  grade: ActivityGrade,
  topic: string,
  ideas: string[],
): ActivityDraft {
  const has = (id: string) => practiceIds.includes(id)
  const audience = gradeAudience(grade)
  const Audience = `${audience.charAt(0).toUpperCase()}${audience.slice(1)}`
  const verbs = joinLabels(practiceIds.map((id) => practiceGoalVerbs[id]).filter(Boolean))
  const names = joinLabels(practiceIds.map((id) => practiceTitleNames[id]).filter(Boolean))
  const sequence: ActivityDraft['sequence'] = []
  let title: string
  let description: string
  let goal: string
  if (template === 'zombie-fires') {
    title = `Zombie Fires: ${names}`
    description =
      'Students investigate “zombie fires” — peat fires that smolder underground through the Arctic winter and flare up again in spring — and figure out how matter (peat carbon) and energy (fire) flow between the biosphere and atmosphere.'
    goal = `${Audience} ${verbs} to explain how zombie fires keep burning under snow and ice, and why they release so much carbon.`
    sequence.push({
      name: 'Launch',
      text: 'Show satellite images and news footage of zombie fires reigniting in Alaska and Siberia after winter. Students record what they notice and wonder about how a fire survives under snow.',
    })
    if (has('modeling')) {
      sequence.push({
        name: 'Develop an initial model',
        text: 'Students draw a model of the peat layer, permafrost, fire, and atmosphere, with arrows showing how matter (carbon) and energy move between them.',
      })
      sequence.push({
        name: 'Use the model',
        text: 'Students use their model to predict how carbon release changes as permafrost thaws, then compare the prediction with CO₂ emissions data from recent Arctic fire seasons.',
      })
    }
    if (has('explanation')) {
      sequence.push({
        name: 'Construct an explanation',
        text: 'Students explain how zombie fires keep burning under snow and ice, using the emissions data as evidence and their model as the reasoning.',
      })
    }
    if (has('argumentation')) {
      sequence.push({
        name: 'Argue from evidence',
        text: 'Groups argue whether warming temperatures or human land use plays the bigger role in zombie fires, citing the data, and respond to at least one critique.',
      })
    }
    sequence.push({ name: 'Revise', text: 'Students revise their model and explanation, noting which evidence changed their thinking.' })
  } else {
    title = `COVID Virus: ${names}`
    description =
      'Students investigate the structure of the COVID-19 virus — its spike proteins, fatty envelope, and genetic material — how it enters and replicates in host cells, and why washing with soap breaks it apart.'
    goal = `${Audience} ${verbs} to describe the virus’s structure and explain how it infects host cells and how soap disrupts it.`
    sequence.push({
      name: 'Launch',
      text: 'Show an image of the coronavirus and a short demonstration of soap breaking up oil in water. Students record what they notice and wonder about why handwashing works.',
    })
    if (has('modeling')) {
      sequence.push({
        name: 'Develop a descriptive model',
        text: 'Students draw and label the virus’s structures — spike proteins, fatty envelope, and genetic material — and a soap molecule’s hydrophilic head and hydrophobic tail.',
      })
      sequence.push({
        name: 'Develop a mechanistic model',
        text: 'Students extend their model to show how the virus enters a host cell and replicates, and how soap breaks apart the fatty envelope.',
      })
    }
    if (has('explanation')) {
      sequence.push({
        name: 'Construct an explanation',
        text: 'Students explain why washing with soap protects against infection, using the virus’s structure as evidence and their models as the reasoning.',
      })
    }
    if (has('argumentation')) {
      sequence.push({
        name: 'Argue from evidence',
        text: 'Students argue whether handwashing with soap or using hand sanitizer is more effective against the virus, citing evidence about its structure.',
      })
    }
    sequence.push({ name: 'Revise', text: 'After feedback, students revise their descriptive and mechanistic work, noting what changed and why.' })
  }
  const products = activityProductsFor(template)
  return {
    title,
    gradeLabel: grade.label,
    topic,
    practiceIds: [...practiceIds],
    description,
    template,
    products,
    goal,
    sequence,
    supports: `For ${audience}: ${gradeBandSupports[grade.band].scaffold}.`,
    collection: products.map((product) => ({ ...product })),
    incorporated: ideas.slice(-3),
    topicNotesUsed: '',
  }
}

// The mock activity model. A demo lesson's topic gets its prewritten
// template; any other topic gets the generic template: the practices'
// develop → use → revise arc, filled in from the topic notes and
// grade-band supports (see activityTeaching) and adjusted by keywords in
// what the teacher asked for.
function mockActivityDraft({ practiceIds, context, teacherMessages }: ActivityDraftRequest): ActivityDraft {
  const teaching = activityTeaching(context) as ActivityTeaching
  const { notes, support, grade, topic } = teaching
  const has = (id: string) => practiceIds.includes(id)
  const ideas = teacherMessages.filter((text) => isActivityIdea(text) && !isContextOnlyMessage(text, context))
  const template = activityTemplateFor(topic, context.phenomenon)
  if (template !== 'generic') return templateActivityDraft(template, practiceIds, grade, topic, ideas)
  const said = ideas.join(' ').toLowerCase()
  const young = grade.band === 'K-2' || grade.band === '3-5'
  const sequence: ActivityDraft['sequence'] = []

  const launchWith = /\bsimulation\b/.test(said)
    ? 'a simulation'
    : /\b(data|graph)\w*/.test(said)
      ? 'a data set or graph'
      : young
        ? 'a hands-on demonstration or picture'
        : 'a short video, image, or demonstration'
  sequence.push({
    name: 'Launch',
    text: `Introduce the phenomenon — ${notes.phenomenon.replace(/[.!]$/, '')} — with ${launchWith}. Students record what they notice and wonder${young ? ', then share aloud' : ''}.`,
  })
  if (has('modeling')) {
    sequence.push({
      name: `Develop an initial ${notes.product}`,
      text: `${young ? 'In pairs' : 'Individually or in pairs'}, students ${support.model} of ${notes.system}. The model should show ${notes.parts}.`,
    })
    sequence.push({
      name: 'Use the model',
      text: `Students use their ${notes.product} to predict ${notes.prediction}, then check the prediction against ${notes.evidence}.`,
    })
  }
  if (has('explanation')) {
    sequence.push({
      name: 'Construct an explanation',
      text: `Students explain ${notes.question}, using ${support.explainWith}${has('modeling') ? ' — with their model as the reasoning' : ''}. Evidence comes from ${notes.evidence}.`,
    })
  }
  if (has('argumentation')) {
    sequence.push({
      name: 'Argue from evidence',
      text: `${/gallery walk/.test(said) ? 'In a gallery walk, students' : 'Students'} ${support.argue} whether ${notes.claims[0]} or ${notes.claims[1]}, and respond to at least one critique.`,
    })
  }
  if (/\b(peer|partner)\b[^.]{0,30}\b(feedback|review)\b/.test(said)) {
    sequence.push({ name: 'Peer feedback', text: 'Partners trade work and give one piece of evidence-based feedback each before revising.' })
  }
  const revised = has('modeling') ? notes.product : has('explanation') ? 'explanation' : 'claim'
  sequence.push({
    name: `Revise the ${revised}`,
    text: has('modeling')
      ? `Using the evidence and what they heard from others, students ${support.revision}.`
      : `Using the evidence and what they heard from others, students revise their ${revised} and note what changed and why.`,
  })

  const collection = practiceCollectionPoints()
  if (/\b(exit ticket|reflection|reflect)\b/.test(said)) {
    sequence.push({ name: 'Reflect', text: `Students write${young ? ' or draw' : ''} a short reflection on how their thinking changed and what evidence changed it.` })
  }

  const audience = gradeAudience(grade)
  const names = practiceIds.map((id) => practiceTitleNames[id]).filter(Boolean)
  const verbs = joinLabels(practiceIds.map((id) => practiceGoalVerbs[id]).filter(Boolean))
  return {
    title: `${joinLabels(names)}: ${topic}`,
    gradeLabel: grade.label,
    topic,
    practiceIds: [...practiceIds],
    description: `Students investigate ${topic.toLowerCase()} through ${joinLabels(practiceIds.map((id) => practiceCoaching[id].name))}, starting from a phenomenon, then using and revising their thinking as evidence comes in.`,
    template: 'generic',
    products: practiceCollectionPoints(),
    goal: `${audience.charAt(0).toUpperCase()}${audience.slice(1)} ${verbs} to figure out ${notes.question}, then revise their thinking as new evidence comes in.`,
    sequence,
    supports: `For ${audience}: ${support.scaffold}.`,
    collection,
    incorporated: ideas.slice(-3),
    topicNotesUsed: teaching.matched ? notes.covers : '',
  }
}

// What the brainstorm model is asked to do, sent with each request like the
// other AI purposes' instructions. The limits apply to chat replies only —
// lesson plans, activity drafts, and form suggestions are separate outputs.
const brainstormReplyInstructions = [
  'You are the PARTNERS brainstorming partner for science teachers, in a back-and-forth chat.',
  'Reply in at most 3 sentences. Write a short reply from the start — never cut a longer one down.',
  'Ask at most one follow-up question, and only when it moves the planning forward. Explore anything else in later turns.',
  'Spend the reply on instructional guidance, constructive critique, or a concrete activity idea — no introductions, recaps, or repeated information.',
  'When the teacher asks what a science practice means, give a one-sentence explanation with a concrete example.',
  'For a science practice activity, first learn the grade level and topic (skip whatever the class or conversation already gives), then suggest practices that could fit the topic with a brief reason each. The teacher chooses — never pick practices for them.',
  'Once the grade level, topic, and practices are known, never ask for them again or ask questions just to move on: offer a concise activity idea and say the teacher can refine it or generate a draft.',
]

// The most sentences and questions in one chat reply.
const MAX_REPLY_SENTENCES = 3

// Sentences in a reply: each ends in . ! or ? (allowing a closing quote).
function replySentences(text: string): string[] {
  return text.match(/[^.!?]+(?:[.!?]+["”’)]*)(?=\s|$)/g)?.map((sentence) => sentence.trim()) ?? [text.trim()]
}

// One chat reply: what the assistant has to say, then any optional notes
// that fit, then its one question — at most three sentences in all. Each
// part is written as whole sentences; optional notes that don't fit are
// left out rather than shortened.
function chatReply({ say, notes = [], ask }: { say: string[]; notes?: string[]; ask?: string | null }): string {
  const count = (parts: readonly string[]) => parts.reduce((total, part) => total + replySentences(part).length, 0)
  const parts = [...say]
  const room = MAX_REPLY_SENTENCES - (ask ? 1 : 0)
  for (const note of notes) if (count([...parts, note]) <= room) parts.push(note)
  if (ask && count(parts) < MAX_REPLY_SENTENCES) parts.push(ask)
  const reply = parts.join(' ')
  if (import.meta.env.DEV && count(parts) > MAX_REPLY_SENTENCES) console.warn(`Brainstorm reply over ${MAX_REPLY_SENTENCES} sentences:`, reply)
  return reply
}

// The mock planning model: a brainstorming partner that gives short
// feedback and instructional guidance in light of the chosen focus — at
// most three sentences and one question per reply (see
// brainstormReplyInstructions). It mentions what it picked up for the form
// and at most gently brings up one open field; it never makes the teacher
// fill the form in order.
function mockBrainstormReply(request: BrainstormReplyRequest): string {
  if (request.kind === 'start') {
    if (request.focus === 'practice') {
      // Teaching context first; practices are suggested once it's known.
      const known = request.activityContext ?? emptyActivityContext
      const teaching = activityTeaching(known)
      if (teaching) return practiceSuggestionReply(teaching)
      if (known.grade) return `Hi! What science topic are you teaching your ${gradeAudience(known.grade)}?`
      if (known.topic) return `Hi! What grade level are you teaching ${known.topic.toLowerCase()} to?`
      return 'Hi! What grade level and science topic are you teaching?'
    }
    return chatReply({
      say: [
        'Hi! Tell me about your lesson in any order — the topic or phenomenon, your students, your goals, or activities you have in mind — and I’ll help brainstorm and critique it.',
        request.keptExistingAnswers
          ? 'Anything that belongs in the lesson form comes back as a suggestion for you to review, and I won’t change what you’ve already filled in.'
          : 'Anything that belongs in the lesson form comes back as a suggestion for you to review first.',
      ],
    })
  }
  if (request.kind === 'switch') {
    const keep = 'Everything we’ve discussed and your form suggestions are still here.'
    if (request.focus === 'practice') {
      const known = request.activityContext ?? emptyActivityContext
      const teaching = activityTeaching(known)
      if (teaching) return practiceSuggestionReply(teaching)
      return chatReply({ say: ['Switched to planning a science practice activity.', keep], ask: missingContextQuestion(known) })
    }
    return chatReply({
      say: ['Switched to planning the whole lesson.', keep],
      ask: request.lesson.topic ? `How do the activities for ${request.lesson.topic} build toward your objectives?` : 'What topic or phenomenon is the lesson about?',
    })
  }

  const {
    focus,
    message,
    noticedFields,
    noticedLabels,
    lesson,
    stillOpen,
    requiredAwaitingReview,
    focusPracticeIds,
    fromPracticeSelection,
    hasActivityDraft,
    activityContext,
    contextUpdate,
  } = request
  const lower = message.toLowerCase()
  const asking = /\?\s*$/.test(message) || /\b(help|ideas?|suggest|feedback|critique|improve|thoughts|how (can|could|do|should|would) i)\b/.test(lower)
  const noticed = new Set(noticedFields)
  const topic = lesson.topic.trim()

  if (focus === 'practice') {
    // The practices under discussion: those named in this message, else the
    // ones the teacher selected. (The lesson form's practices aren't assumed —
    // the teacher chooses the activity's practices here.)
    const named = Object.keys(practiceCoaching).filter((id) => practiceCoaching[id].mentions.test(lower))
    const practiceIds = (named.length > 0 ? named : focusPracticeIds).filter(
      (id) => practiceCoaching[id],
    )
    const coaching = practiceIds.length > 0 ? practiceCoaching[practiceIds[0]] : undefined
    const practiceNames = joinLabels(practiceIds.map((id) => practiceCoaching[id].name))
    // The grade and topic: once both are known, ideas are tailored to them;
    // until then the assistant asks for whichever is missing.
    const teaching = activityTeaching(activityContext)
    const missingQuestion = missingContextQuestion(activityContext)
    const tailorAsk = missingQuestion ? `To tailor this, ${missingQuestion.charAt(0).toLowerCase()}${missingQuestion.slice(1)}` : null
    const ideaFor = (ids: readonly string[]) =>
      teaching ? contextualActivityIdea(ids, teaching) : ids.length > 1 ? integratedPracticeIdea(ids, '') : practiceCoaching[ids[0]].idea('')
    const contextChanged = contextUpdate.grade || contextUpdate.topic
    const contextOnly = isContextOnlyMessage(message, activityContext)
    const contextNamed = [contextUpdate.grade && activityContext.grade?.label, contextUpdate.topic && activityContext.topic].filter(Boolean).join(', ')
    const wantsExplanation = /\b(what (is|does|are)|what.*(mean|look like)|explain (the |this )?practice|define)\b/.test(lower)
    const wantsIdeas = /\b(ideas?|suggest|brainstorm|activit(y|ies) (for|to|that)|give me)\b/.test(lower) && !/critique|feedback/.test(lower)
    const wantsCritique = /\b(critique|feedback|improve|what do you think|review)\b/.test(lower)
    const wantsCollection = /\b(collect\w*|submit\w*|student work|turn in|hand in|artifacts?|assess\w*)\b/.test(lower)
    // A change the teacher wants made to the activity ("add a gallery walk").
    const wantsChange =
      !asking && !contextOnly && /^(please\s+)?(add|include|change|replace|remove|drop|skip|make|use|swap|switch|let|have them|instead)\b|\binstead\b/.test(lower)
    // The activity to critique: what this message describes, else the plan so far.
    const activity =
      !contextOnly &&
      (noticed.has('instructionalSequence') || noticed.has('learningObjectives') || ((!asking || wantsCritique) && message.split(/\s+/).length >= 12))
        ? message
        : wantsCritique
          ? lesson.sequence
          : ''
    // Points to the draft once there's an idea and the teaching context.
    // Once the grade, topic, and practices are known, a draft can be
    // generated at any time — the assistant offers it instead of asking
    // more questions, and brainstorming further is up to the teacher.
    const ready = Boolean(teaching && coaching)
    const readyIdea = teaching ? `We could design an activity where students investigate ${topicInSentence(teaching.topic)} through ${practiceNames}.` : ''
    const readyNote = hasActivityDraft
      ? 'Click Regenerate Activity Draft whenever you’d like the draft updated.'
      : 'You can refine the idea with me or generate a draft to review.'
    const draftNote = ready && !(hasActivityDraft && asking) ? readyNote : null

    if (fromPracticeSelection && coaching) {
      // The teacher just picked practices: first find out who and what the
      // activity is for, unless they've already said.
      if (missingQuestion) return `Great! ${missingQuestion}`
      return chatReply({ say: [readyIdea, readyNote] })
    }
    if (contextChanged && !activity) {
      if (missingQuestion) return chatReply({ say: [`Thanks — ${contextNamed}.`], ask: missingQuestion })
      if (!coaching && teaching) return practiceSuggestionReply(teaching)
      return chatReply({ say: [`Got it — ${contextNamed}.`, readyIdea, readyNote] })
    }
    if (!coaching) {
      if (teaching && !activity) return practiceSuggestionReply(teaching)
      if (missingQuestion && !activity) return missingQuestion
      return chatReply({
        say: activity ? ['Once I know the practice, I can critique the activity through that lens.'] : [],
        ask: 'Which science practice should the activity build — developing and using models, constructing explanations, or engaging in argument from evidence?',
      })
    }
    if (wantsExplanation) {
      // A one-sentence explanation with an example for each practice asked
      // about, plus how it could look for the teacher's topic.
      const explained = named.length > 0 ? named : [practiceIds[0]]
      const tailored =
        teaching && explained.length === 1 && teaching.matched
          ? {
              modeling: `For ${teaching.topic.toLowerCase()}, that could be a ${teaching.notes.product} students use to predict ${teaching.notes.prediction}.`,
              explanation: `For ${teaching.topic.toLowerCase()}, students could explain ${teaching.notes.question}.`,
              argumentation: `For ${teaching.topic.toLowerCase()}, students could argue about ${teaching.notes.question}.`,
            }[explained[0]]
          : undefined
      return chatReply({
        say: explained.map((id) => practiceCoaching[id].explain),
        notes: [...(tailored ? [tailored] : []), ...(draftNote ? [draftNote] : [])],
        ask: tailorAsk,
      })
    }
    if (wantsChange) {
      if (hasActivityDraft) return chatReply({ say: ['Got it.', 'Click Regenerate Activity Draft to see that change in the draft, or keep refining first.'] })
      return chatReply({ say: ['Good idea — I’ll work that into the draft.'], notes: draftNote ? [draftNote] : [], ask: missingQuestion })
    }
    if (wantsCollection) {
      // What's collected for feedback: the activity's two student products,
      // in one assignment (Descriptive and Mechanistic for the COVID demo).
      const products = activityProductsFor(activityTemplateFor(activityContext.topic, activityContext.phenomenon))
      return chatReply({
        say: [
          `Students submit two products in one assignment: ${joinLabels(products.map((product) => `${product.name.toLowerCase()} work`))}.`,
          'When they revise, the new work is saved as a new version, so you can see how their thinking changed.',
        ],
        notes: draftNote ? [draftNote] : [],
        ask: tailorAsk,
      })
    }
    if (activity && (wantsCritique || !asking)) {
      // Critique through every practice in focus — the first gap, or what's
      // working — then one revision point fitted to the grade.
      const gap = practiceIds.map((id) => practiceCoaching[id]).find((item) => !item.needs.test(activity))
      const revises = /\b(revis|refin|update|change (their|its))\w*/i.test(activity)
      return chatReply({
        say: [
          gap ? gap.missing : `This gives students real practice in ${practiceNames} — they’re working with evidence, not just completing steps.`,
          teaching
            ? revises
              ? `Make clear what evidence prompts the revision, and give ${gradeAudience(teaching.grade)} ${teaching.support.scaffoldShort}.`
              : `Build in a revision point after students examine ${teaching.notes.evidence}.`
            : revises
              ? 'Make clear what new evidence prompts the revision.'
              : 'Build in a point where students use their idea on something new and then revise it.',
        ],
        notes: draftNote ? [draftNote] : [],
        ask: tailorAsk,
      })
    }
    if (wantsIdeas || asking) {
      return chatReply({ say: [ideaFor(practiceIds)], notes: draftNote ? [draftNote] : [], ask: tailorAsk })
    }
    if (ready) return chatReply({ say: [readyIdea, readyNote] })
    return chatReply({ say: [], ask: tailorAsk ?? `Where in the activity do students do the work of ${practiceNames}?` })
  }

  // Whole lesson: one piece of guidance, then the form note and at most one
  // question about what's still open.
  const say: string[] = []
  let ask: string | null = null
  const objectivesAdvice = (objectives: string) =>
    /\b(explain|model|argue|construct|develop|predict|compare|analy[sz]e|evaluate|describe|identify|design|use|revise|justify)\w*\b/i.test(objectives)
      ? 'Your objective names something observable students will do — consider adding the evidence or reasoning you’ll look for.'
      : 'Try phrasing the objective with an observable verb, like “develop a model that shows…”, so you can tell whether students got there.'
  const sequenceAdvice = (sequence: string) =>
    /\b(discuss|share|explain|revise|reflect|consensus|argue|compare)\w*\b/i.test(sequence)
      ? 'The sequence builds toward sense-making — bring the opening phenomenon back at the end so students see how far their thinking moved.'
      : 'Consider adding a moment where students share and revise their ideas, so the investigation becomes sense-making rather than task completion.'

  if (asking && /objective|goal/.test(lower)) {
    say.push(
      'A strong objective names something students will do that you can observe — “develop a model,” “construct an explanation,” “argue from evidence” — tied to the core idea.',
      'Keep it to one or two per lesson, each connected to a science practice.',
    )
  } else if (asking && /phenomen/.test(lower)) {
    if (topic) {
      say.push(
        `For ${topic}, look for something students can observe but can’t yet explain, like a short video or a data set with a surprising pattern.`,
        'Their questions about it can drive the whole lesson.',
      )
    } else {
      say.push('A good phenomenon is something students can observe but can’t yet explain, like a surprising video or data pattern from their world.')
      ask = 'What topic are you working with?'
    }
  } else if (/engag|interest|motivat|boring/.test(lower)) {
    say.push(
      'Engagement usually comes from a genuine puzzle: open with the phenomenon, let students notice and wonder, and give them a model or claim to revise as evidence comes in.',
    )
  } else if (noticed.has('learningObjectives') && lesson.objectives) {
    say.push(objectivesAdvice(lesson.objectives))
    if (noticed.has('instructionalSequence') && lesson.sequence) say.push(sequenceAdvice(lesson.sequence))
  } else if (noticed.has('instructionalSequence') && lesson.sequence) {
    say.push(sequenceAdvice(lesson.sequence))
    if (lesson.objectives && lesson.practices) say.push(`Check that each activity moves students toward the objective and gives them a chance to practice ${lesson.practices}.`)
    else ask = lesson.objectives ? 'Which science practice should the activities emphasize?' : 'What should students be able to do by the end?'
  } else if (noticed.has('topic') && topic) {
    say.push(`${topic} is a rich topic to build a lesson around.`)
    ask = 'Is there a phenomenon students could be puzzled by at the start?'
  } else if (noticed.has('practices') && lesson.practices) {
    say.push(`Emphasizing ${lesson.practices} works best when students revisit their work — for example, revising an initial model or claim once they have more evidence.`)
  } else if (asking) {
    if (topic) {
      say.push(`For ${topic}, anchor the lesson in a phenomenon, have students make their thinking visible, and plan a point where they revise it with evidence.`)
      ask = 'What part would you like to work through first?'
    } else {
      say.push('Share your lesson idea, even a rough one, and I’ll give feedback on how it supports students’ sense-making.')
    }
  } else if (noticedFields.length === 0) {
    ask = 'What do you picture students doing during this lesson, and what should they walk away understanding?'
  }

  const notes: string[] = []
  if (noticedLabels.length > 0) {
    notes.push(`I picked up ${joinLabels(noticedLabels)} for your lesson form — review ${noticedLabels.length === 1 ? 'it' : 'them'} under “Suggested for your lesson form.”`)
  }
  if (stillOpen.length > 0) {
    if (!ask && (noticedLabels.length > 0 || say.length === 0)) ask = stillOpen[0].question
  } else if (requiredAwaitingReview > 0) {
    notes.push('Once you apply the suggestions, all seven required fields will be filled and you can generate the lesson.')
  } else {
    notes.push('All seven required fields are in your form, so you can generate the lesson anytime.')
  }
  return chatReply({ say, notes, ask })
}

// The seven fields Generate Lesson requires. Completion uses the same
// check as Brainstorm's Lesson Planning Notes, so both always agree.
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

// The (i) next to a suggested standard. It only shows that standard's
// verified description — it never selects the standard.
function StandardInfoButton({ standard, isOpen, onToggle, panelId }: { standard: ScienceStandard; isOpen: boolean; onToggle: () => void; panelId: string }) {
  return (
    <button
      type="button"
      className="standard-info-button"
      aria-label={`About ${standard.code}`}
      aria-expanded={isOpen}
      aria-controls={isOpen ? panelId : undefined}
      title={`About ${standard.code}`}
      onClick={onToggle}
    >
      i
    </button>
  )
}

// A standard's code and official description from the verified standards
// data (see scienceStandardsBank), shown under the suggestion bubbles.
function StandardInfoPanel({ standard, panelId, onClose }: { standard: ScienceStandard; panelId: string; onClose: () => void }) {
  return (
    <div className="standard-info-panel" id={panelId} role="region" aria-label={`${standard.code} description`}>
      <div className="standard-info-header">
        <p>
          <strong>{standard.code}</strong> <span>· {standardsFrameworkName(standard.framework)}</span>
        </p>
        <button type="button" className="drawer-close standard-info-close" aria-label={`Close ${standard.code} description`} onClick={onClose}>
          ×
        </button>
      </div>
      <p className="standard-info-description">{standard.description}</p>
      <a className="standard-info-source" href={standard.sourceUrl} target="_blank" rel="noopener noreferrer">
        Official standard text
      </a>
    </div>
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

function brainstormReply(request: BrainstormReplyRequest): string {
  return callAiModel('lesson-brainstorm', { instructions: brainstormReplyInstructions, request }, (input) => mockBrainstormReply(input.request))
}

// The assistant's opening message for the chosen focus and the form as it is.
function createBrainstormIntro(form: LessonFormSnapshot, focus: BrainstormFocus, activityContext: ActivityContext): ChatMessage {
  const keptExistingAnswers = brainstormSteps.some((step) => isBrainstormFieldFilled(step.field, form))
  return { role: 'ai', text: brainstormReply({ kind: 'start', focus, keptExistingAnswers, activityContext }) }
}

// A class's grade level ("8", "10") as an activity grade, when it names one.
const classActivityGrade = (gradeLevel: string | null): ActivityGrade | null =>
  gradeLevel ? extractActivityGrade(/^\d+$/.test(gradeLevel.trim()) ? `grade ${gradeLevel.trim()}` : gradeLevel) : null

// Whether a teacher message names a science practice.
const namesPractice = (text: string) => Object.values(practiceCoaching).some((coaching) => coaching.mentions.test(text.toLowerCase()))

function LessonPlanningPanel({
  planningTab,
  setPlanningTab,
  revisionEditor,
  isSavingVersion,
  defaultFramework,
  formSeed,
  savedLessonOpen,
  classGradeLevel,
  onGenerate,
  onUploadLesson,
  brainstormFocus,
  setBrainstormFocus,
  practiceActivity,
  lockedMethod,
  onStartNew,
}: {
  // The option that generated the lesson or activity: the others are
  // grayed out until the teacher starts something new.
  lockedMethod: PlanningMethod | null
  onStartNew: () => void
  planningTab: PlanningTab
  setPlanningTab: (tab: PlanningTab) => void
  revisionEditor: RevisionWorkflow
  // Supabase Mode: a lesson version is being saved (Apply to Lesson waits).
  isSavingVersion: boolean
  // The teacher's state framework (from their profile), or NGSS.
  defaultFramework: StandardsFrameworkId
  // A saved demo lesson's form to start from (null: a blank form). Read once;
  // the page remounts this panel when a different lesson is loaded.
  formSeed: PlanningFormSeed | null
  // A saved demo lesson is shown as saved (opened, not generated here).
  savedLessonOpen: boolean
  // The grade level of the class the activity is for, when there is one.
  classGradeLevel: string | null
  onGenerate?: (details: PlanningLessonDetails) => void
  // What the teacher chose to plan in Brainstorm with AI — lifted to the
  // page, which shows the Activity workspace for a practice activity.
  brainstormFocus: BrainstormFocus | null
  setBrainstormFocus: (focus: BrainstormFocus) => void
  // The Activity Draft on the right (Science Practice Activity mode).
  practiceActivity: { hasDraft: boolean; isGenerating: boolean; onGenerate: (request: ActivityDraftRequest) => void }
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
  const [selectedPractices, setSelectedPractices] = useState<string[]>(formSeed?.practices ?? [])
  // Every field below lives above the three start options so a teacher's
  // entries survive switching between them (Brainstorm with AI fills these
  // same fields), and survive clicking Generate Lesson (which no longer
  // unmounts this panel at all).
  const [topic, setTopic] = useState(formSeed?.topic ?? '')
  const [learningObjectives, setLearningObjectives] = useState(formSeed?.learningObjectives ?? '')
  const [priorInstruction, setPriorInstruction] = useState(formSeed?.priorInstruction ?? '')
  const [materialsAndEquipment, setMaterialsAndEquipment] = useState(formSeed?.materialsAndEquipment ?? '')
  const [instructionalSequence, setInstructionalSequence] = useState(formSeed?.instructionalSequence ?? '')
  // Additional Customization (all optional). Collapsing the section only
  // hides these — their values stay.
  const [isCustomizationOpen, setIsCustomizationOpen] = useState(false)
  const [subsequentInstruction, setSubsequentInstruction] = useState(formSeed?.subsequentInstruction ?? '')
  const [differentiation, setDifferentiation] = useState(formSeed?.differentiation ?? '')
  // Uploaded files are only selected and shown for now; nothing reads them.
  const [lessonTemplateFile, setLessonTemplateFile] = useState<File | null>(null)
  const [rubricFile, setRubricFile] = useState<File | null>(null)

  // The form's own Grade level selector doubles as the Standards filter —
  // teachers aren't asked to pick a grade a second time.
  const [gradeLevel, setGradeLevel] = useState(formSeed?.gradeLevel ?? '')
  const selectedGradeBand = gradeLevelToStandardsBand[gradeLevel]
  const [framework, setFramework] = useState<StandardsFrameworkId>(formSeed?.framework ?? defaultFramework)

  // Standards search: a teacher can type a keyword — without needing to
  // already know a standard's code — and pick any number of matching
  // standards (automatically scoped to the selected grade level), which
  // then show as removable chips.
  const [standardsQuery, setStandardsQuery] = useState('')
  const [selectedStandardCodes, setSelectedStandardCodes] = useState<string[]>(formSeed?.standards ?? [])
  // Standards the teacher typed in themselves (not from the verified list).
  const [customStandards, setCustomStandards] = useState<string[]>(formSeed?.customStandards ?? [])

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

  const [pacingSelection, setPacingSelection] = useState(formSeed?.pacingSelection ?? '')
  // Kept while switching between presets and Custom, so switching back to
  // Custom restores what the teacher typed.
  const [customPacingMinutes, setCustomPacingMinutes] = useState(formSeed?.customPacingMinutes ?? '')

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
  // How many lesson planning fields have something in them — shown in
  // Brainstorm's Lesson Planning Notes for information only. Only Generate
  // Lesson checks the required fields (see missingRequired).
  const addedFieldCount = brainstormSteps.filter((step) => isBrainstormFieldFilled(step.field, formSnapshot)).length

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

  // Brainstorm with AI: what the teacher chose to plan, the conversation,
  // and the suggestions picked up from it that the teacher hasn't applied or
  // dismissed yet. The conversation starts once a focus is chosen; changing
  // the focus later keeps both the conversation and the suggestions.
  const [isChoosingFocus, setIsChoosingFocus] = useState(false)
  const [brainstormMessages, setBrainstormMessages] = useState<ChatMessage[]>([])
  const [brainstormSuggestions, setBrainstormSuggestions] = useState<BrainstormSuggestions>({})
  // A practice activity doesn't fill the lesson form: what the AI picks up
  // there (e.g. the topic) is kept here as context for the conversation and
  // the Activity Draft, and never offered as Apply to Form suggestions.
  const [activityNotes, setActivityNotes] = useState<BrainstormSuggestions>({})
  // Where the practice-activity part of the conversation starts — only that
  // part shapes the Activity Draft.
  const [practiceStartIndex, setPracticeStartIndex] = useState(0)
  // The grade level and topic the teacher gave in the conversation.
  // Starts with the class's grade, when the class gives one, so it isn't asked again.
  const [activityContext, setActivityContext] = useState<ActivityContext>(() => ({
    ...emptyActivityContext,
    grade: classActivityGrade(classGradeLevel),
  }))
  // The practices the assistant last suggested for the topic — marked on the
  // bubbles, never selected for the teacher.
  const [suggestedPracticeIds, setSuggestedPracticeIds] = useState<string[]>([])
  // Where the teacher last chose practices with the bubbles; practices named
  // in chat before that no longer count, so a new choice replaces them.
  const [practiceChosenAt, setPracticeChosenAt] = useState(-1)
  const isPracticeFocus = brainstormFocus === 'practice'
  // A text suggestion the teacher is editing before applying it.
  const [editingSuggestion, setEditingSuggestion] = useState<{ field: BrainstormTextField; draft: string } | null>(null)
  // What the last apply or dismiss did, announced under the suggestions.
  const [suggestionStatus, setSuggestionStatus] = useState<string | null>(null)
  const [brainstormDraft, setBrainstormDraft] = useState('')
  // Science Practice Activity: the practice bubbles are offered until the
  // teacher continues or types; what they continue with is sent with every
  // later message so the brainstorm keeps integrating those practices.
  const [showPracticeBubbles, setShowPracticeBubbles] = useState(false)
  const [practiceSelection, setPracticeSelection] = useState<string[]>([])
  const [focusPracticeIds, setFocusPracticeIds] = useState<string[]>([])
  const [isBrainstormThinking, setIsBrainstormThinking] = useState(false)
  const brainstormInputRef = useRef<HTMLInputElement>(null)
  const brainstormTimeoutRef = useRef<number | null>(null)
  // Keeps the newest message in view as the conversation grows.
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

  const chooseMethod = (method: PlanningMethod) => {
    if (lockedMethod && method !== lockedMethod) return
    // After generation the option that made it stays open.
    const next: PlanningTab = planningTab === method && !lockedMethod ? 'none' : method
    setPlanningTab(next)
    setLastMethod(next)
  }

  // Starts the conversation for the chosen focus, or — when switching —
  // carries it on under the new focus.
  const chooseBrainstormFocus = (focus: BrainstormFocus) => {
    setIsChoosingFocus(false)
    if (focus === brainstormFocus) return
    setBrainstormFocus(focus)
    // The practice bubbles come once the grade and topic are known.
    const teaching = focus === 'practice' ? activityTeaching(activityContext) : null
    setShowPracticeBubbles(Boolean(teaching) && focusPracticeIds.length === 0)
    setSuggestedPracticeIds(teaching ? suggestedPracticesFor(teaching) : [])
    setPracticeSelection([])
    if (focus === 'practice') setPracticeStartIndex(brainstormMessages.length)
    setBrainstormMessages((prev) =>
      prev.length === 0
        ? [createBrainstormIntro(formSnapshot, focus, activityContext)]
        : [
            ...prev,
            {
              role: 'ai',
              text: brainstormReply({ kind: 'switch', focus, lesson: brainstormLessonView(formSnapshot, brainstormSuggestions), activityContext }),
            },
          ],
    )
  }

  // Which upload is open under the Lesson Planning Notes (opened from the
  // Template/Rubric bubble). Attaching there updates the same file state as
  // the form.
  const [brainstormUpload, setBrainstormUpload] = useState<LessonUploadField | null>(null)
  const uploadFiles: Record<LessonUploadField, File | null> = { lessonTemplate: lessonTemplateFile, rubric: rubricFile }
  const setUploadFile = (field: LessonUploadField, file: File | null) =>
    field === 'lessonTemplate' ? setLessonTemplateFile(file) : setRubricFile(file)

  // Which suggested standard's description is open in the form — one at a
  // time, closed by default.
  const [standardInfo, setStandardInfo] = useState<{ place: 'form'; code: string } | null>(null)
  const toggleStandardInfo = (place: 'form', code: string) =>
    setStandardInfo((current) => (current?.place === place && current.code === code ? null : { place, code }))
  const formInfoStandard = standardInfo ? scienceStandardsBank.find((standard) => standard.code === standardInfo.code) : undefined

  // Suggestions still to review, in form order. One the form already
  // matches (e.g. the teacher typed it in themselves) drops out.
  const pendingSuggestions = brainstormSteps.flatMap((step) => {
    const suggestion = brainstormSuggestions[step.field]
    return suggestion && !isSuggestionInForm(suggestion, formSnapshot) ? [suggestion] : []
  })
  const suggestedFields = new Set(pendingSuggestions.map((suggestion) => suggestion.field))

  const textFieldSetters: Record<BrainstormTextField, Dispatch<SetStateAction<string>>> = {
    topic: setTopic,
    learningObjectives: setLearningObjectives,
    instructionalSequence: setInstructionalSequence,
    priorInstruction: setPriorInstruction,
    subsequentInstruction: setSubsequentInstruction,
    differentiation: setDifferentiation,
    materialsAndEquipment: setMaterialsAndEquipment,
  }

  // The text a suggestion would put in the form — the teacher's edit, if
  // they're editing it.
  const suggestionDraft = (suggestion: BrainstormSuggestion) =>
    editingSuggestion?.field === suggestion.field ? editingSuggestion.draft.trim() : suggestionText(suggestion)
  const canApplySuggestion = (suggestion: BrainstormSuggestion) =>
    suggestion.field === 'standards' || suggestion.field === 'practices' ? suggestion.value.length > 0 : suggestionDraft(suggestion) !== ''

  const dropSuggestion = (field: BrainstormField) => {
    setBrainstormSuggestions((prev) => {
      const next = { ...prev }
      delete next[field]
      return next
    })
    setEditingSuggestion((current) => (current?.field === field ? null : current))
  }

  // Writes a reviewed suggestion to the form. 'add' fills an empty field or
  // adds to what's there (standards and practices are combined, text is
  // appended); 'replace' — only ever the teacher's explicit choice —
  // overwrites the field.
  const applySuggestion = (suggestion: BrainstormSuggestion, mode: 'add' | 'replace') => {
    if (!canApplySuggestion(suggestion)) return
    const label = brainstormStepFor(suggestion.field).label
    const wasFilled = isBrainstormFieldFilled(suggestion.field, formSnapshot)
    switch (suggestion.field) {
      case 'gradeLevel':
        setGradeLevel(suggestion.value)
        break
      case 'pacing':
        setPacingSelection(suggestion.value.selection)
        setCustomPacingMinutes(suggestion.value.customMinutes)
        break
      case 'standards': {
        const codes = suggestion.value
        setSelectedStandardCodes((prev) => [...prev, ...codes.filter((code) => !prev.includes(code))])
        break
      }
      case 'practices': {
        const ids = suggestion.value
        setSelectedPractices((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))])
        break
      }
      default: {
        const value = suggestionDraft(suggestion)
        textFieldSetters[suggestion.field]((prev) => (mode === 'replace' || !prev.trim() ? value : `${prev.trim()} ${value}`))
      }
    }
    dropSuggestion(suggestion.field)
    setSuggestionStatus(
      mode === 'replace' ? `Replaced ${label} in the form.` : wasFilled ? `Added to ${label} in the form.` : `Added ${label} to the form.`,
    )
  }

  // Applies every ready suggestion whose form field is still empty — never
  // one that would change something already in the form.
  const emptyFieldSuggestions = pendingSuggestions.filter(
    (suggestion) => !isBrainstormFieldFilled(suggestion.field, formSnapshot) && canApplySuggestion(suggestion),
  )
  const applyAllToEmptyFields = () => {
    emptyFieldSuggestions.forEach((suggestion) => applySuggestion(suggestion, 'add'))
    setSuggestionStatus(`Added ${pluralize(emptyFieldSuggestions.length, 'suggestion')} to empty fields in the form.`)
  }

  const dismissSuggestion = (suggestion: BrainstormSuggestion) => {
    dropSuggestion(suggestion.field)
    setSuggestionStatus(`Dismissed the ${brainstormStepFor(suggestion.field).label} suggestion. The form is unchanged.`)
  }

  const toggleSuggestedOption = (field: 'standards' | 'practices', option: string) =>
    setBrainstormSuggestions((prev) => {
      const suggestion = prev[field]
      if (!suggestion || (suggestion.field !== 'standards' && suggestion.field !== 'practices')) return prev
      const value = suggestion.value.includes(option)
        ? suggestion.value.filter((item) => item !== option)
        : suggestion.options.filter((item) => item === option || suggestion.value.includes(item))
      return { ...prev, [field]: { ...suggestion, value } }
    })

  // The summary's bubbles for suggested fields jump to that suggestion.
  const focusSuggestion = (field: BrainstormField) => {
    const row = document.getElementById(`brainstorm-suggestion-${field}`)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    row?.focus({ preventScroll: true })
  }

  // `selectedPractices` is set only when the message comes from the
  // practice bubbles' Continue.
  const sendBrainstormMessage = (text: string, selectedPractices?: string[]) => {
    const message = text.trim()
    if (!message || isBrainstormThinking || !brainstormFocus) return
    setBrainstormDraft('')
    setShowPracticeBubbles(false)
    // Practices chosen with the bubbles or named in chat since then.
    const practiceFocus = selectedPractices ?? activityPracticeIds
    if (selectedPractices) {
      setFocusPracticeIds(selectedPractices)
      setPracticeChosenAt(brainstormMessages.length)
    }
    const current = isPracticeFocus ? activityNotes : brainstormSuggestions
    const found = extractLessonSuggestions(message, formSnapshot, current)
    // A practice activity's grade and topic: the newest mention wins, so the
    // teacher can change either. A bare answer counts as the topic only
    // right after the assistant asked for it.
    let nextContext = activityContext
    let contextUpdate = { grade: false, topic: false }
    if (isPracticeFocus) {
      const lastAiText = [...brainstormMessages].reverse().find((item) => item.role === 'ai')?.text ?? ''
      const grade = extractActivityGrade(message)
      const { topic: newTopic, phenomenon } = extractActivityTopic(message, /are you teaching\b[^.!?]*\?/.test(lastAiText))
      const topicValue = newTopic ?? (phenomenon && !activityContext.topic ? titleCaseTopic(phenomenon) : null)
      contextUpdate = {
        grade: Boolean(grade && grade.label !== activityContext.grade?.label),
        topic: Boolean(topicValue && topicValue !== activityContext.topic),
      }
      nextContext = {
        grade: grade ?? activityContext.grade,
        topic: topicValue ?? activityContext.topic,
        phenomenon: phenomenon ?? (newTopic ? null : activityContext.phenomenon),
      }
      setActivityContext(nextContext)
    }
    const merged = { ...current }
    for (const suggestion of found) merged[suggestion.field] = mergeSuggestion(merged[suggestion.field], suggestion)
    if (isPracticeFocus) {
      setActivityNotes(merged)
    } else {
      setBrainstormSuggestions(merged)
      if (found.length > 0) setSuggestionStatus(null)
    }
    setBrainstormMessages((prev) => [...prev, { role: 'teacher', text: message }])

    const request = brainstormReplyRequest(brainstormFocus, message, found, formSnapshot, merged, {
      focusPracticeIds: practiceFocus,
      fromPracticeSelection: Boolean(selectedPractices),
      hasActivityDraft: practiceActivity.hasDraft,
      activityContext: nextContext,
      contextUpdate,
    })
    // Once the grade and topic are known and no practice is chosen yet, the
    // reply suggests practices and the bubbles appear for the teacher to pick.
    const teaching = isPracticeFocus ? activityTeaching(nextContext) : null
    const offerPractices = Boolean(teaching) && practiceFocus.length === 0 && ![...practiceMentionMessages, message].some(namesPractice)
    setIsBrainstormThinking(true)
    brainstormTimeoutRef.current = window.setTimeout(() => {
      setBrainstormMessages((prev) => [...prev, { role: 'ai', text: brainstormReply(request) }])
      setIsBrainstormThinking(false)
      if (offerPractices && teaching) {
        setSuggestedPracticeIds(suggestedPracticesFor(teaching))
        setPracticeSelection([])
        setShowPracticeBubbles(true)
      }
    }, 600)
  }

  // Bubbles toggle on and off; the selection stays in bubble order.
  const togglePracticeBubble = (id: string) =>
    setPracticeSelection((prev) =>
      practiceFocusBubbles.map((bubble) => bubble.id).filter((item) => (item === id ? !prev.includes(id) : prev.includes(item))),
    )
  const continueWithPractices = () => {
    if (practiceSelection.length === 0) return
    const names = practiceSelection.map((id) => practiceCoaching[id].name)
    sendBrainstormMessage(`I’d like to focus on ${joinLabels(names)}.`, practiceSelection)
  }
  // Reopens the bubbles with the current practices selected, to change them.
  const changePractices = () => {
    setPracticeSelection(activityPracticeIds)
    setShowPracticeBubbles(true)
  }

  // Generate Activity Draft needs the grade and topic, at least one
  // practice (selected or named in the conversation), and some discussion
  // of the activity beyond that context. It sends those and what the
  // teacher said.
  const teacherMessages = brainstormMessages
    .slice(practiceStartIndex)
    .filter((message) => message.role === 'teacher')
    .map((message) => message.text)
  // Practices named in chat count from the latest bubble choice on.
  const practiceMentionMessages = brainstormMessages
    .slice(Math.max(practiceStartIndex, practiceChosenAt + 1))
    .filter((message) => message.role === 'teacher')
    .map((message) => message.text)
  const activityPracticeIds = practiceFocusBubbles
    .map((bubble) => bubble.id)
    .filter((id) => focusPracticeIds.includes(id) || practiceMentionMessages.some((text) => practiceCoaching[id].mentions.test(text.toLowerCase())))
  // Brainstorming the activity itself is optional: the grade, topic, and a
  // practice are enough to generate a draft.
  const missingForActivity = [
    !activityContext.grade && 'grade level',
    !activityContext.topic && 'science topic',
    activityPracticeIds.length === 0 && 'a science practice',
  ].filter((item): item is string => Boolean(item))
  const canGenerateActivity = missingForActivity.length === 0 && !practiceActivity.isGenerating
  // Asked in the chat when Generate Activity Draft is clicked too early:
  // one short question about the first thing still missing.
  const missingActivityPrompt = () => {
    const contextQuestion = missingContextQuestion(activityContext)
    if (contextQuestion) return `Before I draft the activity: ${contextQuestion.charAt(0).toLowerCase()}${contextQuestion.slice(1)}`
    return 'Before I draft the activity: which science practice should it build — developing and using models, constructing explanations, or engaging in argument from evidence?'
  }
  const generateActivity = () => {
    if (practiceActivity.isGenerating || isBrainstormThinking) return
    if (!canGenerateActivity || !activityContext.grade || !activityContext.topic) {
      setShowPracticeBubbles(false)
      setBrainstormMessages((prev) => [...prev, { role: 'ai', text: missingActivityPrompt() }])
      brainstormInputRef.current?.focus()
      return
    }
    practiceActivity.onGenerate({
      practiceIds: activityPracticeIds,
      context: { grade: activityContext.grade, topic: activityContext.topic, phenomenon: activityContext.phenomenon },
      teacherMessages,
    })
  }

  // Conversation starters for the whole-lesson focus, until the teacher has
  // said something. (A practice activity starts from the practice bubbles.)
  const brainstormStarters =
    brainstormMessages.some((message) => message.role === 'teacher') || brainstormFocus === 'practice'
      ? []
      : ['Help me find a phenomenon for my topic', 'What makes a strong learning objective?', 'Give me feedback on my lesson idea']
  const brainstormFocusOption = brainstormFocusOptions.find((option) => option.id === brainstormFocus)

  // Shown in the collapsed Additional Customization header.
  const customizationCount =
    [priorInstruction, subsequentInstruction, differentiation, materialsAndEquipment].filter((value) => value.trim() !== '').length +
    (lessonTemplateFile ? 1 : 0) +
    (rubricFile ? 1 : 0)

  const completionSummary = formCompletionSummary(formSnapshot)
  // The Lesson Planning Notes above the input start collapsed to their
  // one-line header.
  const [isSummaryOpen, setIsSummaryOpen] = useState(false)
  const revisionState = revisionEditor.activeLabel ? revisionEditor.statesByLabel[revisionEditor.activeLabel] : undefined
  // Start New clears the current work, so it asks first.
  const [isConfirmingStartNew, setIsConfirmingStartNew] = useState(false)

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
            disabled={Boolean(lockedMethod && method.id !== lockedMethod)}
            title={lockedMethod && method.id !== lockedMethod ? 'Start a new lesson or activity to use this option.' : undefined}
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

      {(lockedMethod || savedLessonOpen) && (
        <div className="planning-start-new" role="status">
          {isConfirmingStartNew ? (
            <>
              <p>
                {lockedMethod
                  ? 'Start over? This clears the current lesson or activity, the form, and the conversation.'
                  : 'Start a new, blank lesson? The saved lesson stays as it is in your Library.'}
              </p>
              <div className="planning-start-new-actions">
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => {
                    setIsConfirmingStartNew(false)
                    onStartNew()
                  }}
                >
                  Start New
                </button>
                <button type="button" className="secondary-button" onClick={() => setIsConfirmingStartNew(false)}>
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                {lockedMethod
                  ? 'Other planning options are locked while you work on what you generated.'
                  : 'You’re viewing a saved lesson. Its form and plan are shown as saved.'}
              </p>
              <button type="button" className="ghost-button planning-start-new-button" onClick={() => setIsConfirmingStartNew(true)}>
                Start a New Lesson or Activity
              </button>
            </>
          )}
        </div>
      )}

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
                        <span key={standard.code} className="standard-bubble-group">
                          <button
                            type="button"
                            className="standard-suggestion-bubble"
                            title={standard.description}
                            aria-label={`Add ${standard.code}: ${standard.description}`}
                            onClick={() => addStandard(standard.code)}
                          >
                            <span aria-hidden="true">+</span> {standard.code}
                          </button>
                          <StandardInfoButton
                            standard={standard}
                            panelId="form-standard-info"
                            isOpen={standardInfo?.place === 'form' && standardInfo.code === standard.code}
                            onToggle={() => toggleStandardInfo('form', standard.code)}
                          />
                        </span>
                      ))}
                    </div>
                    {formInfoStandard && (
                      <StandardInfoPanel standard={formInfoStandard} panelId="form-standard-info" onClose={() => setStandardInfo(null)} />
                    )}
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
              <h3>Brainstorm with AI</h3>
              <p>Chat with AI to plan an activity or lesson.</p>
            </div>

            {!brainstormFocusOption || isChoosingFocus ? (
              <section className="brainstorm-focus-picker" aria-labelledby="brainstorm-focus-heading">
                <h4 id="brainstorm-focus-heading">What would you like to plan?</h4>
                <div className="brainstorm-focus-options" role="group" aria-labelledby="brainstorm-focus-heading">
                  {brainstormFocusOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      className={`planning-method brainstorm-focus-option ${brainstormFocus === option.id ? 'active' : ''}`}
                      aria-pressed={brainstormFocus === option.id}
                      onClick={() => chooseBrainstormFocus(option.id)}
                    >
                      <span className="planning-method-icon" aria-hidden="true">
                        {option.icon}
                      </span>
                      <span className="planning-method-text">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
                {isChoosingFocus && (
                  <button type="button" className="ghost-button brainstorm-focus-cancel" onClick={() => setIsChoosingFocus(false)}>
                    Cancel
                  </button>
                )}
              </section>
            ) : (
              <div className="brainstorm-focus-bar">
                <span className="brainstorm-focus-current">
                  <span className="card-label">Planning focus</span>
                  <strong>{brainstormFocusOption.label}</strong>
                </span>
                <button type="button" className="ghost-button brainstorm-focus-change" onClick={() => setIsChoosingFocus(true)}>
                  Change Focus
                </button>
              </div>
            )}

            {brainstormFocus && (
              <div className="planning-thread brainstorm-thread" ref={brainstormThreadRef}>
                <div className="chat-thread">
                  {brainstormMessages.map((message, index) => (
                    <div key={index} className={`chat-message ${message.role === 'teacher' ? 'teacher-message' : 'ai-message'}`}>
                      <p className="chat-message-label">{message.role === 'teacher' ? 'You' : 'AI'}</p>
                      {message.text}
                    </div>
                  ))}
                </div>
                {isBrainstormThinking && <p className="empty-state-support">AI is thinking…</p>}
                {!isBrainstormThinking && brainstormFocus === 'practice' && showPracticeBubbles && (
                  <div className="brainstorm-practice-picker">
                    <div className="brainstorm-quick-replies" role="group" aria-label="Science practices to focus on">
                      {practiceFocusBubbles.map((bubble) => {
                        const selected = practiceSelection.includes(bubble.id)
                        const suggested = suggestedPracticeIds.includes(bubble.id)
                        return (
                          <button
                            key={bubble.id}
                            type="button"
                            className={`practice-chip ${selected ? 'selected' : ''} ${suggested ? 'suggested' : ''}`}
                            aria-pressed={selected}
                            onClick={() => togglePracticeBubble(bubble.id)}
                          >
                            {selected && (
                              <span className="chip-check" aria-hidden="true">
                                ✓
                              </span>
                            )}
                            {bubble.label}
                            {suggested && <span className="chip-suggested-tag">Suggested</span>}
                          </button>
                        )
                      })}
                    </div>
                    <button
                      type="button"
                      className="primary-button brainstorm-practice-continue"
                      disabled={practiceSelection.length === 0}
                      onClick={continueWithPractices}
                    >
                      Continue
                    </button>
                  </div>
                )}
                {!isBrainstormThinking && brainstormFocus === 'practice' && !showPracticeBubbles && activityPracticeIds.length > 0 && (
                  <p className="brainstorm-practice-current">
                    Practices: {joinLabels(activityPracticeIds.map((id) => practiceFocusBubbles.find((bubble) => bubble.id === id)!.label))}
                    <button type="button" className="practice-change-button" onClick={changePractices}>
                      Change practices
                    </button>
                  </p>
                )}
                {!isBrainstormThinking && brainstormStarters.length > 0 && (
                  <div className="brainstorm-quick-replies" aria-label="Conversation starters">
                    {brainstormStarters.map((starter) => (
                      <button key={starter} type="button" className="practice-chip" onClick={() => sendBrainstormMessage(starter)}>
                        {starter}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!isPracticeFocus && pendingSuggestions.length > 0 && (
              <section className="brainstorm-suggestions" aria-labelledby="brainstorm-suggestions-heading">
                <div className="brainstorm-suggestions-header">
                  <div>
                    <h4 id="brainstorm-suggestions-heading">
                      Suggested for your lesson form <span className="brainstorm-suggestions-count">({pendingSuggestions.length})</span>
                    </h4>
                    <p>Picked up from your conversation. Review each one — nothing is added to the form until you apply it.</p>
                  </div>
                  {emptyFieldSuggestions.length >= 2 && (
                    <button type="button" className="secondary-button" onClick={applyAllToEmptyFields}>
                      Apply All to Empty Fields
                    </button>
                  )}
                </div>
                <ul className="brainstorm-suggestion-list">
                  {pendingSuggestions.map((suggestion) => {
                    const step = brainstormStepFor(suggestion.field)
                    const filled = isBrainstormFieldFilled(suggestion.field, formSnapshot)
                    const isEditing = editingSuggestion?.field === suggestion.field
                    const canApply = canApplySuggestion(suggestion)
                    const isMultiSelect = suggestion.field === 'standards' || suggestion.field === 'practices'
                    const isText = !isMultiSelect && suggestion.field !== 'gradeLevel' && suggestion.field !== 'pacing'
                    let body: ReactNode
                    if (suggestion.field === 'standards' || suggestion.field === 'practices') {
                      const multi = suggestion
                      body = (
                        <div className="brainstorm-quick-replies" role="group" aria-label={`Suggested ${step.label}`}>
                          {multi.options.map((option) => {
                            const selected = multi.value.includes(option)
                            const standard =
                              multi.field === 'standards' ? scienceStandardsBank.find((item) => item.code === option) : undefined
                            return (
                              <button
                                key={option}
                                type="button"
                                className={`practice-chip ${selected ? 'selected' : ''}`}
                                aria-pressed={selected}
                                title={standard ? shortenStandardDescription(standard.description, 200) : undefined}
                                onClick={() => toggleSuggestedOption(multi.field, option)}
                              >
                                {selected && (
                                  <span className="chip-check" aria-hidden="true">
                                    ✓
                                  </span>
                                )}
                                {multi.field === 'practices' ? practiceLabels([option])[0] : option}
                              </button>
                            )
                          })}
                        </div>
                      )
                    } else if (isEditing) {
                      body = (
                        <textarea
                          rows={3}
                          aria-label={`Edit suggested ${step.label}`}
                          value={editingSuggestion.draft}
                          autoFocus
                          onChange={(event) => setEditingSuggestion({ field: editingSuggestion.field, draft: event.target.value })}
                        />
                      )
                    } else {
                      body = <p className="brainstorm-suggestion-value">{suggestionText(suggestion)}</p>
                    }
                    return (
                      <li
                        key={suggestion.field}
                        id={`brainstorm-suggestion-${suggestion.field}`}
                        className="brainstorm-suggestion"
                        tabIndex={-1}
                        aria-label={`${step.label} suggestion`}
                      >
                        <div className="brainstorm-suggestion-head">
                          <span className="brainstorm-suggestion-label">{step.label}</span>
                          <span className="brainstorm-suggestion-badge">✦ Suggested</span>
                        </div>
                        {body}
                        {filled && (
                          <p className="brainstorm-suggestion-current">
                            Already in your form: {shortenStandardDescription(brainstormAnswerText(suggestion.field, formSnapshot), 90)}
                          </p>
                        )}
                        <div className="brainstorm-suggestion-actions">
                          {(!filled || isMultiSelect || isText) && (
                            <button
                              type="button"
                              className="primary-button"
                              disabled={!canApply}
                              onClick={() => applySuggestion(suggestion, 'add')}
                            >
                              {filled ? 'Add to Form' : 'Apply to Form'}
                            </button>
                          )}
                          {filled && !isMultiSelect && (
                            <button
                              type="button"
                              className="secondary-button"
                              disabled={!canApply}
                              onClick={() => applySuggestion(suggestion, 'replace')}
                            >
                              Replace
                            </button>
                          )}
                          {isText && (
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() =>
                                setEditingSuggestion(
                                  isEditing ? null : { field: suggestion.field as BrainstormTextField, draft: suggestionText(suggestion) },
                                )
                              }
                            >
                              {isEditing ? 'Cancel Edit' : 'Edit'}
                            </button>
                          )}
                          <button type="button" className="ghost-button brainstorm-suggestion-dismiss" onClick={() => dismissSuggestion(suggestion)}>
                            Dismiss
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )}
            {!isPracticeFocus && suggestionStatus && (
              <p className="brainstorm-suggestion-status" role="status">
                {suggestionStatus}
              </p>
            )}

            {/* The lesson form's notes don't apply to a practice activity. */}
            {!isPracticeFocus && (
            <section className={`form-summary${isSummaryOpen ? ' open' : ''}`} aria-labelledby="form-summary-heading">
              <h4 className="form-summary-heading" id="form-summary-heading">
                <button
                  type="button"
                  className="form-summary-toggle"
                  aria-expanded={isSummaryOpen}
                  aria-controls="form-summary-content"
                  onClick={() => setIsSummaryOpen((open) => !open)}
                >
                  <span className="form-summary-title">Lesson Planning Notes</span>
                  <span className="form-summary-count" title="Lesson planning fields added so far">
                    {pluralize(addedFieldCount, 'field')} added
                  </span>
                  <span className="form-summary-spacer" aria-hidden="true" />
                  {suggestedFields.size > 0 && <span className="form-summary-suggested">{suggestedFields.size} suggested</span>}
                  <span className="form-summary-chevron" aria-hidden="true">
                    {isSummaryOpen ? '▴' : '▾'}
                  </span>
                </button>
              </h4>
              {isSummaryOpen && (
                <div className="form-summary-content" id="form-summary-content">
                  <p className="form-summary-legend">
                    <span>✓ In your form</span>
                    <span aria-hidden="true">·</span>
                    <span>✦ Suggested by AI — review to apply</span>
                  </p>
                  <ul className="form-summary-bubbles" aria-label="Lesson planning fields">
                    {completionSummary.map((item) => {
                      const pending = pendingSuggestions.find((suggestion) => suggestion.field === item.field)
                      const content = (
                        <>
                          <span className="form-summary-icon" aria-hidden="true">
                            {item.value ? '✓' : pending ? '✦' : ''}
                          </span>
                          <span className="visually-hidden">
                            {item.value ? 'In your form: ' : pending ? 'Suggested by AI, not yet applied: ' : 'Not added yet: '}
                          </span>
                          {item.value ? (
                            <>
                              <span className="form-summary-label">{item.label}:</span> {item.value}
                            </>
                          ) : pending ? (
                            <>
                              <span className="form-summary-label">{item.label}:</span> {shortenSummaryText(suggestionText(pending))}
                            </>
                          ) : (
                            item.label
                          )}
                          {item.value && pending && (
                            <span className="form-summary-new" aria-label="New suggestion to review">
                              ✦
                            </span>
                          )}
                        </>
                      )
                      const title = item.value
                        ? `${brainstormStepFor(item.field).label}: ${brainstormAnswerText(item.field, formSnapshot)}`
                        : `${brainstormStepFor(item.field).label} — not added yet`
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
                      // A field with a suggestion waiting jumps to it for review.
                      if (pending) {
                        return (
                          <li key={item.field}>
                            <button
                              type="button"
                              className={`form-summary-bubble form-summary-bubble-button ${item.value ? 'complete' : 'suggested'}`}
                              title={`${item.value ? `${title}. ` : ''}AI suggestion: ${suggestionText(pending)} — click to review`}
                              onClick={() => focusSuggestion(item.field)}
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
                  <button type="button" className="ghost-button form-summary-review" onClick={() => chooseMethod('create')}>
                    Review the form
                  </button>
                </div>
              )}
            </section>
            )}

            {!isPracticeFocus && brainstormUpload && (
              <div className="brainstorm-upload" id="brainstorm-upload">
                <OptionalFileUpload
                  id={`brainstorm-upload-${brainstormUpload}`}
                  {...lessonUploads[brainstormUpload]}
                  file={uploadFiles[brainstormUpload]}
                  onChange={(file) => setUploadFile(brainstormUpload, file)}
                />
                <div className="brainstorm-upload-footer">
                  <p className="customization-note">Also shown in the form’s Additional Customization. Files aren’t read by the AI yet.</p>
                  <button type="button" className="ghost-button brainstorm-upload-close" onClick={() => setBrainstormUpload(null)}>
                    Done
                  </button>
                </div>
              </div>
            )}

            {brainstormFocus && (
              <form
                className="composer-box brainstorm-composer"
                onSubmit={(event) => {
                  event.preventDefault()
                  sendBrainstormMessage(brainstormDraft)
                }}
              >
                <input
                  type="text"
                  ref={brainstormInputRef}
                  id="brainstorm-message-input"
                  aria-label="Your message"
                  placeholder="Share an idea, or ask for feedback…"
                  value={brainstormDraft}
                  onChange={(event) => setBrainstormDraft(event.target.value)}
                  disabled={isBrainstormThinking}
                />
                <button type="submit" className="primary-button" disabled={isBrainstormThinking || !brainstormDraft.trim()}>
                  Send
                </button>
              </form>
            )}

            {isPracticeFocus ? (
              <div className="brainstorm-actions">
                {/* Missing grade, topic, practice, or idea is asked for in
                    the chat when the button is clicked, not listed here. */}
                <button
                  type="button"
                  className="primary-button generate-button"
                  disabled={practiceActivity.isGenerating || isBrainstormThinking}
                  onClick={generateActivity}
                >
                  {practiceActivity.isGenerating
                    ? 'Drafting Activity…'
                    : practiceActivity.hasDraft
                      ? 'Regenerate Activity Draft'
                      : 'Generate Activity Draft'}
                </button>
              </div>
            ) : (
              <>
                <RequiredFieldsAlert
                  show={showValidation}
                  missing={missingRequired}
                  hint="Apply the AI’s suggestions, or choose “Review the form” to fill them in."
                />
                <div className="brainstorm-actions">
                  <button type="button" className="primary-button generate-button" onClick={handleGenerate}>
                    Generate Lesson Plan
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {planningTab === 'revision' && revisionEditor.activeLabel && revisionState && (
          <div className="planning-chat">
            <RevisionChatPanel
              key={revisionEditor.activeLabel}
              label={revisionEditor.activeLabel}
              state={revisionState}
              isThinking={revisionEditor.isThinking}
              isSaving={isSavingVersion}
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
function LoginPage({
  authKind,
  onLogin,
  onExploreDemo,
}: {
  // 'supabase': the form signs in with Supabase; 'mock': the prototype's mock login.
  authKind: 'supabase' | 'mock'
  onLogin: (credentials: MockLoginCredentials) => Promise<string | null>
  onExploreDemo: () => Promise<string | null>
}) {
  const [mode, setMode] = useState<MockLoginCredentials['mode']>('login')
  const [isSubmitting, setIsSubmitting] = useState(false)
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
        onSubmit={async (event) => {
          event.preventDefault()
          if (isSubmitting) return
          setIsSubmitting(true)
          // The buttons always come back, even if signing in fails unexpectedly.
          try {
            setError(await onLogin({ email, password, mode, state, district }))
          } catch (failure) {
            setError(toApiError(failure, 'Couldn’t log in. Please try again.').message)
          } finally {
            setIsSubmitting(false)
          }
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
        <button type="submit" className="primary-button login-submit" disabled={isSubmitting}>
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
        {/* The demo: mock teacher and sample lessons, never the real backend. */}
        <div className="login-demo">
          <p className="login-divider">
            <span>or</span>
          </p>
          <button
            type="button"
            className="secondary-button login-demo-button"
            disabled={isSubmitting}
            onClick={async () => {
              setIsSubmitting(true)
              try {
                setError(await onExploreDemo())
              } catch (failure) {
                setError(toApiError(failure, 'Couldn’t open the demo. Please try again.').message)
              } finally {
                setIsSubmitting(false)
              }
            }}
          >
            Explore Demo
          </button>
        </div>
        {authKind === 'mock' && (
          <p className="login-note">
            Prototype only — no real authentication. {DEMO_TEACHER_EMAIL} (or a blank email) signs in as a returning teacher; any other email is a
            first-time login.
          </p>
        )}
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
  // `formSeed`: the planning form a lesson saved in Supabase was made from.
  lessonPlan: { hasDemoContent: boolean; document?: LessonDocument; feedbackActivities?: FeedbackActivity[]; formSeed?: PlanningFormSeed }
  studentFeedback: StudentFeedbackAssignment[]
  classFeedback: { available: boolean }
  // The teacher whose Library this lesson is in.
  ownerEmail: string
  // Standards the teacher selected for this lesson.
  standards: LessonStandardRef[]
  // Science practice ids the lesson emphasizes.
  sciencePractices: string[]
  durationMinutes: number | null
  // Shown in the Library but not openable: its mock content isn't ready.
  demoUnavailable?: boolean
}

// Where a Library navigation came from — the lesson, and the class it was
// opened under (absent for unassigned lessons). Drives the context banner.
type LibraryContext = {
  lesson: LibraryLesson
  className?: string
  page: PageId
  assignmentTitle?: string
  // Where the lesson was opened from: the Library (default), or a demo
  // class chosen in Class Setup.
  source?: 'library' | 'class-setup'
}

// A class owns its roster, so assigning another lesson to the class reuses
// the same students without uploading the roster again. A lesson can be
// assigned to any number of classes. `studentIds` are internal keys from the
// shared student registry (see Student), so one student can be in several
// classes. What students and teachers see is the class Student ID in
// `studentCodes` ("SB-001"), which is unique within this class only.
type LibraryClass = {
  id: string
  name: string
  gradeLevel: string
  // Optional period or section as the teacher typed it ("2", "Period 2",
  // "Section B"); empty when not given.
  period: string
  // The class's teacher as entered in Class Setup; its first letter starts
  // the class's Student IDs.
  teacherName: string
  ownerEmail: string
  bannerColor: string
  studentIds: string[]
  // Each student's class Student ID, by internal key. An entry stays after
  // the student is removed, so the number is never given to anyone else
  // (and comes back if they rejoin). Only enrolled students' IDs are active.
  studentCodes: Record<string, string>
  // The number the next new Student ID gets; it never goes down.
  nextStudentNumber: number
  // Set when the first Student ID is assigned, so renaming the class or its
  // teacher afterwards never changes the IDs students already have.
  studentIdPrefix: string | null
  lessonIds: string[]
}

// A student in the shared registry. `id` is an internal key, never shown;
// students are identified to teachers and to the Student Feedback login by
// their class Student ID (see LibraryClass). `name` is the student's name
// as the teacher entered it (see rosterNameProblem), shown only on teacher
// pages — no other personal information is stored.
type Student = {
  id: string
  name: string
}

// A bare number is shown as "Period 2"; anything else as typed.
function formatPeriod(period: string): string {
  return /^\d+$/.test(period) ? `Period ${period}` : period
}

// How a class is labeled everywhere outside Class Setup — e.g. the Library
// card title "Period 4 · Earth Science".
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
  onOpenStudentReports: (lesson: LibraryLesson, classroom: LibraryClass | null) => void
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
    id: 'zombie-fires',
    title: 'Zombie Fires: Matter and Energy Flow',
    grade: '10',
    topic: 'Earth Science',
    bannerColor: '#5b7f95',
    lessonPlan: { hasDemoContent: true },
    // One assignment with both student products (Model and Explanation),
    // opened from one Student Feedback link. Confirming the products on
    // Lesson Planning updates this same link.
    studentFeedback: [
      {
        id: 'zombie-fires-assignment',
        title: 'Model and Explanation',
        modelTab: 'descriptive',
        link: {
          lessonId: 'zombie-fires',
          lessonTitle: 'Zombie Fires: Matter and Energy Flow',
          activities: studentProductsFor('zombie-fires').map(({ name, submission }) => ({ name, submission })),
        },
      },
    ],
    classFeedback: { available: true },
    ownerEmail: DEMO_TEACHER_EMAIL,
    standards: [],
    sciencePractices: [],
    durationMinutes: null,
  },
  {
    // The COVID-19 handwashing activity Student Feedback demonstrates: two
    // assignments, one per model.
    id: 'covid-virus',
    title: 'COVID Virus',
    grade: '8',
    topic: 'Life Science',
    bannerColor: '#9a7b5b',
    lessonPlan: { hasDemoContent: true, document: covidLessonDocument },
    studentFeedback: [
      // One assignment with both student products (Descriptive and
      // Mechanistic), opened from one Student Feedback link.
      {
        id: 'covid-virus-assignment',
        title: 'Descriptive and Mechanistic',
        modelTab: 'descriptive',
        link: {
          lessonId: 'covid-virus',
          lessonTitle: 'COVID Virus: Structure and Function of Soap',
          activities: studentProductsFor('covid-virus').map(({ name, submission }) => ({ name, submission })),
        },
      },
    ],
    classFeedback: { available: true },
    ownerEmail: DEMO_TEACHER_EMAIL,
    standards: [],
    sciencePractices: ['modeling', 'explanation'],
    durationMinutes: null,
  },
  {
    id: 'ecosystem-interactions',
    title: 'Ecosystem Interactions',
    grade: '8',
    topic: 'Life Science',
    bannerColor: '#6f8f6a',
    lessonPlan: { hasDemoContent: false },
    studentFeedback: [],
    classFeedback: { available: false },
    demoUnavailable: true,
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
    demoUnavailable: true,
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
// ---------------------------------------------------------------------------
// Lesson Planning ↔ Supabase (see src/api/lessonPlanning.ts)
//
// A saved lesson version holds the lesson as the teacher sees it — manual
// edits and applied AI revisions folded into its sections — plus the
// planning form it came from and its student products. The lessons row's
// columns come from the same form, so the two never disagree.
// ---------------------------------------------------------------------------

const lessonContentFormat = 'partners-lesson/v1'

type SavedLessonContent = {
  format: typeof lessonContentFormat
  document: LessonDocument
  form: PlanningLessonDetails
  studentProducts: FeedbackActivity[]
}

// The lesson as displayed: edited or AI-revised sections carry their current
// text, and suggestions already acted on (edited or applied) are dropped.
function effectiveLessonDocument(
  document: LessonDocument,
  manualEdits: Record<string, string>,
  revisedLesson: Record<string, string>,
): LessonDocument {
  const changedText = (label: string) => manualEdits[label] ?? revisedLesson[label]
  const actedOn = new Set([...Object.keys(manualEdits), ...Object.keys(revisedLesson)])
  const keep = <T,>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([label]) => !actedOn.has(label)))
  return {
    ...document,
    steps: document.steps.map((step) => {
      const text = changedText(step.label)
      return text === undefined ? step : { ...step, segments: [{ text }] }
    }),
    suggestions: keep(document.suggestions),
    suggestionSummaries: keep(document.suggestionSummaries),
    revisionSegments: keep(document.revisionSegments),
    workflows: keep(document.workflows),
  }
}

function lessonTitleFrom(details: PlanningLessonDetails, uploadedFileName?: string): string {
  const title = uploadedFileName ? uploadedFileName.replace(/\.[^.]+$/, '') : details.topic.trim()
  return title || 'Untitled Lesson'
}

// The lessons columns for a lesson, from its planning form. Grade level
// falls back to the class's (an uploaded lesson's form may not have one).
function lessonFieldsFrom(details: PlanningLessonDetails, title: string, classGrade: string): LessonFields {
  const text = (value: string | undefined) => (value && value.trim() ? value.trim() : null)
  return {
    lesson_title: title,
    grade_level: details.gradeLevel.trim() || classGrade.trim(),
    topic: details.topic.trim() || title,
    standards: details.standards.length > 0 ? details.standards.map((standard) => standard.code) : null,
    science_practices: details.sciencePractices.length > 0 ? [...details.sciencePractices] : null,
    learning_objectives: text(details.learningObjectives),
    duration: details.durationMinutes ? Math.round(details.durationMinutes) : null,
    prior_instruction: text(details.optionalContext.priorInstruction),
    subsequent_instruction: text(details.optionalContext.subsequentInstruction),
    instructional_sequence: text(details.instructionalSequence),
    materials_equipment: text(details.optionalContext.materialsAndEquipment),
    // Uploaded files aren't stored yet.
    lesson_template_path: null,
    rubric_path: null,
  }
}

function lessonContentFrom(document: LessonDocument, form: PlanningLessonDetails, studentProducts: readonly FeedbackActivity[]): SavedLessonContent {
  return { format: lessonContentFormat, document, form, studentProducts: [...studentProducts] }
}

// The planning form to reopen a saved lesson with.
function formSeedFromDetails(details: PlanningLessonDetails, defaultFramework: StandardsFrameworkId): PlanningFormSeed {
  const minutes = details.durationMinutes
  const preset = minutes !== null && pacingOptions.some((option) => option.id === String(minutes)) ? String(minutes) : null
  return {
    gradeLevel: details.gradeLevel,
    topic: details.topic,
    framework: details.standards.find((standard) => !standard.custom)?.framework ?? defaultFramework,
    standards: details.standards.filter((standard) => !standard.custom).map((standard) => standard.code),
    customStandards: details.standards.filter((standard) => standard.custom).map((standard) => standard.code),
    practices: [...details.sciencePractices],
    learningObjectives: details.learningObjectives,
    instructionalSequence: details.instructionalSequence,
    pacingSelection: preset ?? (minutes ? 'custom' : ''),
    customPacingMinutes: preset || !minutes ? '' : String(minutes),
    priorInstruction: details.optionalContext.priorInstruction ?? '',
    subsequentInstruction: details.optionalContext.subsequentInstruction ?? '',
    differentiation: details.optionalContext.differentiation ?? '',
    materialsAndEquipment: details.optionalContext.materialsAndEquipment ?? '',
  }
}

// A saved lesson's content, if it's in the format this app writes.
function readSavedLessonContent(content: Record<string, unknown> | undefined): SavedLessonContent | null {
  const candidate = content as Partial<SavedLessonContent> | undefined
  return candidate?.format === lessonContentFormat && Array.isArray(candidate.document?.steps) && candidate.form ? (candidate as SavedLessonContent) : null
}

// A lesson from Supabase as a Library lesson (its current version).
function libraryLessonFromStored(stored: StoredLesson, index: number, ownerEmail: string, defaultFramework: StandardsFrameworkId): LibraryLesson {
  const content = readSavedLessonContent(stored.currentVersion?.content)
  const fields = stored.fields
  return {
    id: stored.lessonId,
    title: fields.lesson_title || 'Untitled Lesson',
    grade: fields.grade_level || null,
    topic: fields.topic || 'Not specified',
    bannerColor: lessonBannerColors[index % lessonBannerColors.length],
    lessonPlan: {
      // Without readable content the lesson opens empty (never the demo lesson).
      hasDemoContent: content !== null,
      document: content ? { ...content.document, id: stored.lessonId } : undefined,
      feedbackActivities: content?.studentProducts,
      formSeed: content ? formSeedFromDetails(content.form, defaultFramework) : undefined,
    },
    studentFeedback: [],
    classFeedback: { available: false },
    ownerEmail,
    standards: content?.form.standards ?? (fields.standards ?? []).map((code) => ({ code, framework: defaultFramework, custom: false })),
    sciencePractices: fields.science_practices ?? [],
    durationMinutes: fields.duration,
  }
}

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

// The seeded classes' teacher, used for their Student IDs ("DE-001").
const DEMO_TEACHER_NAME = 'Demo Teacher'

function createStudent(keyNumber: number, name: string): Student {
  return { id: `student-${keyNumber}`, name }
}

function nextStudentKeyNumber(students: readonly Student[]): number {
  return students.reduce((max, student) => Math.max(max, Number(student.id.replace(/\D/g, '')) || 0), 0) + 1
}

// First letter of a name, uppercased; X when it has none.
function initialOf(text: string): string {
  return /\p{L}/u.exec(text)?.[0].toUpperCase() ?? 'X'
}

// [Teacher Initial][Course Initial], e.g. Shunki + Biology → "SB".
function studentIdPrefixFor(teacherName: string, className: string): string {
  return `${initialOf(teacherName)}${initialOf(className)}`
}

function classStudentIdPrefix(classroom: Pick<LibraryClass, 'studentIdPrefix' | 'teacherName' | 'name'>): string {
  return classroom.studentIdPrefix ?? studentIdPrefixFor(classroom.teacherName, classroom.name)
}

// Three digits, growing past 999 when a class needs more.
function formatClassStudentId(prefix: string, studentNumber: number): string {
  return `${prefix}-${String(studentNumber).padStart(3, '0')}`
}

// Reads a typed or uploaded Student ID loosely ("sb001", "SB-1", "sb - 001"
// all mean SB-001), or null if it isn't one.
function normalizeClassStudentId(raw: string): string | null {
  const match = /^(\p{L}{2})\s*-?\s*(\d+)$/u.exec(raw.trim())
  return match ? formatClassStudentId(match[1].toUpperCase(), Number(match[2])) : null
}

// Enrolls students in the class (skipping ones already in it). Each gets the
// class Student ID they had before, if they were ever in the class, or the
// next unused number.
function withEnrolledStudents(classroom: LibraryClass, studentKeys: readonly string[]): LibraryClass {
  const prefix = classStudentIdPrefix(classroom)
  const studentIds = [...classroom.studentIds]
  const studentCodes = { ...classroom.studentCodes }
  let nextStudentNumber = classroom.nextStudentNumber
  for (const key of studentKeys) {
    if (studentIds.includes(key)) continue
    studentIds.push(key)
    studentCodes[key] ??= formatClassStudentId(prefix, nextStudentNumber++)
  }
  return {
    ...classroom,
    studentIds,
    studentCodes,
    nextStudentNumber,
    studentIdPrefix: nextStudentNumber > 1 ? prefix : null,
  }
}

// A class from Supabase in the app's class shape. Student IDs come from the
// database (students.student_pseudonym); the next new one continues after
// the highest number already used with the class's prefix. The teacher's
// name comes from their profile (classes have no teacher column), and the
// banner colour isn't stored, so it's picked by position as for new classes.
// Shown for Class Setup writes by a Supabase teacher when the `classes`
// integration is off (nothing would be saved).
const classSetupNotConnected =
  'Class Setup isn’t connected to Supabase in this configuration, so nothing would be saved. Add “classes” to VITE_SUPABASE_INTEGRATIONS (auth,classes) and restart the app.'

// A stored Student ID as prefix and number ("SB-007" → SB, 7), or null.
function parseClassStudentId(studentId: string): { prefix: string; number: number } | null {
  const match = /^(\p{L}{2})-(\d+)$/u.exec(studentId.trim())
  return match ? { prefix: match[1].toUpperCase(), number: Number(match[2]) } : null
}

// The roster part of a class from its stored enrollments: who's in it,
// their Student IDs, the class's ID prefix, and the next number to use.
function rosterFieldsFor(roster: readonly RosterStudent[]): Pick<LibraryClass, 'studentIds' | 'studentCodes' | 'nextStudentNumber' | 'studentIdPrefix'> {
  const parsed = roster.flatMap((student) => parseClassStudentId(student.studentPseudonym) ?? [])
  return {
    studentIds: roster.map((student) => student.studentId),
    studentCodes: Object.fromEntries(roster.map((student) => [student.studentId, student.studentPseudonym])),
    nextStudentNumber: parsed.reduce((highest, item) => Math.max(highest, item.number), 0) + 1,
    studentIdPrefix: parsed[0]?.prefix ?? null,
  }
}

// New Student IDs for a class, generated by the app (sequential, e.g.
// SB-001): the class's existing prefix — or, for its first students, the
// teacher's and class's initials — then numbers after the highest one used
// with that prefix, skipping any ID already in the class. `roster` is read
// from the database just before, so students added elsewhere are counted.
function planStudentIds(roster: readonly RosterStudent[], fallbackPrefix: string, count: number): string[] {
  const taken = new Set(roster.map((student) => student.studentPseudonym.trim().toUpperCase()))
  const parsed = roster.flatMap((student) => parseClassStudentId(student.studentPseudonym) ?? [])
  const prefix = parsed[0]?.prefix ?? fallbackPrefix
  let next = parsed.filter((item) => item.prefix === prefix).reduce((highest, item) => Math.max(highest, item.number), 0) + 1
  const ids: string[] = []
  while (ids.length < count) {
    const id = formatClassStudentId(prefix, next++)
    if (taken.has(id)) continue
    taken.add(id)
    ids.push(id)
  }
  return ids
}

// Student IDs used by more than one student in the class (e.g. two people
// adding students at the same moment).
function duplicateStudentIds(roster: readonly RosterStudent[]): string[] {
  const seen = new Map<string, number>()
  for (const student of roster) {
    const id = student.studentPseudonym.trim().toUpperCase()
    seen.set(id, (seen.get(id) ?? 0) + 1)
  }
  return [...seen].filter(([, count]) => count > 1).map(([id]) => id)
}

function libraryClassFromRecord(
  record: ClassRecord,
  roster: readonly RosterStudent[],
  teacher: { name: string; email: string },
  index: number,
): LibraryClass {
  return {
    id: record.classId,
    name: record.className,
    gradeLevel: record.gradeLevel ?? '',
    period: record.period ?? '',
    teacherName: teacher.name,
    ownerEmail: teacher.email,
    bannerColor: classBannerColors[index % classBannerColors.length],
    ...rosterFieldsFor(roster),
    lessonIds: [],
  }
}

// The class Student IDs students can currently sign in with.
function activeStudentCodes(classroom: LibraryClass): string[] {
  return classroom.studentIds.map((key) => classroom.studentCodes[key]).filter(Boolean)
}

// "Biology_Period_2_Student_Roster_With_IDs.csv"
function rosterDownloadFileName(classroom: Pick<LibraryClass, 'name' | 'period'>): string {
  const label = [classroom.name, classroom.period ? formatPeriod(classroom.period) : '']
    .join(' ')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
  return `${label || 'Class'}_Student_Roster_With_IDs.csv`
}

// Built lazily (and once — App's student and class state both read it)
// because the Period 4 roster reuses the Class Feedback demo's student
// names, which are defined further down this file.
let initialLibraryData: { students: Student[]; classes: LibraryClass[] } | null = null

function getInitialLibraryData() {
  if (initialLibraryData) return initialLibraryData
  const students: Student[] = []
  const register = (names: readonly string[]) =>
    names.map((name) => {
      const student = createStudent(students.length + 1, name)
      students.push(student)
      return student.id
    })
  const seedClass = (
    classroom: Omit<LibraryClass, 'studentIds' | 'studentCodes' | 'nextStudentNumber' | 'studentIdPrefix'>,
    names: readonly string[],
  ) => withEnrolledStudents({ ...classroom, studentIds: [], studentCodes: {}, nextStudentNumber: 1, studentIdPrefix: null }, register(names))
  const classes: LibraryClass[] = [
    seedClass(
      {
        id: 'period-4-earth-science',
        name: 'Earth Science',
        gradeLevel: '10',
        period: '4',
        teacherName: DEMO_TEACHER_NAME,
        ownerEmail: DEMO_TEACHER_EMAIL,
        bannerColor: classBannerColors[1],
        lessonIds: ['zombie-fires'],
      },
      assignmentStudentRoster,
    ),
    seedClass(
      {
        id: 'period-1-life-science',
        name: 'Life Science',
        gradeLevel: '8',
        period: '1',
        teacherName: DEMO_TEACHER_NAME,
        ownerEmail: DEMO_TEACHER_EMAIL,
        bannerColor: classBannerColors[2],
        lessonIds: ['ecosystem-interactions', 'covid-virus'],
      },
      mockRosterNames.slice(22, 48),
    ),
  ]
  initialLibraryData = { students, classes }
  return initialLibraryData
}

// ---------------------------------------------------------------------------
// Student login (prototype)
//
// Students open a class's Student Feedback link and enter their class
// Student ID; it's matched only against that class's roster, since IDs are
// unique within a class, not across classes. A link usually opens in a new
// tab, which starts from the seeded prototype state, so each class's active
// Student IDs — IDs and the class label only, never names — are mirrored to
// this browser's localStorage. This is a demo stand-in, not secure or
// persistent storage: a backend replaces it.
// ---------------------------------------------------------------------------

type ClassLoginRoster = { label: string; studentIds: string[] }

const classLoginStorageKey = 'partners.prototype.classStudentIds'

// The class the main nav's Student Feedback page belongs to: its demo
// student work comes from this class.
const demoStudentFeedbackClassId = 'period-4-earth-science'

function readStoredLoginRosters(): Record<string, ClassLoginRoster> {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(classLoginStorageKey) ?? '{}')
    if (!data || typeof data !== 'object') return {}
    return Object.fromEntries(
      Object.entries(data).filter(
        (entry): entry is [string, ClassLoginRoster] =>
          typeof entry[1]?.label === 'string' && Array.isArray(entry[1]?.studentIds),
      ),
    )
  } catch {
    return {}
  }
}

function storeLoginRosters(classes: readonly LibraryClass[]) {
  const current = Object.fromEntries(
    classes.map((classroom) => [classroom.id, { label: classDisplayName(classroom), studentIds: activeStudentCodes(classroom) }]),
  )
  try {
    window.localStorage.setItem(classLoginStorageKey, JSON.stringify({ ...readStoredLoginRosters(), ...current }))
  } catch {
    // Storage unavailable (private mode, blocked): login falls back to this tab's classes.
  }
}

// The latest roster a teacher saved in this browser, else this tab's own.
function findLoginRoster(classId: string, classes: readonly LibraryClass[]): ClassLoginRoster | null {
  const stored = readStoredLoginRosters()[classId]
  if (stored) return stored
  const classroom = classes.find((other) => other.id === classId)
  return classroom ? { label: classDisplayName(classroom), studentIds: activeStudentCodes(classroom) } : null
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
  if (page === 'lesson-generator' && context.source === 'class-setup') {
    note = 'Choose Create a new lesson to see the form filled in with this demo class’s saved lesson, then click Generate Lesson Plan (prototype demo content). Use Add Lesson in the Library to start a new, blank lesson.'
  } else if (page === 'lesson-generator') {
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
        <strong>
          {context.source === 'class-setup' ? 'Demo class lesson' : 'Opened from My Lesson Library'}: {lesson.title}
        </strong>
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
                    if (lesson.demoUnavailable) {
                      return (
                        <li key={lesson.id} className="library-class-lesson unavailable">
                          <div className="library-class-lesson-toggle" aria-disabled="true">
                            <span className="library-context-swatch" style={{ background: lesson.bannerColor }} aria-hidden="true" />
                            <span className="library-class-lesson-text">
                              <strong>{lesson.title}</strong>
                              <small>
                                {formatLessonGrade(lesson.grade)} · {lesson.topic}
                              </small>
                            </span>
                            <span className="library-demo-unavailable">Not available in demo</span>
                          </div>
                        </li>
                      )
                    }
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
    <article className={`library-card${lesson.demoUnavailable ? ' unavailable' : ''}`} aria-disabled={lesson.demoUnavailable || undefined}>
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
        {lesson.demoUnavailable ? (
          <span className="library-demo-unavailable">Not available in demo</span>
        ) : (
          <LessonNavActions lesson={lesson} classroom={null} nav={nav} />
        )}
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

      {/* Opens the selector for this lesson and class; with no analyzed
          submissions it shows an empty state, never another class's data. */}
      <button type="button" className="library-action" onClick={() => nav.onOpenStudentReports(lesson, classroom)}>
        <span>Individual Student Reports</span>
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
// names and their first-name part, class Student IDs ("SB-001"), and the demo
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
  | 'practice-activity'
  | 'student-feedback'
  | 'class-feedback-analysis'
  | 'class-feedback-summary'
  | 'facilitation-questions'

// The identifiers to keep out of AI requests. Kept in sync with the student
// registry by App (see syncAiRosterGuard); the demo Class Feedback names are
// always included because that page's evidence carries student names.
let aiRosterIdentifiers: string[] = []

// Any class Student ID: two letters, a hyphen, three or more digits.
const studentIdPattern = /(?<![\p{L}\p{N}])\p{L}{2}-\d{3,}(?![\p{L}\p{N}])/giu

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
    // Each part of the name on its own ("Jordan" or "Smith" for "Jordan
    // Smith") identifies the student too; single letters are skipped so
    // ordinary words survive.
    for (const part of trimmed.split(/[\s,]+/)) add(part.replace(/\.$/, ''))
  }
  for (const student of students) addName(student.name)
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
// Classes (name, grade level, optional period/section, teacher) and their
// student rosters, shared with the Library. Rosters hold student names (full
// names allowed), which only the teacher sees: in Class Setup and the
// downloaded roster. Students see only their Student ID, and names never
// reach an AI model (see callAiModel). Each student in a class gets a class
// Student ID — [Teacher Initial][Course Initial]-[Number], e.g. SB-001 —
// that students use to sign in to Student Feedback. Uploading an updated roster keeps
// existing IDs: a row keeps its student's ID when it carries that Student
// ID, or when its name matches exactly one student already in the class.
// Only new students get new numbers, and numbers are never reused. A
// matching name in another class is never linked automatically; at most
// it's offered for the teacher to confirm. All of this is frontend state
// until there's a backend.
// ---------------------------------------------------------------------------

// High school grades only.
const classGradeOptions = ['9', '10', '11', '12']

function formatClassGrade(gradeLevel: string): string {
  if (!gradeLevel) return '—'
  return gradeLevel === 'K' ? 'Kindergarten' : `Grade ${gradeLevel}`
}

// Why a roster name can't be stored, or null if it reads as a person's
// name — full names ("Jordan Smith", "María José O’Neil-Ruiz"), first names
// or initials. Anything else (emails, IDs, other data) stays out.
function rosterNameProblem(name: string): string | null {
  if (!name) return 'Enter the student’s name.'
  if (name.includes('@')) return 'Looks like an email address — enter the student’s name.'
  if (/\d/.test(name)) return 'Contains numbers — enter the student’s name only.'
  if (!/^[\p{L}\p{M}\s.,'’-]+$/u.test(name)) return 'Contains characters that aren’t part of a name.'
  if (!/\p{L}/u.test(name)) return 'Enter the student’s name.'
  if (name.length > 60) return 'Too long — enter the student’s name only.'
  return null
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

// The file's other columns for one row, by header — kept only so the
// teacher's downloaded roster can include them (see RosterUploadRow).
type RosterExtraCell = { header: string; value: string }

// One student row from an upload. `name` and `studentId` are the only
// fields that can join the roster.
type RosterUploadRow = { name: string; studentId: string | null; extra: RosterExtraCell[] }

const rosterFullNameHeader = /^(student\s*)?(full\s*)?name$/
const rosterFirstNameHeader = /^(student\s*)?(first\s*name|first|given\s*name|initials?)(\s*(or|\/)\s*initials?)?$/
const rosterLastNameHeader = /^(student\s*)?(last\s*name|last|surname|family\s*name)$/
const rosterIdHeader = /^(partners\s*)?(student\s*)?id$/

// Maps spreadsheet rows to students, importing the student's name — a
// Student Name / Name column, or First Name plus an optional Last Name —
// and an optional Student ID column. Every other column (emails,
// birthdays…) never joins the roster: its values ride along with the
// upload's review only, so the teacher's "Roster with Student IDs" download
// can keep them, and are dropped when that upload is done with. Its header
// is returned so the teacher can be told it wasn't imported.
function rosterRowsFromTable(table: string[][]): { rows: RosterUploadRow[]; ignoredColumns: string[] } {
  if (table.length === 0) return { rows: [], ignoredColumns: [] }
  const header = table[0].map((cell) => cell.trim().toLowerCase())
  const columnOf = (pattern: RegExp) => header.findIndex((cell) => pattern.test(cell))
  const fullNameColumn = columnOf(rosterFullNameHeader)
  const firstNameColumn = columnOf(rosterFirstNameHeader)
  const lastNameColumn = columnOf(rosterLastNameHeader)
  let nameColumns =
    fullNameColumn >= 0 ? [fullNameColumn] : firstNameColumn >= 0 ? [firstNameColumn, lastNameColumn].filter((index) => index >= 0) : []
  const idColumn = columnOf(rosterIdHeader)
  const hasHeader = nameColumns.length > 0 || idColumn >= 0 || lastNameColumn >= 0
  const columnCount = Math.max(...table.map((cells) => cells.length))
  const isImported = (index: number) => nameColumns.includes(index) || index === idColumn
  let ignoredColumns: string[]
  if (hasHeader) {
    if (nameColumns.length === 0) throw new Error('Couldn’t find a “Student Name” (or “First Name”) column in this file.')
    ignoredColumns = table[0].filter((cell, index) => !isImported(index) && cell.trim() !== '')
  } else {
    // No recognizable header: only the first column is read.
    nameColumns = [0]
    ignoredColumns = columnCount > 1 ? [`${pluralize(columnCount - 1, 'unlabeled column')} after the first`] : []
  }
  const extraColumns = Array.from({ length: columnCount }, (_, index) => index).filter((index) => !isImported(index))
  const extraHeader = (index: number) => (hasHeader ? table[0][index]?.trim() : '') || `Column ${index + 1}`

  const rows = (hasHeader ? table.slice(1) : table)
    .map((cells) => ({
      name: nameColumns
        .map((index) => cells[index] ?? '')
        .join(' ')
        .trim()
        .replace(/\s+/g, ' '),
      studentId: idColumn >= 0 ? (cells[idColumn] ?? '').trim() || null : null,
      extra: extraColumns.map((index) => ({ header: extraHeader(index), value: cells[index] ?? '' })),
    }))
    .filter((row) => row.name !== '' || row.studentId)
  return { rows, ignoredColumns }
}

// A row waiting for the teacher's review before it joins the roster.
// `existing` is set only when the row's Student ID matched one of this
// class's Student IDs; `linkTo` is a link the teacher chose by hand.
type RosterReviewRow = {
  key: string
  name: string
  studentId: string | null
  existing: Student | null
  unknownId: boolean
  linkTo: string | null
  extra: RosterExtraCell[]
}

// The roster as of the teacher's last confirmed upload, for the preview
// and the "Roster with Student IDs" download.
type RosterUploadResult = { rows: { name: string; studentId: string; extra: RosterExtraCell[] }[] }

function rosterResultCsv(result: RosterUploadResult): string[][] {
  const extraHeaders = [...new Set(result.rows.flatMap((row) => row.extra.map((cell) => cell.header)))]
  return [
    ['Student Name', 'Student ID', ...extraHeaders],
    ...result.rows.map((row) => [
      row.name,
      row.studentId,
      ...extraHeaders.map((header) => row.extra.find((cell) => cell.header === header)?.value ?? ''),
    ]),
  ]
}

// Two cards: Class Management (choose Add Class or Edit Existing Class;
// only that form is shown) and Student Roster Management (class picker,
// privacy notice and upload, then a collapsible Check & Edit Student
// Roster, which starts collapsed).
function ClassSetupPage({
  remote = null,
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
  // Supabase Mode: creating a class saves it; the messages explain the
  // writes that aren't connected yet. null: the mock data.
  remote?: {
    createClass: (values: ClassFormValues) => Promise<LibraryClass>
    registerStudents: (classroom: LibraryClass, names: readonly string[]) => Promise<RegisteredStudents>
    editBlocked: string
    rosterBlocked: string
  } | null
}) {
  const [classSaveError, setClassSaveError] = useState<string | null>(null)
  const [isSavingClass, setIsSavingClass] = useState(false)
  const [editClassId, setEditClassId] = useState<string | null>(classes[0]?.id ?? null)
  // Class Management shows one form at a time: the teacher picks Add Class
  // or Edit Existing Class (null: neither yet). Opening from the Library's
  // "+ Create a Class", or a first-time teacher with no class, starts on Add.
  const [classMode, setClassMode] = useState<'add' | 'edit' | null>(() =>
    startCreating || (onboarding && classes.length === 0) ? 'add' : null,
  )
  // Whether the open form has edits that aren't saved yet.
  const [isClassFormDirty, setIsClassFormDirty] = useState(false)
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

  const finishCreate = (id: string) => {
    // The new class becomes the selected one, ready for its roster.
    onSelectClass(id)
    setCreatedClassId(id)
    setAddFormKey((key) => key + 1)
    setIsClassFormDirty(false)
  }

  const createClass = async (values: ClassFormValues) => {
    setClassSaveError(null)
    if (remote) {
      if (isSavingClass) return
      setIsSavingClass(true)
      try {
        const created = await remote.createClass(values)
        setClasses((prev) => [...prev, created])
        finishCreate(created.id)
      } catch (error) {
        setClassSaveError(toApiError(error, 'Couldn’t create the class.').message)
      } finally {
        setIsSavingClass(false)
      }
      return
    }
    const id = `class-${Date.now()}`
    setClasses((prev) => [
      ...prev,
      {
        id,
        ...values,
        ownerEmail,
        bannerColor: classBannerColors[prev.length % classBannerColors.length],
        studentIds: [],
        studentCodes: {},
        nextStudentNumber: 1,
        studentIdPrefix: null,
        lessonIds: [],
      },
    ])
    finishCreate(id)
  }

  const updateClass = (values: ClassFormValues) => {
    if (!editClass) return
    if (remote) {
      setClassSaveError(remote.editBlocked)
      return
    }
    setClasses((prev) => prev.map((classroom) => (classroom.id === editClass.id ? { ...classroom, ...values } : classroom)))
    setUpdatedClassId(editClass.id)
    setIsClassFormDirty(false)
  }

  // Leaving a form with unsaved edits (switching mode, closing it, or
  // picking another class to edit) asks first; the saved class data is
  // never touched either way.
  const confirmDiscard = () =>
    !isClassFormDirty || window.confirm('You have unsaved changes to this class. Discard them?')
  const resetClassForms = () => {
    setIsClassFormDirty(false)
    setAddFormKey((key) => key + 1)
    setEditFormKey((key) => key + 1)
    setCreatedClassId(null)
    setUpdatedClassId(null)
  }
  const chooseClassMode = (mode: 'add' | 'edit' | null) => {
    if (mode === classMode || !confirmDiscard()) return
    resetClassForms()
    setClassMode(mode)
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

        {/* Pick what to do; only that form is shown. */}
        <div className="class-mode-options" role="group" aria-label="Class Management action">
          {(
            [
              { id: 'add', label: 'Add Class', description: 'Create a new class', icon: '+' },
              {
                id: 'edit',
                label: 'Edit Existing Class',
                description: hasClass ? `Update ${pluralize(classes.length, 'class', 'classes')}` : 'No classes yet',
                icon: '✎',
              },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              className={`planning-method class-mode-option ${classMode === option.id ? 'active' : ''}`}
              aria-pressed={classMode === option.id}
              aria-controls="class-mode-content"
              disabled={option.id === 'edit' && !hasClass}
              onClick={() => chooseClassMode(option.id)}
            >
              <span className="planning-method-icon" aria-hidden="true">
                {option.icon}
              </span>
              <span className="planning-method-text">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>

        <div id="class-mode-content">
        {classMode === 'add' && (
        <div className="setup-subsection" role="group" aria-labelledby="add-class-heading">
          <div className="class-mode-header">
            <h4 className="setup-subsection-title" id="add-class-heading">
              Add Class
            </h4>
            <button type="button" className="ghost-button class-mode-close" onClick={() => chooseClassMode(null)}>
              Close
            </button>
          </div>
          <ClassSetupForm
            key={addFormKey}
            // Prefilled from the teacher's most recent class.
            defaultTeacherName={classes.at(-1)?.teacherName ?? ''}
            submitLabel="Create Class"
            autoFocus={startCreating || (onboarding && !hasClass)}
            onSave={createClass}
            onDirtyChange={setIsClassFormDirty}
          />
          {classSaveError && (
            <p className="roster-error" role="alert">
              {classSaveError}
            </p>
          )}
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
        )}

        {classMode === 'edit' && (
        <div className="setup-subsection" role="group" aria-labelledby="edit-class-heading">
          <div className="class-mode-header">
            <h4 className="setup-subsection-title" id="edit-class-heading">
              Edit Existing Class
            </h4>
            <button type="button" className="ghost-button class-mode-close" onClick={() => chooseClassMode(null)}>
              Close
            </button>
          </div>
          {editClass ? (
            <>
              <div className="setup-picker-row">
                <label className="setup-class-picker">
                  <span>Class</span>
                  <select
                    value={editClass.id}
                    onChange={(event) => {
                      if (!confirmDiscard()) return
                      setIsClassFormDirty(false)
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
                  setIsClassFormDirty(false)
                }}
                onDirtyChange={setIsClassFormDirty}
              />
              {classSaveError && (
                <p className="roster-error" role="alert">
                  {classSaveError}
                </p>
              )}
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
            <p className="library-class-note">No classes yet. Choose Add Class to create one.</p>
          )}
        </div>
        )}
        </div>
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
          <p>
            Student names are shown only to you — in Class Setup and in your downloaded roster. Students see only their
            Student ID. Do not include other identifying information such as emails or birthdates.
          </p>
          <p>Student roster data will not be sent to AI models.</p>
        </aside>

        {rosterClass ? (
          <RosterUpload
            key={rosterClass.id}
            registerStudents={remote?.registerStudents ?? null}
            writeBlocked={remote?.rosterBlocked ?? null}
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
              registerStudents={remote?.registerStudents ?? null}
              writeBlocked={remote?.rosterBlocked ?? null}
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

type ClassFormValues = { name: string; gradeLevel: string; period: string; teacherName: string }

function ClassSetupForm({
  initial,
  defaultTeacherName = '',
  submitLabel,
  autoFocus = false,
  onSave,
  onCancel,
  onDirtyChange,
}: {
  initial?: LibraryClass
  defaultTeacherName?: string
  submitLabel: string
  autoFocus?: boolean
  onSave: (values: ClassFormValues) => void
  onCancel?: () => void
  // Told whether the fields differ from what the form started with (the
  // class's saved values, or a blank new class), as the teacher edits.
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [teacherName, setTeacherName] = useState(initial?.teacherName ?? defaultTeacherName)
  const [name, setName] = useState(initial?.name ?? '')
  // A class saved with a grade that's no longer offered starts blank, so the
  // teacher picks one of the current options before saving.
  const [gradeLevel, setGradeLevel] = useState(
    initial && classGradeOptions.includes(initial.gradeLevel) ? initial.gradeLevel : '',
  )
  const [period, setPeriod] = useState(initial?.period ?? '')
  const canSave = teacherName.trim() !== '' && name.trim() !== '' && gradeLevel !== ''
  const preview = { name: name.trim(), period: period.trim(), teacherName: teacherName.trim() }
  const isUnchanged =
    initial !== undefined &&
    preview.name === initial.name &&
    gradeLevel === initial.gradeLevel &&
    preview.period === initial.period &&
    preview.teacherName === initial.teacherName
  // The values the form started with, to tell whether anything is unsaved.
  const startingValues: ClassFormValues = {
    teacherName: initial?.teacherName ?? defaultTeacherName,
    name: initial?.name ?? '',
    gradeLevel: initial && classGradeOptions.includes(initial.gradeLevel) ? initial.gradeLevel : '',
    period: initial?.period ?? '',
  }
  const reportDirty = (next: ClassFormValues) =>
    onDirtyChange?.(
      (Object.keys(startingValues) as (keyof ClassFormValues)[]).some((field) => next[field].trim() !== startingValues[field].trim()),
    )
  const current: ClassFormValues = { teacherName, name, gradeLevel, period }
  // IDs already given out keep their prefix (see LibraryClass.studentIdPrefix).
  const idPrefix = initial?.studentIdPrefix ?? studentIdPrefixFor(preview.teacherName, preview.name)

  return (
    <form
      className="setup-class-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave) onSave({ name: preview.name, gradeLevel, period: preview.period, teacherName: preview.teacherName })
      }}
    >
      <div className="setup-class-fields">
        <label>
          <span>Teacher Name (required)</span>
          <input
            type="text"
            placeholder="Alex Rivera"
            autoComplete="name"
            value={teacherName}
            onChange={(event) => {
              setTeacherName(event.target.value)
              reportDirty({ ...current, teacherName: event.target.value })
            }}
          />
        </label>
        <label>
          <span>Class Name (required)</span>
          <input type="text" placeholder="Biology" value={name} autoFocus={autoFocus} onChange={(event) => {
              setName(event.target.value)
              reportDirty({ ...current, name: event.target.value })
            }}
          />
        </label>
        <label>
          <span>Grade Level (required)</span>
          <select
            value={gradeLevel}
            onChange={(event) => {
              setGradeLevel(event.target.value)
              reportDirty({ ...current, gradeLevel: event.target.value })
            }}
          >
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
          <input
            type="text"
            placeholder="Period 2"
            value={period}
            onChange={(event) => {
              setPeriod(event.target.value)
              reportDirty({ ...current, period: event.target.value })
            }}
          />
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
      {(preview.name || preview.teacherName) && (
        <p className="library-class-note">
          {preview.name && <>Shows in the Library as “{classDisplayName(preview)}”. </>}
          {preview.name && preview.teacherName && (
            <>
              Student IDs {initial?.studentIdPrefix ? 'stay in the format' : 'will look like'}{' '}
              <span className="roster-id">{formatClassStudentId(idPrefix, 1)}</span>.
            </>
          )}
        </p>
      )}
    </form>
  )
}

// Excel-friendly CSV: a UTF-8 BOM so accented names display correctly, CRLF
// line endings, and an apostrophe before any cell Excel would otherwise run
// as a formula.
function downloadCsv(fileName: string, rows: string[][]) {
  const escape = (raw: string) => {
    const cell = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
    return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
  }
  const blob = new Blob(['﻿' + rows.map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n'], {
    type: 'text/csv;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

// The result of adding students in Supabase Mode: the class and students
// as stored, each added student's key and Student ID, and a warning if the
// class ended up with a duplicate Student ID.
type RegisteredStudents = {
  classroom: LibraryClass
  students: Student[]
  added: { key: string | null; name: string; studentId: string }[]
  warning: string | null
}

type RosterSectionProps = {
  // Supabase Mode: adds students through the database (see
  // classSetupRemote); renaming and removing aren't connected yet, so those
  // show `writeBlocked` instead of saving.
  registerStudents?: ((classroom: LibraryClass, names: readonly string[]) => Promise<RegisteredStudents>) | null
  writeBlocked?: string | null
  classroom: LibraryClass
  classes: readonly LibraryClass[]
  students: readonly Student[]
  studentsById: Record<string, Student>
  setClasses: Dispatch<SetStateAction<LibraryClass[]>>
  setStudents: Dispatch<SetStateAction<Student[]>>
}

// Registers any new students and enrolls the given ones in the class, which
// gives each its class Student ID (skipping ones already in it). Returns
// the class as it will be after the update.
function addStudentsToClass(
  { classroom, setClasses, setStudents }: Pick<RosterSectionProps, 'classroom' | 'setClasses' | 'setStudents'>,
  studentKeys: readonly string[],
  created: readonly Student[],
): LibraryClass {
  if (created.length > 0) setStudents((prev) => [...prev, ...created])
  setClasses((prev) => prev.map((other) => (other.id === classroom.id ? withEnrolledStudents(other, studentKeys) : other)))
  return withEnrolledStudents(classroom, studentKeys)
}

// Puts a Supabase roster update into app state: the class as stored, and its
// students (replacing their earlier copies).
function applyRegisteredStudents(
  { setClasses, setStudents }: Pick<RosterSectionProps, 'setClasses' | 'setStudents'>,
  result: RegisteredStudents,
) {
  const ids = new Set(result.students.map((student) => student.id))
  setStudents((prev) => [...prev.filter((student) => !ids.has(student.id)), ...result.students])
  setClasses((prev) => prev.map((other) => (other.id === result.classroom.id ? result.classroom : other)))
}

function otherClassesFor(classes: readonly LibraryClass[], classroom: LibraryClass, studentId: string) {
  return classes.filter((other) => other.id !== classroom.id && other.studentIds.includes(studentId))
}

// Upload → review (with each student's Student ID) → save, then a preview of
// the roster with Student IDs to download. Nothing joins the roster until
// the teacher has reviewed it and saved.
function RosterUpload(props: RosterSectionProps) {
  const { classroom, classes, students, studentsById } = props
  const [reviewRows, setReviewRows] = useState<RosterReviewRow[]>([])
  const [uploadName, setUploadName] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [ignoredColumns, setIgnoredColumns] = useState<string[]>([])
  const [isReading, setIsReading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [result, setResult] = useState<RosterUploadResult | null>(null)
  const nextRowKey = useRef(0)

  const roster = classroom.studentIds.map((id) => studentsById[id]).filter(Boolean)
  // Only this teacher's own classes are ever shown or offered as matches.
  const ownStudentIds = new Set(classes.flatMap((other) => other.studentIds))
  // This class's Student IDs (removed students' included) → student.
  const studentKeyByCode = new Map(Object.entries(classroom.studentCodes).map(([key, code]) => [code, key]))

  const handleFile = async (file: File | undefined) => {
    if (!file) return
    setUploadError(null)
    setNotice(null)
    setResult(null)
    setIgnoredColumns([])
    setIsReading(true)
    try {
      const { rows, ignoredColumns: ignored } = rosterRowsFromTable(await readRosterFile(file))
      if (rows.length === 0) throw new Error('No students were found in this file.')
      const added = rows.map((row): RosterReviewRow => {
        const normalizedId = row.studentId ? normalizeClassStudentId(row.studentId) : null
        const existingKey = normalizedId ? studentKeyByCode.get(normalizedId) : undefined
        const existing = existingKey ? (studentsById[existingKey] ?? null) : null
        nextRowKey.current += 1
        return {
          key: `row-${nextRowKey.current}`,
          name: row.name,
          studentId: normalizedId ?? row.studentId,
          existing,
          unknownId: row.studentId !== null && !existing,
          linkTo: null,
          extra: row.extra,
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
  const claimed = new Set(reviewRows.flatMap((row) => (row.existing ? [row.existing.id] : [])))
  const idPrefix = classStudentIdPrefix(classroom)
  let nextNumber = classroom.nextStudentNumber
  const reviewed = reviewRows.map((row) => {
    // An updated roster without Student IDs: a name that matches exactly one
    // student already in this class is that student, and keeps their ID.
    const sameNameInRoster =
      row.existing || row.linkTo ? [] : roster.filter((student) => normalizeStudentName(student.name) === normalizeStudentName(row.name))
    const nameMatch = sameNameInRoster.length === 1 && !claimed.has(sameNameInRoster[0].id) ? sameNameInRoster[0] : null
    if (nameMatch) claimed.add(nameMatch.id)
    const resolvedId = row.existing?.id ?? row.linkTo ?? nameMatch?.id ?? null
    // Same name in the teacher's other classes: offered as a
    // possible link, never applied automatically.
    const possibleMatches =
      row.existing || nameMatch
        ? []
        : students.filter(
            (student) =>
              ownStudentIds.has(student.id) &&
              !classroom.studentIds.includes(student.id) &&
              normalizeStudentName(student.name) === normalizeStudentName(row.name),
          )
    const problem = row.existing || nameMatch ? null : rosterNameProblem(row.name)
    // The Student ID the student has, or will get: new numbers go out in row
    // order, the same way withEnrolledStudents assigns them on save.
    const studentId = problem
      ? null
      : (resolvedId ? classroom.studentCodes[resolvedId] : undefined) ?? formatClassStudentId(idPrefix, nextNumber++)
    return {
      row,
      resolvedId,
      studentId,
      problem,
      nameMatch,
      alreadyInClass: resolvedId !== null && classroom.studentIds.includes(resolvedId),
      possibleMatches,
      sameNameInClass: !nameMatch && sameNameInRoster.length > 0,
      duplicateInUpload: !row.existing && !nameMatch && (nameCounts.get(normalizeStudentName(row.name)) ?? 0) > 1,
    }
  })
  const savable = reviewed.filter((item) => !item.problem)
  const rowsToAdd = savable.filter((item) => !item.alreadyInClass)
  const keptCount = savable.length - rowsToAdd.length
  const blockedCount = reviewed.length - savable.length

  const clearReview = () => {
    setReviewRows([])
    setUploadName(null)
    setIgnoredColumns([])
  }

  const [isSaving, setIsSaving] = useState(false)

  // Supabase Mode: everything not already on this class's roster is
  // registered as a new student with an app-generated Student ID.
  const confirmReviewRemote = async (register: NonNullable<RosterSectionProps['registerStudents']>) => {
    if (isSaving) return
    setIsSaving(true)
    setUploadError(null)
    try {
      const result = await register(classroom, rowsToAdd.map((item) => item.row.name.trim().replace(/\s+/g, ' ')))
      applyRegisteredStudents(props, result)
      const addedByRow = new Map(rowsToAdd.map((item, index) => [item.row.key, result.added[index]]))
      setResult({
        rows: savable.map((item) => {
          const added = addedByRow.get(item.row.key)
          const studentId = added?.studentId ?? (item.resolvedId ? classroom.studentCodes[item.resolvedId] : '') ?? ''
          return { name: added?.name ?? studentsById[item.resolvedId ?? '']?.name ?? item.row.name, studentId, extra: item.row.extra }
        }),
      })
      const parts = [
        ...(rowsToAdd.length > 0 ? [`added ${pluralize(rowsToAdd.length, 'student')}`] : []),
        ...(keptCount > 0 ? [`${pluralize(keptCount, 'student')} already on the roster kept their Student IDs`] : []),
      ]
      setNotice(`Roster saved for ${classDisplayName(classroom)}: ${parts.join('; ')}.`)
      if (result.warning) setUploadError(result.warning)
      setReviewRows((prev) => prev.filter((row) => reviewed.some((item) => item.row.key === row.key && item.problem)))
      setUploadName(null)
      setIgnoredColumns([])
    } catch (error) {
      setUploadError(toApiError(error, 'Couldn’t save the roster.').message)
    } finally {
      setIsSaving(false)
    }
  }

  const confirmReview = () => {
    if (props.registerStudents) {
      void confirmReviewRemote(props.registerStudents)
      return
    }
    if (props.writeBlocked) {
      setUploadError(props.writeBlocked)
      return
    }
    let keyNumber = nextStudentKeyNumber(students)
    const created: Student[] = []
    const keyByRow = new Map<string, string>()
    for (const item of savable) {
      let key = item.resolvedId
      if (!key) {
        const student = createStudent(keyNumber++, item.row.name)
        created.push(student)
        key = student.id
      }
      keyByRow.set(item.row.key, key)
    }
    const updated = addStudentsToClass(
      props,
      rowsToAdd.map((item) => keyByRow.get(item.row.key)!),
      created,
    )
    const nameOf = (key: string) => studentsById[key]?.name ?? created.find((student) => student.id === key)?.name ?? ''
    setResult({
      rows: savable.map((item) => {
        const key = keyByRow.get(item.row.key)!
        return { name: nameOf(key), studentId: updated.studentCodes[key], extra: item.row.extra }
      }),
    })
    const parts = [
      ...(rowsToAdd.length > 0 ? [`added ${pluralize(rowsToAdd.length, 'student')} (${created.length} new)`] : []),
      ...(keptCount > 0 ? [`${pluralize(keptCount, 'student')} already on the roster kept their Student IDs`] : []),
    ]
    setNotice(`Roster saved for ${classDisplayName(classroom)}: ${parts.join('; ')}.`)
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
            {isReading ? 'Reading file…' : (uploadName ?? 'CSV or Excel (.xlsx) · Student names')}
          </p>
        </div>
        <div className="roster-upload-actions">
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
      <p className="library-class-note">
        Each student receives a unique Student ID (e.g., <span className="roster-id">{formatClassStudentId(idPrefix, 1)}</span>).
        Students sign in to Student Feedback assignments with their first name and this ID. Existing IDs remain unchanged when the roster is updated.
      </p>
      {uploadError && (
        <p className="roster-error" role="alert">
          {uploadError}
        </p>
      )}
      {ignoredColumns.length > 0 && (
        <p className="roster-warning" role="status">
          Not imported: {ignoredColumns.join(', ')}. Only student names are kept in PARTNERS; these columns are included
          only in your downloaded roster with Student IDs.
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
            <h4>
              Review before saving ({pluralize(rowsToAdd.length, 'student')} to add
              {keptCount > 0 ? `, ${keptCount} already on the roster` : ''})
            </h4>
            <p>Student IDs are generated automatically. Students already in this class keep their IDs.</p>
          </div>
          <div className="class-mgmt-table-wrap">
            <table className="class-mgmt-table">
              <thead>
                <tr>
                  <th scope="col">Student Name</th>
                  <th scope="col">Student ID</th>
                  <th scope="col">Status</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {reviewed.map(
                  ({ row, studentId, problem, nameMatch, alreadyInClass, possibleMatches, sameNameInClass, duplicateInUpload }) => (
                    <tr key={row.key} className={problem ? 'blocked' : undefined}>
                      <th scope="row">
                        {row.existing || nameMatch ? (
                          <>
                            {(row.existing ?? nameMatch)!.name}
                            {row.existing &&
                              normalizeStudentName(row.name) !== normalizeStudentName(row.existing.name) &&
                              row.name && <small className="roster-also-in">Name in file: {row.name} (roster name kept)</small>}
                          </>
                        ) : (
                          <input
                            type="text"
                            aria-label="Student name"
                            aria-invalid={problem ? true : undefined}
                            value={row.name}
                            onChange={(event) => updateRow(row.key, { name: event.target.value, linkTo: null })}
                          />
                        )}
                      </th>
                      <td className="roster-id">{studentId ?? '—'}</td>
                      <td>
                        {problem ? (
                          <span className="roster-problem">{problem}</span>
                        ) : alreadyInClass ? (
                          <span className="roster-status muted">Already in this class — Student ID kept</span>
                        ) : row.existing ? (
                          <span className="roster-status">Rejoining this class — previous Student ID kept</span>
                        ) : (
                          <div className="roster-status-stack">
                            <span className="roster-status">{row.linkTo ? 'Linked to a student in your other classes' : 'New student'}</span>
                            {row.unknownId && (
                              <small>Student ID “{row.studentId}” isn’t in this class, so a new ID will be created.</small>
                            )}
                            {duplicateInUpload && <small>This name appears more than once — add an initial to tell them apart.</small>}
                            {sameNameInClass && (
                              <small>
                                More than one student could match this name, so a new Student ID will be created. Include the
                                Student ID column to keep an existing one.
                              </small>
                            )}
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
                                      Yes —{' '}
                                      {otherClassesFor(classes, classroom, student.id)
                                        .map((other) => `${other.studentCodes[student.id]} in ${classDisplayName(other)}`)
                                        .join(', ')}
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
                  ),
                )}
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
            <button type="button" className="primary-button" disabled={savable.length === 0} onClick={confirmReview}>
              {rowsToAdd.length > 0 ? `Add ${pluralize(rowsToAdd.length, 'Student')} to Roster` : 'Confirm Roster'}
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="roster-result" role="group" aria-labelledby="roster-result-heading">
          <div className="roster-result-header">
            <div className="roster-section-header">
              <h4 id="roster-result-heading">Roster with Student IDs</h4>
              <p>
                Give each student their Student ID. They enter it to open Student Feedback assignments for{' '}
                {classDisplayName(classroom)}.
              </p>
            </div>
            <div className="roster-download">
              <button
                type="button"
                className="primary-button"
                onClick={() => downloadCsv(rosterDownloadFileName(classroom), rosterResultCsv(result))}
              >
                Download Roster with Student IDs
              </button>
              <p className="roster-download-note">Share each Student ID privately with the corresponding student. Students sign in with their first name and Student ID.</p>
            </div>
          </div>
          <div className="class-mgmt-table-wrap">
            <table className="class-mgmt-table">
              <thead>
                <tr>
                  <th scope="col">Student Name</th>
                  <th scope="col">Student ID</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, index) => (
                  <tr key={`${row.studentId}-${index}`}>
                    <th scope="row">{row.name}</th>
                    <td className="roster-id">{row.studentId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

// The class's current roster: add one student, edit a name, remove a
// student. Every student added here is new and gets the class's next Student ID. Students are
// never matched to an existing record by name.
function RosterEditor(props: RosterSectionProps) {
  const { classroom, classes, students, studentsById, setClasses, setStudents } = props
  const [newName, setNewName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)

  const roster = classroom.studentIds.map((id) => studentsById[id]).filter(Boolean)
  const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ')

  const [isAdding, setIsAdding] = useState(false)
  const addStudent = async () => {
    const name = cleanName(newName)
    setNotice(null)
    const problem = rosterNameProblem(name)
    if (problem) {
      setAddError(problem)
      return
    }
    // Supabase Mode: saved through the database with an app-generated ID.
    if (props.registerStudents) {
      if (isAdding) return
      setIsAdding(true)
      setAddError(null)
      try {
        const sameName = roster.some((other) => normalizeStudentName(other.name) === normalizeStudentName(name))
        const result = await props.registerStudents(classroom, [name])
        applyRegisteredStudents(props, result)
        setNotice(
          `Added ${name} as ${result.added[0]?.studentId}.` +
            (sameName ? ' Another student in this class has the same name — consider adding an initial.' : ''),
        )
        if (result.warning) setAddError(result.warning)
        setNewName('')
      } catch (error) {
        setAddError(toApiError(error, 'Couldn’t add the student.').message)
      } finally {
        setIsAdding(false)
      }
      return
    }
    const student = createStudent(nextStudentKeyNumber(students), name)
    const sameName = roster.some((other) => normalizeStudentName(other.name) === normalizeStudentName(name))
    const updated = addStudentsToClass(props, [student.id], [student])
    setNotice(
      `Added ${name} as ${updated.studentCodes[student.id]}.` +
        (sameName ? ' Another student in this class has the same name — consider adding an initial.' : ''),
    )
    setAddError(null)
    setNewName('')
  }

  const editProblem = editing ? rosterNameProblem(cleanName(editing.name)) : null
  const saveName = () => {
    if (!editing) return
    if (props.writeBlocked) {
      setAddError(props.writeBlocked)
      return
    }
    const name = cleanName(editing.name)
    if (rosterNameProblem(name)) return
    setStudents((prev) => prev.map((student) => (student.id === editing.id ? { ...student, name } : student)))
    setEditing(null)
  }

  const removeFromClass = (student: Student) => {
    if (props.writeBlocked) {
      setAddError(props.writeBlocked)
      return
    }
    const studentId = classroom.studentCodes[student.id]
    setClasses((prev) =>
      prev.map((other) =>
        other.id === classroom.id ? { ...other, studentIds: other.studentIds.filter((id) => id !== student.id) } : other,
      ),
    )
    setNotice(
      `Removed ${student.name} (${studentId}) from ${classDisplayName(classroom)}. ${studentId} won’t be given to another student, and comes back if they rejoin.`,
    )
  }

  return (
    <div className="roster-manager">
      <div className="roster-current-header">
        <p className="library-class-note">
          This roster is reused for every lesson in {classDisplayName(classroom)}. Name changes apply everywhere the student
          appears.
        </p>
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
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {roster.map((student) => {
                const studentId = classroom.studentCodes[student.id]
                const otherClasses = otherClassesFor(classes, classroom, student.id)
                const isEditing = editing?.id === student.id
                return (
                  <tr key={student.id}>
                    <td className="roster-id">{studentId}</td>
                    <th scope="row">
                      {isEditing ? (
                        <>
                          <input
                            type="text"
                            aria-label={`Name for ${studentId}`}
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
          <span>Student name</span>
          <input
            type="text"
            placeholder="Jordan Smith"
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

      {/* After reviewing and editing the roster: download it to hand out IDs. */}
      {roster.length > 0 && (
        <div className="roster-download roster-download-footer">
          <button
            type="button"
            className="primary-button"
            onClick={() =>
              downloadCsv(rosterDownloadFileName(classroom), [
                ['Student Name', 'Student ID'],
                ...roster.map((student) => [student.name, classroom.studentCodes[student.id]]),
              ])
            }
          >
            Download Roster with Student IDs
          </button>
          <p className="roster-download-note">Share each Student ID privately with the corresponding student. Students sign in with their first name and Student ID.</p>
        </div>
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
  isSavingVersion: boolean
  defaultFramework: StandardsFrameworkId
  // A saved demo lesson's planning form to start from; null for a blank one.
  formSeed: PlanningFormSeed | null
  savedLessonOpen: boolean
  classGradeLevel: string | null
}

function LessonPlanningPage({
  onGenerateLessonPlan,
  onUploadLesson,
  lessonGenerated,
  isGeneratingLesson,
  canvasProps,
  planningPanelProps,
  activityClasses,
  lessonGeneratedWith,
  onStartNew,
}: {
  // The planning option that generated the workspace lesson, if any.
  lessonGeneratedWith: PlanningMethod | null
  // Clears everything for a new lesson or activity.
  onStartNew: () => void
  onGenerateLessonPlan: (details: PlanningLessonDetails) => void
  onUploadLesson?: (file: File, details: PlanningLessonDetails) => void
  lessonGenerated: boolean
  isGeneratingLesson: boolean
  canvasProps: LessonWorkspaceCanvasProps
  planningPanelProps: PlanningPanelProps
  // The class(es) an activity planned here belongs to — empty when Lesson
  // Planning wasn't opened in a class's context.
  activityClasses: readonly LinkClass[]
}) {
  // Brainstorm with AI's focus decides what the right side shows: a
  // practice activity gets the Activity workspace instead of the lesson.
  const [brainstormFocus, setBrainstormFocus] = useState<BrainstormFocus | null>(null)
  const isPracticeMode = planningPanelProps.planningTab === 'brainstorm' && brainstormFocus === 'practice'

  // The Activity Draft and the teacher's review of it. Nothing is confirmed
  // until the teacher says so; regenerating starts the review over.
  const [activityDraft, setActivityDraft] = useState<ActivityDraft | null>(null)
  const [isGeneratingActivity, setIsGeneratingActivity] = useState(false)
  const [activityConfirmed, setActivityConfirmed] = useState(false)
  const [collection, setCollection] = useState<CollectionOpportunity[]>([])
  const [collectionConfirmed, setCollectionConfirmed] = useState(false)
  // Identifies this activity in its Student Feedback link.
  const [activityLinkId] = useState(() => `activity-${Date.now()}`)
  const activityTimeoutRef = useRef<number | null>(null)
  useEffect(() => {
    return () => {
      if (activityTimeoutRef.current !== null) window.clearTimeout(activityTimeoutRef.current)
    }
  }, [])

  // A regeneration waiting for the teacher's OK, because it would replace
  // work they confirmed or edited.
  const [pendingRegeneration, setPendingRegeneration] = useState<ActivityDraftRequest | null>(null)
  const collectionEdited =
    activityDraft !== null && JSON.stringify(collection) !== JSON.stringify(activityDraft.collection)

  const generateActivity = (request: ActivityDraftRequest, confirmedOverwrite = false) => {
    if (isGeneratingActivity) return
    if (!confirmedOverwrite && activityDraft && (activityConfirmed || collectionConfirmed || collectionEdited)) {
      setPendingRegeneration(request)
      return
    }
    setPendingRegeneration(null)
    setIsGeneratingActivity(true)
    activityTimeoutRef.current = window.setTimeout(() => {
      const draft = callAiModel('practice-activity', request, mockActivityDraft)
      setActivityDraft(draft)
      setCollection(draft.collection)
      setActivityConfirmed(false)
      setCollectionConfirmed(false)
      setIsGeneratingActivity(false)
    }, 900)
  }

  // Continue Refining: back to the conversation on the left.
  const continueRefining = () => {
    const input = document.getElementById('brainstorm-message-input')
    input?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    input?.focus({ preventScroll: true })
  }

  return (
    <div className="planning-layout">
      <LessonPlanningPanel
        {...planningPanelProps}
        onGenerate={onGenerateLessonPlan}
        onUploadLesson={onUploadLesson}
        brainstormFocus={brainstormFocus}
        setBrainstormFocus={setBrainstormFocus}
        practiceActivity={{ hasDraft: activityDraft !== null, isGenerating: isGeneratingActivity, onGenerate: generateActivity }}
        // An activity is always generated in Brainstorm with AI.
        lockedMethod={activityDraft ? 'brainstorm' : lessonGeneratedWith}
        onStartNew={onStartNew}
      />

      {isPracticeMode ? (
        <PracticeActivityWorkspace
          draft={activityDraft}
          isGenerating={isGeneratingActivity}
          confirmed={activityConfirmed}
          onConfirm={() => setActivityConfirmed(true)}
          onContinueRefining={continueRefining}
          collection={collection}
          onCollectionChange={(next) => {
            setCollection(next)
            setCollectionConfirmed(false)
          }}
          collectionConfirmed={collectionConfirmed}
          onConfirmCollection={() => setCollectionConfirmed(true)}
          classes={activityClasses}
          linkId={activityLinkId}
          regenerationWarning={
            pendingRegeneration && {
              onRegenerate: () => generateActivity(pendingRegeneration, true),
              onKeep: () => setPendingRegeneration(null),
            }
          }
        />
      ) : lessonGenerated ? (
        <LessonWorkspaceCanvas {...canvasProps} />
      ) : (
        <LessonWorkspacePlaceholder isGenerating={isGeneratingLesson} />
      )}
    </div>
  )
}

// The right side in Science Practice Activity mode: the Activity Draft,
// Continue Refining / Confirm Activity, then — once confirmed — its
// student-work collection opportunities and the activity's Student
// Feedback link for a class. Styled like the generated lesson workspace.
function PracticeActivityWorkspace({
  draft,
  isGenerating,
  confirmed,
  onConfirm,
  onContinueRefining,
  collection,
  onCollectionChange,
  collectionConfirmed,
  onConfirmCollection,
  classes,
  linkId,
  regenerationWarning,
}: {
  // Shown when Regenerate would replace confirmed or edited work.
  regenerationWarning: { onRegenerate: () => void; onKeep: () => void } | null
  draft: ActivityDraft | null
  isGenerating: boolean
  confirmed: boolean
  onConfirm: () => void
  onContinueRefining: () => void
  collection: readonly CollectionOpportunity[]
  onCollectionChange: (next: CollectionOpportunity[]) => void
  collectionConfirmed: boolean
  onConfirmCollection: () => void
  // The classes the activity belongs to (from where it was planned).
  classes: readonly LinkClass[]
  linkId: string
}) {
  if (!draft) {
    return (
      <section className="workspace-placeholder lesson-workspace-panel">
        <div className="canvas-header">
          <div>
            <p className="card-label">Activity workspace</p>
            <h3>Science practice activity</h3>
          </div>
        </div>
        {isGenerating ? (
          <div className="empty-state">
            <p className="card-label">Drafting activity</p>
            <h3>Building your activity draft…</h3>
            <p className="empty-state-support">This will just take a moment.</p>
          </div>
        ) : (
          <div className="empty-state">
            <p className="card-label">Ready for activity output</p>
            <h3>Your activity draft will appear here</h3>
            <p className="empty-state-support">
              Brainstorm the activity with AI, then click Generate Activity Draft. You don’t need to complete the lesson form.
            </p>
          </div>
        )}
      </section>
    )
  }

  return (
    <section className="workspace-canvas activity-workspace" aria-labelledby="activity-draft-heading">
      <div className="canvas-header">
        <div>
          <p className="card-label">Activity workspace</p>
          <h3 id="activity-draft-heading">Activity draft</h3>
        </div>
        <span className={`badge activity-status${confirmed ? ' confirmed' : ''}`} role="status">
          {confirmed ? '✓ Teacher-approved' : 'Draft — not yet confirmed'}
        </span>
      </div>
      {isGenerating && (
        <p className="lesson-suggestion-summary" role="status">
          Updating the draft with your conversation…
        </p>
      )}
      {regenerationWarning && (
        <div className="activity-regenerate-warning" role="alertdialog" aria-labelledby="activity-regenerate-warning-text">
          <p id="activity-regenerate-warning-text">
            Regenerating replaces this draft{confirmed ? ', your confirmation of it,' : ''} and your student-work collection
            {collectionConfirmed ? ' confirmation' : ' edits'}. Regenerate anyway?
          </p>
          <div className="feedback-activity-actions">
            <button type="button" className="primary-button" onClick={regenerationWarning.onRegenerate}>
              Regenerate Anyway
            </button>
            <button type="button" className="secondary-button" onClick={regenerationWarning.onKeep}>
              Keep Current Draft
            </button>
          </div>
        </div>
      )}

      <div className="lesson-plan-editor activity-draft">
        <div className="lesson-plan-content">
          <p className="card-label lesson-section-heading">Activity Title</p>
          <p className="activity-title">{draft.title}</p>

          <p className="card-label lesson-section-heading">Grade Level</p>
          <p>{draft.gradeLabel}</p>

          <p className="card-label lesson-section-heading">Teaching Topic</p>
          <p>{draft.topic}</p>
          <p className="activity-topic-note">
            {draft.template !== 'generic'
              ? `Prewritten mock activity for the ${activityTemplateLabels[draft.template]} demo lesson, with your grade level and selected practices. Prototype content — not AI-generated for your class.`
              : `Generic mock activity template, filled in with your topic and selected practices — the prototype’s mock AI doesn’t evaluate the topic itself.${
                  draft.topicNotesUsed ? ` Some wording comes from built-in notes on ${draft.topicNotesUsed}, matched by keyword.` : ''
                }`}
          </p>

          <p className="card-label lesson-section-heading">Science Practices</p>
          <div className="context-tags">
            {practiceLabels(draft.practiceIds).map((label) => (
              <span key={label} className="tag">
                {label}
              </span>
            ))}
          </div>

          <p className="card-label lesson-section-heading">Activity Description</p>
          <p>{draft.description}</p>

          <p className="card-label lesson-section-heading">Activity Goal</p>
          <p>{draft.goal}</p>

          <p className="card-label lesson-section-heading">Activity Sequence</p>
          <ol className="activity-sequence">
            {draft.sequence.map((step) => (
              <li key={step.name}>
                <strong>{step.name}:</strong> {step.text}
              </li>
            ))}
          </ol>

          <p className="card-label lesson-section-heading">Grade-Level Supports</p>
          <p>{draft.supports}</p>

          <p className="card-label lesson-section-heading">Student Work to Collect (One Assignment)</p>
          <ul className="activity-collection-preview">
            {collection.map((item) => (
              <li key={item.id}>
                <strong>{item.name}</strong> — {item.submission}
              </li>
            ))}
          </ul>

          {draft.incorporated.length > 0 && (
            <>
              <p className="card-label lesson-section-heading">From Your Conversation</p>
              <ul className="activity-incorporated">
                {draft.incorporated.map((idea) => (
                  <li key={idea}>“{idea}”</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="activity-review-actions">
        <button type="button" className="secondary-button" onClick={onContinueRefining}>
          Continue Refining
        </button>
        {confirmed ? (
          <p className="activity-confirmed-note" role="status">
            ✓ Activity confirmed. To change it, keep refining and regenerate — the new draft will need your confirmation again.
          </p>
        ) : (
          <button type="button" className="primary-button" disabled={isGenerating} onClick={onConfirm}>
            Confirm Activity
          </button>
        )}
      </div>

      {confirmed && (
        <StudentProductCollection
          headingId="activity-collection-heading"
          products={draft.products}
          items={collection}
          confirmed={collectionConfirmed}
          onChange={onCollectionChange}
          onConfirm={onConfirmCollection}
        >
          <ClassFeedbackLinks
            link={{ lessonId: linkId, lessonTitle: draft.title, activities: collection.map(({ name, submission }) => ({ name, submission })) }}
            classes={classes}
            kind="activity"
            contents={`the ${joinLabels(collection.map((item) => item.name))}`}
          />
        </StudentProductCollection>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Student Feedback Activities
//
// At the bottom of the lesson: the student work it collects — for the
// prototype, a Model and an Explanation within one assignment. Teachers
// review, edit, or remove them and confirm; the lesson then gets one Student
// Feedback link for both. There's no backend yet, so the link carries them
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

// The lesson-specific assignment a Student Feedback link opens. `classId`
// is the class whose students may sign in to it; each class the lesson is
// assigned to gets its own link.
type StudentAssignmentLink = {
  lessonId: string
  lessonTitle: string
  activities: { name: string; submission: string }[]
  classId?: string
}

// For the prototype, a lesson collects its two student products (see
// studentProductsFor) — the lesson's own sequence is left as it is.
function identifyFeedbackActivities(lessonId: string | null): FeedbackActivity[] {
  return studentProductsFor(lessonId).map((product) => ({ ...product, confirmed: false }))
}

// The link's assignment, or null until there's at least one activity and
// every activity is confirmed.
function assignmentLinkFor(lessonId: string, lessonTitle: string, activities: readonly FeedbackActivity[]): StudentAssignmentLink | null {
  if (activities.length === 0 || activities.some((activity) => !activity.confirmed)) return null
  return { lessonId, lessonTitle, activities: activities.map(({ name, submission }) => ({ name, submission })) }
}

function encodeAssignment(link: StudentAssignmentLink): string {
  const json = JSON.stringify({
    l: link.lessonId,
    t: link.lessonTitle,
    a: link.activities.map((item) => [item.name, item.submission]),
  })
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

// Where a Student Feedback URL points: one lesson's assignment for one
// class. The assignment is either a lesson's confirmed Student Feedback
// Activities (`link`) or one of a Library lesson's demo assignments
// (`taskId`), e.g.
//   #student-feedback?lesson=zombie-fires&class=period-4-earth-science&assignment=…
// Every lesson in a class has its own URL; students sign in to each with the
// same class Student ID.
type StudentFeedbackRoute = {
  lessonId: string
  classId: string | null
  taskId: string | null
  link: StudentAssignmentLink | null
}

function studentFeedbackHash(route: StudentFeedbackRoute): string {
  const params = new URLSearchParams({ lesson: route.lessonId })
  if (route.classId) params.set('class', route.classId)
  if (route.taskId) params.set('task', route.taskId)
  if (route.link) params.set('assignment', encodeAssignment(route.link))
  return `student-feedback?${params.toString()}`
}

function studentAssignmentHash(link: StudentAssignmentLink): string {
  return studentFeedbackHash({ lessonId: link.lessonId, classId: link.classId ?? null, taskId: null, link })
}

function studentAssignmentUrl(link: StudentAssignmentLink): string {
  return `${window.location.origin}${window.location.pathname}#${studentAssignmentHash(link)}`
}

// The Student Feedback route in the current URL, if there is one.
function readStudentFeedbackRoute(): StudentFeedbackRoute | null {
  const [page, query] = window.location.hash.replace('#', '').split('?')
  if (page !== 'student-feedback' || !query) return null
  const params = new URLSearchParams(query)
  const classId = params.get('class')
  const decoded = decodeAssignment(params.get('assignment') ?? '')
  const link = decoded ? { ...decoded, ...(classId ? { classId } : {}) } : null
  const lessonId = link?.lessonId ?? params.get('lesson')
  if (!lessonId) return null
  return { lessonId, classId, taskId: link ? null : params.get('task'), link }
}

// Where Individual Student Reports points: one lesson's submissions in one
// class, the assignment (null: the lesson's first), optionally one student
// (by class Student ID), and the model type, e.g.
//   #student-reports?lesson=covid-virus&class=period-1-life-science&assignment=covid-mechanistic&student=DE-004&model=mechanistic
type StudentReportsRoute = {
  lessonId: string
  classId: string | null
  assignmentId: string | null
  studentId: string | null
  modelTab: ModelTab
  // Which student product the report shows.
  work: WorkType
}

function studentReportsHash(route: StudentReportsRoute): string {
  const params = new URLSearchParams({ lesson: route.lessonId })
  if (route.classId) params.set('class', route.classId)
  if (route.assignmentId) params.set('assignment', route.assignmentId)
  if (route.studentId) params.set('student', route.studentId)
  params.set('model', route.modelTab)
  params.set('work', route.work)
  return `student-reports?${params.toString()}`
}

function readStudentReportsRoute(): StudentReportsRoute | null {
  const [page, query] = window.location.hash.replace('#', '').split('?')
  if (page !== 'student-reports' || !query) return null
  const params = new URLSearchParams(query)
  const lessonId = params.get('lesson')
  if (!lessonId) return null
  return {
    lessonId,
    classId: params.get('class'),
    assignmentId: params.get('assignment'),
    studentId: params.get('student'),
    modelTab: params.get('model') === 'mechanistic' ? 'mechanistic' : 'descriptive',
    work: params.get('work') === 'explanation' ? 'explanation' : 'model',
  }
}

// A Library lesson's demo assignment by id (the `task` in its URL).
function findDemoAssignment(lessonId: string, taskId: string | null): StudentFeedbackAssignment | null {
  const lesson = initialLibraryLessons.find((item) => item.id === lessonId)
  return lesson?.studentFeedback.find((assignment) => assignment.id === taskId) ?? null
}

// A class the lesson is assigned to, for its Student Feedback link.
type LinkClass = { id: string; label: string }

// The Student Feedback link for each class a lesson or activity belongs to.
// The class comes from where the lesson or activity was planned — it's
// shown as a read-only label, never picked, and never defaulted: with no
// class, the teacher is told how to get one.
function ClassFeedbackLinks({
  link,
  classes,
  kind,
  contents,
}: {
  // The assignment, without a class; each class's link adds its own.
  link: StudentAssignmentLink
  classes: readonly LinkClass[]
  kind: 'lesson' | 'activity'
  // What the link lists, e.g. "all 3 activities".
  contents: string
}) {
  // The link just copied; a changed link shows Copy Link again.
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  if (classes.length === 0) {
    return (
      <p className="feedback-link-pending" role="status">
        This {kind} isn’t associated with a class yet, so it has no Student Feedback link. Create a class in Class Setup, then plan
        the {kind} from that class (Add Lesson in the Library, or Continue to Lesson Planning in Class Setup) — students sign in with
        the Student IDs from its roster.
      </p>
    )
  }
  const copyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
    } catch {
      setCopiedUrl(null)
    }
  }
  return (
    <>
      {classes.map((classroom) => {
        const url = studentAssignmentUrl({ ...link, classId: classroom.id })
        return (
          <div key={classroom.id} className="feedback-link-class">
            <p className="feedback-link-class-name">Class: {classroom.label}</p>
            <div className="feedback-link-row">
              <input
                type="text"
                readOnly
                value={url}
                aria-label={`Student Feedback link for ${classroom.label}`}
                onFocus={(event) => event.target.select()}
              />
              <button type="button" className="secondary-button" onClick={() => void copyLink(url)}>
                {copiedUrl === url ? 'Copied' : 'Copy Link'}
              </button>
              <a className="primary-button feedback-open-link" href={url} target="_blank" rel="noopener noreferrer">
                Open Student Page
              </a>
            </div>
          </div>
        )
      })}
      <p className="feedback-link-note">
        {classes.length > 1 ? `Each class has its own link to this ${kind}` : `This ${kind}’s link for ${classes[0].label}`} — one assignment
        where students submit {contents}. Students sign in with their class Student ID — the same ID for every lesson in the class. Student
        submissions aren’t saved yet in the prototype.
      </p>
    </>
  )
}

// The student work one assignment collects — for the prototype, a Model and
// an Explanation (see studentProducts). Teachers review each, can edit its
// description or remove it (and add it back), and confirm them together;
// the assignment then gets one Student Feedback link (`children`). Initial
// and revised submissions are versions of these products, not new items.
function StudentProductCollection({
  headingId,
  products,
  items,
  confirmed,
  onChange,
  onConfirm,
  children,
}: {
  headingId: string
  // The lesson's two product types, in order (what a removed one comes back as).
  products: readonly CollectionOpportunity[]
  items: readonly CollectionOpportunity[]
  confirmed: boolean
  onChange: (next: CollectionOpportunity[]) => void
  onConfirm: () => void
  // The Student Feedback link, shown once confirmed.
  children: ReactNode
}) {
  const [editing, setEditing] = useState<{ id: string; submission: string } | null>(null)
  const removed = products.filter((product) => !items.some((item) => item.id === product.id))
  const names = joinLabels(items.map((item) => item.name))

  const saveEdit = () => {
    if (!editing?.submission.trim()) return
    onChange(items.map((item) => (item.id === editing.id ? { ...item, submission: ensurePeriod(editing.submission.trim()) } : item)))
    setEditing(null)
  }
  // Back in its usual place, in the lesson's product order.
  const addBack = (product: CollectionOpportunity) =>
    onChange(products.flatMap((option) => (option.id === product.id ? [{ ...product }] : items.filter((item) => item.id === option.id))))

  return (
    <section className="feedback-activities" aria-labelledby={headingId}>
      <div className="feedback-activities-header">
        <div>
          <p className="card-label">Student Work Collection</p>
          <h4 id={headingId}>{items.length > 0 ? `One assignment: ${names}` : 'One assignment'}</h4>
        </div>
        {items.length > 0 && (
          <span className={`badge feedback-confirmed-count${confirmed ? ' all-confirmed' : ''}`}>{confirmed ? 'Confirmed' : 'Needs confirmation'}</span>
        )}
      </div>
      <p className="feedback-activities-hint">
        Students submit both products in the same assignment. When they revise, the new work is saved as a new version of it — not a
        separate assignment.
      </p>

      {items.length > 0 && (
        <ul className="feedback-activity-list student-product-list">
          {items.map((item) => (
            <li key={item.id} className={`feedback-activity${confirmed ? ' confirmed' : ''}`}>
              <div className="feedback-activity-text collection-opportunity-text">
                <p className="feedback-activity-name">{item.name}</p>
                {editing?.id === item.id ? (
                  <div className="feedback-activity-editor">
                    <label>
                      <span>Description</span>
                      <textarea
                        rows={2}
                        value={editing.submission}
                        autoFocus
                        onChange={(event) => setEditing({ id: item.id, submission: event.target.value })}
                      />
                    </label>
                    <div className="feedback-activity-actions">
                      <button type="button" className="primary-button" disabled={!editing.submission.trim()} onClick={saveEdit}>
                        Save
                      </button>
                      <button type="button" className="secondary-button" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <p>
                    <span className="collection-field-label">Description:</span> {item.submission}
                  </p>
                )}
              </div>
              {editing?.id !== item.id && (
                <div className="feedback-activity-actions">
                  <button type="button" className="secondary-button" onClick={() => setEditing({ id: item.id, submission: item.submission })}>
                    Edit
                  </button>
                  <button
                    type="button"
                    className="ghost-button feedback-activity-remove"
                    aria-label={`Remove ${item.name}`}
                    onClick={() => onChange(items.filter((other) => other.id !== item.id))}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {removed.map((product) => (
        <button key={product.id} type="button" className="secondary-button feedback-add-button" onClick={() => addBack(product)}>
          + Add {product.name} back
        </button>
      ))}

      {!confirmed && items.length > 0 && (
        <button type="button" className="primary-button activity-collection-confirm" disabled={editing !== null} onClick={onConfirm}>
          Confirm {names}
        </button>
      )}

      <div className="feedback-link" aria-live="polite">
        <p className="card-label">Student Feedback link</p>
        {confirmed ? (
          children
        ) : (
          <p className="feedback-link-pending" role="status">
            {items.length === 0
              ? `Pending — add the ${joinLabels(products.map((product) => product.name))} back to create the link.`
              : `Pending — confirm the ${names} to create this assignment’s Student Feedback link.`}
          </p>
        )}
      </div>
    </section>
  )
}

function StudentFeedbackActivities({
  lessonId,
  lessonTitle,
  activities,
  linkClasses,
  onChange,
}: {
  lessonId: string
  lessonTitle: string
  activities: readonly FeedbackActivity[]
  linkClasses: readonly LinkClass[]
  onChange: (next: FeedbackActivity[]) => void
}) {
  const link = assignmentLinkFor(lessonId, lessonTitle, activities)
  return (
    <StudentProductCollection
      headingId="feedback-activities-heading"
      products={studentProductsFor(lessonId)}
      items={activities}
      confirmed={link !== null}
      // An edited product keeps its confirmation; one added back needs it.
      onChange={(next) =>
        onChange(next.map((item) => ({ ...item, confirmed: activities.find((activity) => activity.id === item.id)?.confirmed ?? false })))
      }
      onConfirm={() => onChange(activities.map((activity) => ({ ...activity, confirmed: true })))}
    >
      {link && <ClassFeedbackLinks link={link} classes={linkClasses} kind="lesson" contents={`the ${joinLabels(activities.map((activity) => activity.name))}`} />}
    </StudentProductCollection>
  )
}

type LessonWorkspaceCanvasProps = {
  // Supabase Mode: whether the lesson is saved (shown under the header).
  saveStatus?: { kind: 'saving' | 'saved' | 'error' | 'info'; message: string; retry?: VersionCreatedBy } | null
  // A lesson version is being saved; Save Edits waits for it.
  isSavingVersion?: boolean
  // Called when the teacher saves manual edits that changed the lesson.
  onEditsSaved?: () => void
  // Saves the lesson's current changes again after a failed save.
  onRetrySave?: (createdBy: VersionCreatedBy) => void
  editor: RevisionWorkflow
  lesson: LessonDocument
  // The id used in the lesson's Student Feedback link.
  lessonLinkId: string
  // The classes the lesson is assigned to; each gets its own link.
  linkClasses: readonly LinkClass[]
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
  saveStatus = null,
  isSavingVersion = false,
  onEditsSaved,
  onRetrySave,
  editor,
  lesson,
  lessonLinkId,
  linkClasses,
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
    const changed = Object.entries(draftBySection).filter(([label, text]) => text !== editBaseline[label])
    setManualEdits((prev) => {
      const next = { ...prev }
      for (const [label, text] of changed) {
        next[label] = text
      }
      return next
    })
    setIsEditing(false)
    if (changed.length > 0) onEditsSaved?.()
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
              disabled={isSavingVersion}
            >
              {isEditing ? 'Save Edits' : 'Edit Lesson'}
            </button>
            <button type="button" className="primary-button">
              Export Lesson Plan
            </button>
          </div>
        </div>

        {saveStatus && (
          <p className={`lesson-save-status ${saveStatus.kind}`} role={saveStatus.kind === 'error' ? 'alert' : 'status'}>
            {saveStatus.message}
            {saveStatus.retry && onRetrySave && (
              <>
                {' '}
                <button type="button" className="lesson-save-retry" onClick={() => onRetrySave(saveStatus.retry!)} disabled={isSavingVersion}>
                  Try again
                </button>
              </>
            )}
          </p>
        )}
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
          linkClasses={linkClasses}
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

// The two student products one assignment collects (see studentProducts).
// Class Feedback and Individual Student Reports switch between them — the
// type of work reviewed, never the assignment.
type WorkType = 'model' | 'explanation'
// What a report or evidence card shows of each submission.
type WorkView = WorkType | 'both'

// The switch between the assignment's two student products (Model /
// Explanation, or the lesson's own, e.g. Descriptive / Mechanistic).
function WorkTypeSwitch({ options, value, onChange }: { options: ProductSwitch['options']; value: string; onChange: (next: string) => void }) {
  return (
    <div className="work-type-switch">
      <span>Student Work</span>
      <div className="work-type-options" role="group" aria-label="Student work type">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`work-type-option${value === option.id ? ' active' : ''}`}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// What the switch's choice means for an assignment: a product's own entry
// (`assignmentId`), or the work type within the same entry.
function chooseProduct(
  assignment: ClassFeedbackAssignment,
  productId: string,
): { assignment: ClassFeedbackAssignment; workType: WorkType | null } {
  if (assignment.productId) {
    const entry = classFeedbackAssignmentsFor(assignment.lessonId).find((item) => item.productId === productId) ?? assignment
    return { assignment: entry, workType: null }
  }
  return { assignment, workType: productId === 'explanation' ? 'explanation' : 'model' }
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

// ---------------------------------------------------------------------------
// Student Feedback mock content, per lesson
//
// Everything the Student Feedback page shows — the task, the student
// products (one tab each, with its own AI Feedback conversation), starter
// model, explanation, and the mock AI's replies — comes from the lesson's
// scenario, so a lesson never shows another lesson's content. COVID Virus
// and Zombie Fires have their own demo content; any other lesson gets the
// generic scenario, built from its title.
// ---------------------------------------------------------------------------

type StudentFeedbackScenarioId = 'covid-virus' | 'zombie-fires' | 'generic'

// One student product's tab.
type StudentFeedbackTab = {
  id: string
  label: string
  // A model tab shows the model area (starter image, Add Model, a name);
  // an explanation tab shows its prompt above the explanation.
  kind: 'model' | 'explanation'
  // The product's prompt: a heading and its text, or labeled parts.
  promptLabel: string
  prompt: string | { heading: string; instruction: string; labels: string[] }[]
  // The starter model shown until the student adds their own, if any.
  starterImage: string | null
  starterAlt: string
  // The AI panel's tint (see .ai-panel-descriptive / .ai-panel-mechanistic).
  tint: 'descriptive' | 'mechanistic'
  subtitle: string
  // Links this product to the one before it, e.g. "Building on your Model".
  progressionNote?: string
  initialFeedback: ChatMessage[]
  // A scaffolding question for the student's message — never the answer.
  reply: (message: string, followUpCount: number) => string
}

type StudentFeedbackScenario = {
  id: StudentFeedbackScenarioId
  // Shown when the page opens without an assignment link.
  task: { topic: string; prompt: string }
  tabs: StudentFeedbackTab[]
  initialExplanation: string
  explanationPlaceholder: string
  // What the mock microphone "hears".
  micExplanation: string
  micReply: string
}

// Picks the scenario's follow-up whose keywords appear first, else rotates
// through its general questions so the conversation always has somewhere to go.
function keywordReply(rules: [RegExp, string][], fallbacks: string[]) {
  return (message: string, followUpCount: number) => {
    const lower = message.toLowerCase()
    return rules.find(([pattern]) => pattern.test(lower))?.[1] ?? fallbacks[followUpCount % fallbacks.length]
  }
}

// COVID Virus (unchanged demo content). Descriptive stays on the structures
// and labels in the drawing; Mechanistic pushes toward interactions and
// change, and sends the student back to their Descriptive Model.
const covidFeedbackScenario: StudentFeedbackScenario = {
  id: 'covid-virus',
  task: {
    topic: 'COVID-19 & Handwashing: Structure and Function',
    prompt:
      'Develop and use models to think about the structures of the coronavirus and soap, then explain how the structure of soap helps it function when mixed with water.',
  },
  tabs: [
    {
      id: 'descriptive',
      label: 'Descriptive Model',
      kind: 'model',
      promptLabel: 'Descriptive Model',
      prompt: descriptiveModelPrompt,
      starterImage: COVID_DESCRIPTIVE_MODEL_EXAMPLE_IMAGE,
      starterAlt: 'Descriptive model of the coronavirus (protein, fatty envelope, genetic material) and a soap molecule (hydrophilic head, hydrophobic tail)',
      tint: 'descriptive',
      subtitle: 'Explore the structures and features shown in your model.',
      initialFeedback: [
        {
          role: 'ai',
          text: 'I see that you labeled the coronavirus’s fatty envelope and the two parts of the soap molecule. Where could you add water to your drawing so the relationship between the hydrophilic part and water is easier to see?',
        },
        { role: 'teacher', text: 'I could draw water molecules around the soap.' },
        { role: 'ai', text: 'That could make the relationship clearer. Which part of the soap molecule should point toward the water in your drawing?' },
      ],
      reply: keywordReply(
        [
          [/protein|spike/, 'You mentioned the protein. Where did you draw it on the coronavirus, and how does its position compare to the fatty envelope in your model?'],
          [/envelope|fatty/, 'You’re describing the fatty envelope. What part of the soap molecule do you think would interact with it — and did you label that part?'],
          [/genetic|rna|dna/, 'You’re thinking about the genetic material. Where is it positioned in your model, and did you draw or label anything around it to show what protects it?'],
          [/hydrophilic|water/, 'You’re describing the hydrophilic portion. Which end of the soap molecule is that, and how did you show it in your diagram?'],
          [/hydrophobic|fat/, 'You’re describing the hydrophobic portion. Which direction does that part point in your drawing, and is that relationship labeled?'],
        ],
        [
          'Which structure in your model would that be part of — is it something you could add a label for?',
          'Is that a structure you’ve already drawn, or a new part you’d want to add to your model?',
          'Where is that positioned in your drawing, and is its relationship to the nearby structures easy to see?',
          'How does that structure compare between the virus and the soap molecule in your model?',
        ],
      ),
    },
    {
      id: 'mechanistic',
      label: 'Mechanistic Model',
      kind: 'model',
      promptLabel: 'Mechanistic Model',
      prompt: mechanisticModelPrompt,
      starterImage: COVID_MECHANISTIC_MODEL_EXAMPLE_IMAGE,
      starterAlt: 'Mechanistic model of soap molecules trapping oil droplets in water',
      tint: 'mechanistic',
      subtitle: 'Use the structures you identified to explain how the interaction happens.',
      progressionNote: 'Building on your Descriptive Model',
      initialFeedback: [
        {
          role: 'ai',
          text: 'I see that you drew the hydrophobic part of the soap next to the virus’s fatty envelope. What could you add to show what happens when many soap molecules interact with the envelope?',
        },
        { role: 'teacher', text: 'Maybe I could show the fatty layer starting to break apart?' },
        {
          role: 'ai',
          text: 'Look back at your Descriptive Model: you showed that the hydrophobic part of soap interacts with fat while the hydrophilic part interacts with water. How could you use arrows, labels, or positioning in your Mechanistic Model to show how these interactions contribute to the change in the fatty envelope?',
        },
      ],
      reply: keywordReply(
        [
          [/stick|attach|grab/, 'That connection could be useful to show in your model. What arrow or label could you add to represent what you think the soap is doing?'],
          [/break|dissolve|disrupt|apart/, 'You’re describing something happening to the virus’s structure. What part of your model shows the fatty envelope actually being disrupted, and how would you show that change?'],
          [/surround|cluster|group|ball/, 'That’s an interesting way to represent it. What’s on the outside of that cluster in your model, and what’s on the inside?'],
          [/mix|combine|oil.*water|water.*oil/, 'You’re describing how oil and water interact with soap. Which part of the soap molecule is facing the oil, and which part is facing the water in your drawing?'],
          [/rinse|wash|remove|away/, 'You’re describing the virus being carried away. What could you add — an arrow, or a change in the drawing — to show what happens right before that point?'],
        ],
        [
          'Where in your model would that interaction show up — is it something you could add an arrow for?',
          'How could you use arrows or labels to show that happening over time, rather than all at once?',
          'Is that something your model already shows happening, or a new relationship you’d want to add?',
          'Which structures are involved in that, and how would you position them relative to each other to show it?',
        ],
      ),
    },
  ],
  initialExplanation: initialStudentExplanation,
  explanationPlaceholder: "Explain how your model shows the structures of the coronavirus and soap, and how soap's structure helps it work with water...",
  micExplanation: 'Also, I think the hydrophilic end is what lets the soap mix into the water in the first place.',
  micReply: "I think the hydrophobic tail pulls toward the virus's fatty envelope, away from the water.",
}

// Zombie Fires: the Model tab helps students represent components,
// relationships, and processes; the Explanation tab helps them explain
// causes and support their reasoning with evidence.
const zombieFiresFeedbackScenario: StudentFeedbackScenario = {
  id: 'zombie-fires',
  task: {
    topic: dashboardTask.topic,
    prompt: 'Develop a model of how zombie fires keep burning through the winter, then use it to explain how matter and energy flow between the biosphere and atmosphere.',
  },
  tabs: [
    {
      id: 'model',
      label: 'Model',
      kind: 'model',
      promptLabel: 'Model',
      prompt: dashboardTask.question.replace(/^Prompt:\s*/, ''),
      starterImage: ZOMBIE_FIRES_STUDENT_MODEL_IMAGE,
      starterAlt: 'Model of a zombie fire showing peat, permafrost, fire, and the atmosphere',
      tint: 'descriptive',
      subtitle: 'Show the components, relationships, and processes in your model.',
      initialFeedback: [
        {
          role: 'ai',
          text: 'I see that your model shows fire burning above the ground. What could you add to show how the fire continues burning in peat beneath the snow during winter?',
        },
        { role: 'teacher', text: 'I could add a layer of peat under the snow and show the fire continuing underground.' },
        {
          role: 'ai',
          text: 'That could help explain why zombie fires survive winter. How could you show the movement of matter and energy in your revised model?',
        },
      ],
      reply: keywordReply(
        [
          [/peat/, 'You’re adding the peat layer. Where does it sit in your model compared with the snow and the permafrost, and is that labeled?'],
          [/permafrost|thaw/, 'You mentioned permafrost. How could your model show what happens to the permafrost as the fire smolders above it?'],
          [/snow|ice|winter|cold/, 'You’re thinking about the snow and ice. How could you show in your model what the fire under the snow is getting — and losing — during the winter?'],
          [/carbon|co2|co₂|smoke|gas/, 'You’re describing carbon moving. Where could you add an arrow to show carbon leaving the peat, and where does it go?'],
          [/energy|heat|warm|temperature/, 'You’re thinking about energy. How could you show the heat moving in your model — where it starts, and where it ends up?'],
          [/spring|season|flare|reignit|come back/, 'You’re describing the fire returning in spring. How could your model show the change between winter and spring — maybe two panels, or arrows over time?'],
          [/arrow/, 'Arrows can show processes. What does each arrow in your model stand for — matter, energy, or both — and how would someone reading it know?'],
        ],
        [
          'Which part of your model would that be — is it a component, a relationship, or a process you could add an arrow for?',
          'Is that something your model already shows, or a new part you’d want to add when you revise it?',
          'How could you show that changing over time, rather than all at once?',
          'What would someone looking at your model need to see to understand how matter and energy move in a zombie fire?',
        ],
      ),
    },
    {
      id: 'explanation',
      label: 'Explanation',
      kind: 'explanation',
      promptLabel: 'Explanation',
      prompt:
        'Explain how zombie fires keep burning under snow and ice through the winter, and why they release so much carbon. Use your model and evidence — such as temperature or CO₂ data — to support your reasoning.',
      starterImage: null,
      starterAlt: '',
      tint: 'mechanistic',
      subtitle: 'Explain the causes, and support your reasoning with evidence.',
      progressionNote: 'Building on your Model',
      initialFeedback: [
        {
          role: 'ai',
          text: 'Your explanation says the fire keeps burning underground. What causes it to keep going through the winter, and what evidence supports that?',
        },
        { role: 'teacher', text: 'The peat has a lot of carbon and the snow keeps the heat in, so it doesn’t go out.' },
        {
          role: 'ai',
          text: 'That’s a cause-and-effect idea you can build on. What evidence from your model or the data shows the snow keeping heat in the peat?',
        },
      ],
      reply: keywordReply(
        [
          [/because|cause|so that|reason/, 'You’re giving a cause. What evidence — from your model or the data — would convince someone that this cause is right?'],
          [/data|evidence|graph|measure/, 'Good — you’re bringing in evidence. How does that evidence connect back to your claim about why the fire keeps burning?'],
          [/carbon|co2|co₂/, 'You’re explaining the carbon release. Where was that carbon stored before the fire, and how does your explanation show it moving into the atmosphere?'],
          [/heat|energy|warm|temperature/, 'You’re explaining the energy part. What keeps supplying energy to the fire under the snow, and how do you know?'],
          [/snow|ice|insulat|blanket/, 'You’re explaining the snow’s role. How does it affect the fire — and what observation or data supports that?'],
        ],
        [
          'What causes that to happen — can you connect it to something in your model?',
          'What evidence supports that part of your explanation?',
          'How would you explain that to someone who thinks fires always go out in winter?',
          'Which part of your explanation are you least sure about, and what evidence could help?',
        ],
      ),
    },
  ],
  initialExplanation:
    "Zombie fires keep burning because the fire moves down into the peat under the snow. The peat has a lot of carbon in it, so it keeps burning slowly all winter, and in spring it comes back up. I'm not sure yet how to show where the carbon goes.",
  explanationPlaceholder: 'Explain how your model shows matter and energy moving in a zombie fire, and what evidence supports it...',
  micExplanation: 'Also, I think the snow acts like a blanket that keeps the heat in the peat.',
  micReply: 'I think the peat keeps burning because it has so much carbon stored in it.',
}

// Any other lesson: general Model and Explanation prompts built from its
// title — nothing claimed about the topic itself.
function genericFeedbackScenario(lessonTitle: string | null): StudentFeedbackScenario {
  const topic = lessonTitle ?? 'your assignment'
  return {
    id: 'generic',
    task: { topic, prompt: 'Develop a model of the phenomenon, then explain it using your model and evidence.' },
    tabs: [
      {
        id: 'model',
        label: 'Model',
        kind: 'model',
        promptLabel: 'Model',
        prompt: `Develop a model that shows what is happening in ${topic} and what causes it. Include the key parts, how they interact, and any changes over time.`,
        starterImage: null,
        starterAlt: '',
        tint: 'descriptive',
        subtitle: 'Show the components, relationships, and processes in your model.',
        initialFeedback: [{ role: 'ai', text: 'Add your model when you’re ready. Which parts of the phenomenon does your model show so far, and how are they connected?' }],
        reply: keywordReply(
          [[/arrow/, 'What does each arrow in your model stand for, and how would someone reading it know?']],
          [
            'Which part of your model would that be — a component, a relationship, or a process?',
            'Is that something your model already shows, or something you’d add when you revise it?',
            'How could you show that changing over time?',
          ],
        ),
      },
      {
        id: 'explanation',
        label: 'Explanation',
        kind: 'explanation',
        promptLabel: 'Explanation',
        prompt: `Explain the phenomenon in ${topic} using your model and evidence to support your reasoning.`,
        starterImage: null,
        starterAlt: '',
        tint: 'mechanistic',
        subtitle: 'Explain the causes, and support your reasoning with evidence.',
        progressionNote: 'Building on your Model',
        initialFeedback: [{ role: 'ai', text: 'Write your explanation when you’re ready. What do you think causes the phenomenon, and what evidence supports that?' }],
        reply: keywordReply(
          [[/because|cause/, 'You’re giving a cause. What evidence would convince someone that it’s right?']],
          ['What evidence supports that part of your explanation?', 'How does your model help explain that?', 'Which part are you least sure about?'],
        ),
      },
    ],
    initialExplanation: '',
    explanationPlaceholder: 'Explain the phenomenon using your model and evidence...',
    micExplanation: 'I think the evidence shows a pattern that my model can explain.',
    micReply: 'I think my model shows how the parts are connected.',
  }
}

// The scenario for a Student Feedback page: by the lesson (or, for an
// activity's link, the activity's template), and by its student products.
function studentFeedbackScenarioFor(
  lessonId: string | null,
  lessonTitle: string | null,
  productNames: readonly string[] = [],
): StudentFeedbackScenario {
  if (lessonId === 'covid-virus' || productNames.includes('Descriptive')) return covidFeedbackScenario
  if (lessonId === 'zombie-fires') return zombieFiresFeedbackScenario
  const template = activityTemplateFor(lessonTitle)
  if (template === 'covid-virus') return covidFeedbackScenario
  if (template === 'zombie-fires') return zombieFiresFeedbackScenario
  return genericFeedbackScenario(lessonTitle)
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


// Student Login in front of a Student Feedback assignment (see "Student
// login (prototype)"). The ID is checked against the assignment's class
// roster only; there's no password and no real authentication.
function StudentLoginGate({
  classId,
  lessonTitle,
  classes,
  signIns,
  onSignIn,
  onSignOut,
  children,
}: {
  // null when the assignment isn't tied to a class (e.g. an unassigned lesson).
  classId: string | null
  // The lesson the URL opens, when known.
  lessonTitle: string | null
  classes: readonly LibraryClass[]
  signIns: Record<string, string>
  onSignIn: (classId: string, studentId: string) => void
  onSignOut: (classId: string) => void
  children: ReactNode
}) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Teacher Preview (prototype demonstrations only): opens the assignment
  // without a Student ID. It's local to this page — no session is stored,
  // no student ID is used, and everything done in it is discarded on Exit
  // Preview (the page's state unmounts). Nothing reaches Class Feedback.
  // In production this must be limited to signed-in, authorized teachers.
  const [isPreviewing, setIsPreviewing] = useState(false)
  const signedInAs = classId ? signIns[classId] : undefined
  // Read on each render rather than once, so a roster the teacher just saved
  // in another tab is picked up.
  const roster = classId ? findLoginRoster(classId, classes) : null

  if (classId && isPreviewing && !signedInAs) {
    return (
      <>
        <div className="student-session-bar teacher-preview-bar" role="status">
          <span>
            <strong>Teacher Preview</strong>
            {roster && <> · {roster.label}</>} · Not signed in as a student — nothing here is saved or counted in Class Feedback.
          </span>
          <button type="button" className="secondary-button" onClick={() => setIsPreviewing(false)}>
            Exit Preview
          </button>
        </div>
        {children}
      </>
    )
  }

  if (classId && signedInAs) {
    return (
      <>
        <div className="student-session-bar" role="status">
          <span>
            Signed in as <span className="roster-id">{signedInAs}</span>
            {roster && <> · {roster.label}</>}
          </span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setDraft('')
              setError(null)
              onSignOut(classId)
            }}
          >
            Sign Out
          </button>
        </div>
        {children}
      </>
    )
  }

  const submit = () => {
    const studentId = normalizeClassStudentId(draft)
    if (!classId || !studentId || !roster?.studentIds.includes(studentId)) {
      setError('Student ID not found. Please check your ID or contact your teacher.')
      return
    }
    setError(null)
    onSignIn(classId, studentId)
  }

  return (
    <div className="student-login">
      <form
        className="login-card student-login-card"
        aria-labelledby="student-login-heading"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="login-heading">
          <h2 id="student-login-heading">Student Login</h2>
          <p>Enter the Student ID provided by your teacher to access your assignment.</p>
        </div>
        {classId ? (
          <>
            {(roster || lessonTitle) && (
              <p className="student-login-class">
                {lessonTitle && <strong className="student-login-lesson">{lessonTitle}</strong>}
                {roster?.label}
              </p>
            )}
            <div className="field-grid">
              <label>
                <span>Student ID</span>
                <input
                  type="text"
                  placeholder="SB-001"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={draft}
                  aria-invalid={error ? true : undefined}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    setError(null)
                  }}
                />
              </label>
            </div>
            {error && (
              <p className="roster-error" role="alert">
                {error}
              </p>
            )}
            <button type="submit" className="primary-button login-submit" disabled={!draft.trim()}>
              Continue
            </button>
            <div className="teacher-preview-entry">
              <button
                type="button"
                className="secondary-button teacher-preview-button"
                onClick={() => {
                  setDraft('')
                  setError(null)
                  setIsPreviewing(true)
                }}
              >
                <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                Preview as Teacher
              </button>
              <small>For prototype demonstrations</small>
            </div>
          </>
        ) : (
          <p className="roster-warning" role="status">
            This assignment isn’t linked to a class yet. Ask your teacher for your class’s Student Feedback link.
          </p>
        )}
        <p className="login-note">Prototype only — no password or real authentication.</p>
      </form>
    </div>
  )
}

function StudentFeedbackPage({
  lessonId = null,
  lessonTitle = null,
  initialModelTab = 'descriptive',
  assignment = null,
}: {
  // The lesson this page is for (from the link or demo task): it picks the
  // mock content (see studentFeedbackScenarioFor).
  lessonId?: string | null
  lessonTitle?: string | null
  initialModelTab?: ModelTab
  // A lesson's confirmed student products, from its link.
  assignment?: StudentAssignmentLink | null
}) {
  const [scenario] = useState(() =>
    studentFeedbackScenarioFor(
      assignment?.lessonId ?? lessonId,
      assignment?.lessonTitle ?? lessonTitle,
      assignment?.activities.map((activity) => activity.name),
    ),
  )
  const { tabs } = scenario
  const [tabId, setTabId] = useState(() => (tabs.some((tab) => tab.id === initialModelTab) ? initialModelTab : tabs[0].id))
  const tab = tabs.find((item) => item.id === tabId) ?? tabs[0]
  // The model name belongs to the current submission: this assignment (when
  // opened from a link) and this product.
  const submissionKey = `${assignment ? 'assignment' : 'task'}:${tab.id}`
  const [modelNames, setModelNames] = useState<Record<string, string>>({})
  // Each AI message's optional rating, by product and message position.
  const [ratingsByTab, setRatingsByTab] = useState<Record<string, Record<number, FeedbackRating>>>({})
  const tabRatings = ratingsByTab[tab.id] ?? {}

  // Each product's model is independent state — switching tabs must never
  // lose one. Absent means "showing the starter model"; once the student
  // uploads a photo of their own drawing, it holds an object URL for it.
  const [artifactUrls, setArtifactUrls] = useState<Record<string, string>>({})
  const artifactFileInputRef = useRef<HTMLInputElement>(null)

  const handleArtifactUpload = (id: string, file: File | undefined) => {
    if (!file) return
    const url = URL.createObjectURL(file)
    const previousUrl = artifactUrls[id]
    if (previousUrl) URL.revokeObjectURL(previousUrl)
    setArtifactUrls((prev) => ({ ...prev, [id]: url }))
  }

  const [explanation, setExplanation] = useState(scenario.initialExplanation)
  const explanationRef = useRef<HTMLTextAreaElement>(null)
  const [isExplanationListening, setIsExplanationListening] = useState(false)
  const explanationListenTimeoutRef = useRef<number | null>(null)

  // Each product keeps its own conversation — switching tabs must never lose
  // or mix them, so they live keyed by product in one piece of state.
  const [feedbackMessagesByTab, setFeedbackMessagesByTab] = useState<Record<string, ChatMessage[]>>(() =>
    Object.fromEntries(tabs.map((item) => [item.id, item.initialFeedback])),
  )
  const feedbackMessages = feedbackMessagesByTab[tab.id] ?? []
  const [feedbackDraft, setFeedbackDraft] = useState('')
  const [isComposerListening, setIsComposerListening] = useState(false)
  const composerListenTimeoutRef = useRef<number | null>(null)
  const [isAiThinking, setIsAiThinking] = useState(false)
  const aiThinkingTimeoutRef = useRef<number | null>(null)
  const followUpCountRef = useRef<Record<string, number>>({})
  const chatScrollRef = useRef<HTMLDivElement | null>(null)

  const [isRevisionFlash, setIsRevisionFlash] = useState(false)
  const revisionFlashTimeoutRef = useRef<number | null>(null)
  // "Start Iterating" is repeatable and never changes this; "Submit Final
  // Revision" is the one terminal action — once clicked, the button row is
  // replaced with a plain confirmation note.
  const [isFinalSubmitted, setIsFinalSubmitted] = useState(false)

  // Keep the chat pinned to the latest message as the conversation grows.
  useEffect(() => {
    const container = chatScrollRef.current
    if (container) container.scrollTop = container.scrollHeight
  }, [feedbackMessagesByTab, tab.id, isAiThinking])

  useEffect(() => {
    return () => {
      if (explanationListenTimeoutRef.current !== null) window.clearTimeout(explanationListenTimeoutRef.current)
      if (composerListenTimeoutRef.current !== null) window.clearTimeout(composerListenTimeoutRef.current)
      if (aiThinkingTimeoutRef.current !== null) window.clearTimeout(aiThinkingTimeoutRef.current)
      if (revisionFlashTimeoutRef.current !== null) window.clearTimeout(revisionFlashTimeoutRef.current)
    }
  }, [])

  // Both mic controls are mocked the same way (no real speech API): toggling
  // "listening" on, then after a short pause, appending the lesson's canned
  // transcript.
  const toggleExplanationMic = () => {
    if (isExplanationListening) {
      if (explanationListenTimeoutRef.current !== null) window.clearTimeout(explanationListenTimeoutRef.current)
      setIsExplanationListening(false)
      return
    }
    setIsExplanationListening(true)
    explanationListenTimeoutRef.current = window.setTimeout(() => {
      setExplanation((prev) => `${prev.trim() ? `${prev.trim()} ` : ''}${scenario.micExplanation}`)
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
      setFeedbackDraft((prev) => `${prev.trim() ? `${prev.trim()} ` : ''}${scenario.micReply}`)
      setIsComposerListening(false)
    }, 1800)
  }

  const sendFeedbackMessage = () => {
    const text = feedbackDraft.trim()
    if (!text || isAiThinking) return
    const current = tab
    setFeedbackMessagesByTab((prev) => ({ ...prev, [current.id]: [...(prev[current.id] ?? []), { role: 'teacher', text }] }))
    setFeedbackDraft('')
    setIsAiThinking(true)
    const count = followUpCountRef.current[current.id] ?? 0
    followUpCountRef.current = { ...followUpCountRef.current, [current.id]: count + 1 }
    aiThinkingTimeoutRef.current = window.setTimeout(() => {
      setFeedbackMessagesByTab((prev) => ({
        ...prev,
        [current.id]: [
          ...(prev[current.id] ?? []),
          {
            role: 'ai',
            text: callAiModel('student-feedback', { message: text, followUpCount: count, lesson: scenario.id, product: current.id }, (request) =>
              current.reply(request.message, request.followUpCount),
            ),
          },
        ],
      }))
      setIsAiThinking(false)
    }, 700)
  }

  // "Start Iterating" never touches the student's text itself — it brings
  // the editable explanation back into focus, so the student decides what to
  // revise based on the feedback. Repeatable throughout the formative loop.
  const handleStartIterating = () => {
    explanationRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    explanationRef.current?.focus()
    setIsRevisionFlash(true)
    if (revisionFlashTimeoutRef.current !== null) window.clearTimeout(revisionFlashTimeoutRef.current)
    revisionFlashTimeoutRef.current = window.setTimeout(() => setIsRevisionFlash(false), 1200)
  }

  const handleSubmitFinalRevision = () => {
    setIsFinalSubmitted(true)
  }

  const modelImage = artifactUrls[tab.id] ?? tab.starterImage

  return (
    <div className="student-workspace-layout">
      <section className="student-model-panel">
        {assignment ? (
          <div className="student-task-card student-assignment-card">
            <p className="card-label">Your Assignment</p>
            <h3>{assignment.lessonTitle}</h3>
            <p>
              Submit your {joinLabels(assignment.activities.map((activity) => activity.name))} below — both are part of this one assignment.
              Each time you revise, your new work is saved as a new version.
            </p>
            <ul className="student-assignment-list">
              {assignment.activities.map((activity, index) => (
                <li key={`${index}-${activity.name}`} className="student-assignment-item">
                  <strong>{activity.name}</strong>
                  <span>{activity.submission}</span>
                </li>
              ))}
            </ul>
            <p className="student-assignment-note">The workspace below is the prototype’s example task; submissions aren’t saved yet.</p>
          </div>
        ) : (
          <div className="student-task-card">
            <p className="card-label">Your Task</p>
            <h3>{scenario.task.topic}</h3>
            <p>{scenario.task.prompt}</p>
          </div>
        )}

        <div className="planning-tabs" role="tablist" aria-label="Model representation">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab.id === item.id}
              className={`planning-tab ${tab.id === item.id ? 'active' : ''}`}
              onClick={() => setTabId(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="model-representation-area">
          <div className="model-task-prompt">
            <p className="model-task-prompt-label">{tab.promptLabel}</p>
            {typeof tab.prompt === 'string' ? (
              <p>{tab.prompt}</p>
            ) : (
              tab.prompt.map((section) => (
                <div key={section.heading} className="model-task-prompt-section">
                  <p className="model-task-prompt-heading">{section.heading}</p>
                  <p>{section.instruction}</p>
                  <ul>
                    {section.labels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>

          {tab.kind === 'model' && (
            <>
              {modelImage ? (
                <img src={modelImage} alt={artifactUrls[tab.id] ? `Your ${tab.label}` : tab.starterAlt} className="student-model-preview" />
              ) : (
                <p className="empty-state-support student-model-empty">No model added yet — use Add Model to upload a photo of your drawing.</p>
              )}
              <div className="model-representation-actions">
                <input
                  ref={artifactFileInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={(event) => handleArtifactUpload(tab.id, event.target.files?.[0])}
                />
                <button type="button" className="secondary-button" onClick={() => artifactFileInputRef.current?.click()}>
                  Add Model
                </button>
              </div>
            </>
          )}
        </div>

        {tab.kind === 'model' && (
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
            <span>{tab.kind === 'explanation' ? 'Your explanation' : 'Explain your thinking'}</span>
            <span className="empty-state-support">Type your explanation, or use the microphone to speak it.</span>
          </div>
          <div className="student-explanation-input-row">
            <textarea
              ref={explanationRef}
              rows={6}
              value={explanation}
              onChange={(event) => setExplanation(event.target.value)}
              placeholder={scenario.explanationPlaceholder}
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

      {/* `ai-panel-${tab.tint}` carries the subtle per-product tint (see
          .ai-panel-descriptive / .ai-panel-mechanistic in App.css). */}
      <section className={`student-ai-panel ai-panel-${tab.tint}`}>
        <div className="panel-header compact ai-panel-header">
          <h3>AI Feedback</h3>
          <span className="badge ai-panel-badge">{tab.label}</span>
        </div>
        {tab.progressionNote && <p className="ai-panel-progression-note">🔗 {tab.progressionNote}</p>}
        <p className="empty-state-support deeper-analysis-subtitle">{tab.subtitle}</p>

        <div className="deeper-analysis-body">
          <div className="deeper-analysis-chat" ref={chatScrollRef}>
            {/* `ai-panel-chat-${tab.tint}` recolors only the AI bubbles. */}
            <ChatThread
              messages={feedbackMessages}
              className={`ai-panel-chat-${tab.tint}`}
              renderAfterMessage={(message, index) =>
                message.role === 'ai' && (
                  <FeedbackRatingButtons
                    rating={tabRatings[index]}
                    onChange={(next) =>
                      setRatingsByTab((prev) => {
                        const ratings = { ...(prev[tab.id] ?? {}) }
                        if (next) ratings[index] = next
                        else delete ratings[index]
                        return { ...prev, [tab.id]: ratings }
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
  // Absent when the model was submitted without a written explanation.
  explanation?: string
}

// The AI Summary of a model's most recent submission, read against the
// lesson's practice-oriented learning objectives the way Class Feedback
// reads the class: one concise summary per objective (by its 0-based index
// in the lesson plan) of what the work demonstrates, and of what remains
// incomplete or unclear. An objective missing from a section means the
// submission doesn't show enough to say — never that the student
// misunderstands it.
type LatestSubmissionSummary = {
  overlap: Partial<Record<number, string>>
  areasForImprovement: Partial<Record<number, string>>
}

// Suggested Next Steps for one student's most recent submission: one
// instructional move per learning need, tied to an objective (0-based index)
// and to the student work it targets — the Model or the Explanation (the
// report shows those matching the selected work; COVID's products show all).
type StudentNextStep = { objectiveIndex: number; focus: WorkType; title: string; action: string }

type StudentModelWork = {
  // Mock data, written from the latest version and the revision history.
  nextSteps: StudentNextStep[]
  versions: ArtifactVersion[]
  // Changes between Revisions: what changed from the initial submission to
  // each revision, by the revision's versionNumber. Mock data, written from
  // the versions above.
  revisionChanges: Record<number, string[]>
  // Mock data, written from the most recent version above, never beyond it.
  latestSummary: LatestSubmissionSummary
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
        revisionChanges: {
          2: [
            'Now includes what’s below the surface — peat and permafrost are drawn and labeled.',
            'Seasonal panels and the Spring burn scar let the model show the fire returning to the same place.',
          ],
        },
        latestSummary: {
          overlap: {
            0: 'Draws on the seasonal pattern of zombie fires, marking a burn scar where last year’s fire was to show the fire returning to the same place.',
            1: 'Models the system above and below ground — peat, permafrost, snow, and smoke/CO₂ are drawn and labeled across seasonal panels.',
          },
          areasForImprovement: {
            0: 'Shows that the fire comes back but not why; naming what causes it to return would complete the cause-and-effect relationship.',
            1: 'Ice, soil, and peat share one underground band, so it isn’t clear whether they’re separate parts — worth asking. Labeling which parts are matter and which are energy would connect the model to the objective.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Separate matter from energy',
            action:
              'Ask Jordan to give ice, soil, and peat their own labeled layers, then mark each part as matter or energy and use a different arrow style for each.',
          },
          {
            objectiveIndex: 0,
            focus: 'explanation',
            title: 'Explain why the fire returns',
            action:
              'Have Jordan add a sentence naming what keeps the fire alive between seasons, using the Spring burn scar as evidence.',
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
        revisionChanges: {
          2: [
            'Shifted from “the fire goes out in winter” (Version 1) to “it keeps burning underground in the peat” — the core zombie-fire mechanism.',
            'Smoke/CO₂ now rises from the Winter panel too, so carbon release no longer stops when flames aren’t visible.',
          ],
          3: [
            'Shifted from “the fire goes out in winter” (Version 1) to “it keeps burning underground in the peat” — the core zombie-fire mechanism.',
            'Links thawing permafrost to the fire moving underground, a new cause-and-effect relationship (Version 3).',
            'Shows matter (peat → smoke/CO₂) entering the atmosphere in every season, not only when flames are visible.',
          ],
        },
        latestSummary: {
          overlap: {
            0: 'Links thawing permafrost to the fire moving underground — a clear cause-and-effect relationship.',
            1: 'Models the fire burning in the peat beneath the snow all winter and shows matter (peat → smoke/CO₂) entering the atmosphere in every season.',
            2: 'Raises an open question about which parts of the system count as matter (“Ice? Soil? Peat?”).',
          },
          areasForImprovement: {
            0: 'Doesn’t yet account for what supplies oxygen to the underground fire — it may simply not have been considered yet.',
            1: 'Labels the fire itself as energy; showing fire as the process that releases energy from the peat would sharpen the matter–energy distinction.',
            2: 'The question about ice, soil, and peat is left unanswered; connecting it to how much carbon is released or the role of humans would extend it.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Show fire as a process',
            action:
              'Ask Jordan to relabel the fire as the process releasing energy from the peat, with separate arrows for energy (heat) and matter (peat → CO₂).',
          },
          {
            objectiveIndex: 0,
            focus: 'explanation',
            title: 'Account for oxygen underground',
            action:
              'Ask Jordan how the underground fire gets the oxygen it needs, and have them add that cause to the explanation.',
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
        revisionChanges: {
          2: [
            'Adds peat and frozen ground (permafrost) below the surface, making the underground system visible.',
            'Labels smoke as containing CO₂ — a first sign of noticing what matter leaves the system.',
          ],
        },
        latestSummary: {
          overlap: {
            1: 'Adds peat and frozen ground beneath the fire and labels the smoke as containing CO₂, showing some matter leaving the system.',
          },
          areasForImprovement: {
            0: 'Doesn’t yet say what causes the fire or why it keeps burning.',
            1: 'The snow is still drawn off to the side rather than on top of the peat, so how snow, peat, and fire relate isn’t shown yet.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Place the snow on the peat',
            action:
              'Ask Carlos to move the snow layer on top of the peat and add arrows showing how the fire, peat, and snow connect in winter.',
          },
          {
            objectiveIndex: 0,
            focus: 'explanation',
            title: 'Name the cause',
            action:
              'Have Carlos finish the sentence “The fire keeps burning because…” using a part of his model as evidence.',
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
        revisionChanges: {
          2: [
            'The drawing now connects the two fires underground — something persists between seasons.',
            'The explanation hasn’t changed in the same way: the fire still “goes out” and restarts, so the drawing may overstate the change in reasoning.',
          ],
        },
        latestSummary: {
          overlap: {
            1: 'Connects the summer and spring fires with a line underground, showing that something persists between seasons.',
          },
          areasForImprovement: {
            0: 'Explains the spring fire as restarting from leftover heat after the fire goes out, rather than the same fire continuing underground.',
            1: 'The CO₂ in the smoke isn’t traced back to the peat being burned, and the “heat underground” label could use clarifying — it may be shorthand.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 0,
            focus: 'explanation',
            title: 'Reconcile drawing and explanation',
            action:
              'His Version 2 drawing connects the fires but the explanation says the fire goes out — ask Carlos which he now thinks is right, and why.',
          },
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Trace CO₂ to the peat',
            action:
              'Ask Carlos to draw an arrow from the peat to the CO₂ in the smoke and replace “heat underground” with what is actually burning.',
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
        revisionChanges: {
          2: [
            'Draws peat and fire as separate components, with the fire located inside the peat.',
            'Introduces “smoldering” to distinguish the underground fire from flames above ground.',
          ],
        },
        latestSummary: {
          overlap: {
            1: 'Draws peat as its own layer with the smoldering fire inside it, distinguishing the underground fire from flames above ground.',
          },
          areasForImprovement: {},
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Add matter and energy arrows',
            action:
              'Priya’s layers are clear; ask her to add arrows showing where matter (carbon) and energy (heat) move from the smoldering peat.',
          },
          {
            objectiveIndex: 0,
            focus: 'explanation',
            title: 'Connect smoldering to winter',
            action:
              'Ask Priya to explain why smoldering, rather than open flames, lets the fire survive under the snow, citing her model.',
          },
        ],
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
        revisionChanges: {
          2: [
            'Draws peat as its own layer with the smoldering fire inside it, instead of a single “fire part.”',
            'Adds CO₂ to the smoke rising through the snow.',
          ],
          3: [
            'Now describes peat as fuel that is used up as it burns, rather than treating peat and fire as one thing.',
            'The “less peat” label in Spring suggests the student is beginning to track matter leaving the biosphere over time.',
          ],
        },
        latestSummary: {
          overlap: {
            0: 'Identifies a cause-and-effect change in the biosphere: burning all winter leaves less peat by spring.',
            1: 'Models peat as the fire’s fuel, used up as it burns, with smoke and CO₂ rising into the atmosphere.',
          },
          areasForImprovement: {
            1: 'Describes CO₂ as coming “from the fire” rather than from the peat — possibly shorthand, since the peat is already described as used up; worth checking.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Start the CO₂ arrow at the peat',
            action:
              'Her “less peat” label already shows peat being used up — ask Priya to redraw the CO₂ arrow so it starts at the peat, not the fire.',
          },
          {
            objectiveIndex: 2,
            focus: 'explanation',
            title: 'Pose a follow-up question',
            action:
              'Invite Priya to write one question about where the lost peat’s carbon ends up, and how she could find out.',
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
        revisionChanges: {},
        latestSummary: {
          overlap: {
            0: 'States the key fact about zombie fires: they burn underground through winter and return in spring.',
          },
          areasForImprovement: {
            1: 'The model shows only snow, fire, and smoke, with the fire above ground — adding peat and permafrost and placing the fire underground would match the explanation.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Move the fire underground',
            action:
              'Ask Emma to add peat and permafrost layers and redraw the fire inside the peat, so the model matches her written explanation.',
          },
          {
            objectiveIndex: 0,
            focus: 'explanation',
            title: 'Explain using the model',
            action:
              'Have Emma point to each part of her revised model while explaining how the fire survives the winter.',
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
        revisionChanges: {
          2: [
            'Now states the fire continues underground in winter, which Version 1 didn’t.',
            'The drawing changed only slightly and the “dries out” cause remains — the new sentence may be adopted wording rather than changed reasoning. Worth asking for an explanation in the student’s own words.',
          ],
        },
        latestSummary: {
          overlap: {
            1: 'States that the fire keeps burning underground through winter, with a fire icon added under the snow.',
          },
          areasForImprovement: {
            0: 'Still attributes the spring fire to things drying out rather than to the fire that persisted underground.',
            1: 'Doesn’t yet show what burns or where the smoke’s matter comes from. The drawing changed only slightly, so it’s worth asking for the explanation in the student’s own words.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 0,
            focus: 'explanation',
            title: 'Explain in her own words',
            action:
              'The drawing barely changed between versions — ask Emma to explain aloud how the winter fire leads to the spring fire without using “dries out.”',
          },
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Show what burns',
            action:
              'Ask Emma to label the peat as fuel and add an arrow from it to the smoke, showing where the smoke’s matter comes from.',
          },
        ],
      },
    },
  },
]

// COVID Virus: one detailed report, built from the existing COVID example
// artifacts — the Descriptive and Mechanistic models Student Feedback
// starts from, and the explanation written with the Mechanistic one. Each
// model has only that one version; no revisions are invented.
const covidStudentReports: IndividualStudentReport[] = [
  {
    studentName: 'Bianca S.',
    models: {
      descriptive: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Nov 4, 9:40 AM',
            modelImage: COVID_DESCRIPTIVE_MODEL_EXAMPLE_IMAGE,
            modelDescription:
              'Labeled diagrams: (a) the coronavirus with protein spikes, a fatty envelope, and genetic material inside; (b) two soap molecules, each with a hydrophilic head (“likes water”) and a hydrophobic tail (“likes fat/oil”).',
          },
        ],
        revisionChanges: {},
        latestSummary: {
          overlap: {
            0: 'Labels all three virus structures and both parts of the soap molecule, noting what each end of the soap is attracted to.',
          },
          areasForImprovement: {
            1: 'The virus and soap are drawn separately, so the model doesn’t yet show how their structures relate.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Relate the two structures',
            action:
              'Ask Bianca to redraw a soap molecule beside the virus, showing which part of the soap meets the fatty envelope.',
          },
        ],
      },
      mechanistic: {
        versions: [
          {
            versionNumber: 1,
            submittedAt: 'Nov 6, 10:05 AM',
            modelImage: COVID_MECHANISTIC_MODEL_EXAMPLE_IMAGE,
            modelDescription:
              'A beaker of water with soap molecules clustered around three oil droplets, heads facing the water, labeled “Soap traps the oil.”',
            explanation: initialStudentExplanation,
          },
        ],
        revisionChanges: {},
        latestSummary: {
          overlap: {
            0: 'Shows many soap molecules around each oil droplet, with their hydrophilic heads facing the water.',
            1: 'Explains that the soap’s hydrophobic tail pushes into the virus’s fatty envelope, which may help break it apart.',
          },
          areasForImprovement: {
            1: 'Doesn’t yet show how water and the hydrophilic heads carry the trapped oil or virus away — the explanation names this as the next thing to add. The drawing shows oil while the explanation describes the virus, so connecting the two would help.',
          },
        },
        nextSteps: [
          {
            objectiveIndex: 1,
            focus: 'model',
            title: 'Show the rinse step',
            action:
              'Have Bianca add water moving past a soap cluster, with an arrow showing the trapped virus being carried away.',
          },
          {
            objectiveIndex: 1,
            focus: 'explanation',
            title: 'Match the drawing to the explanation',
            action:
              'Ask Bianca to replace one oil droplet with the virus so her drawing shows what her explanation describes.',
          },
        ],
      },
    },
  },
]

// Each analyzed lesson's detailed reports.
const individualStudentReportsByLesson: Record<string, IndividualStudentReport[]> = {
  'zombie-fires': individualStudentReports,
  'covid-virus': covidStudentReports,
}

function individualStudentReportsFor(lessonId: string): Record<string, IndividualStudentReport> {
  return Object.fromEntries((individualStudentReportsByLesson[lessonId] ?? []).map((report) => [report.studentName, report]))
}

// Everyone who appears anywhere in the Zombie Fires Class Summary evidence
// — the prototype's stand-in for the demo class roster (Period 4). A real
// backend would scope this to the signed-in teacher's class via
// students.feedback_page_id.
const assignmentStudentRoster: string[] = Array.from(
  new Set(zombieFiresPatternIds.flatMap((id) => allPatternRows[id].students.map((student) => student.name))),
).sort((a, b) => a.localeCompare(b))

// A searchable dropdown (ARIA combobox) over the assignment roster. Typing
// filters by name; arrow keys + Enter pick a student; Escape closes.
function StudentSearchSelect({
  students,
  selectedStudent,
  onSelect,
  reports,
  modelTabs,
}: {
  students: readonly string[]
  selectedStudent: string | null
  onSelect: (name: string) => void
  // The lesson's detailed reports by student name, and the model types the
  // assignment covers (for the revision counts in the list).
  reports: Record<string, IndividualStudentReport>
  modelTabs: readonly ModelTab[]
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
              const report = reports[name]
              const revisionCount = report ? modelTabs.reduce((total, tab) => total + report.models[tab].versions.length - 1, 0) : 0
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
                      ? `${revisionCount} ${revisionCount === 1 ? 'revision' : 'revisions'}${modelTabs.length > 1 ? ' across both models' : ''}`
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

// How a revision is named in the comparison: the most recent one says so.
function revisionLabel(version: ArtifactVersion, latest: ArtifactVersion): string {
  return version.versionNumber === latest.versionNumber ? `Most Recent Revision (Version ${version.versionNumber})` : `Revision ${version.versionNumber}`
}

// One submitted version: the model drawing, the explanation it was
// submitted with, and when. `versionOptions` adds a revision picker to the
// header when there's more than one revision to choose between.
function ArtifactVersionCard({
  studentName,
  modelTab,
  workType,
  heading,
  versionLabel,
  version,
  versionOptions,
  optionLabel,
  onVersionChange,
  onExpandImage,
}: {
  studentName: string
  modelTab: ModelTab
  workType: WorkView
  heading: string
  versionLabel: string
  version: ArtifactVersion
  versionOptions?: readonly ArtifactVersion[]
  optionLabel?: (version: ArtifactVersion) => string
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
                  {optionLabel ? optionLabel(option) : `Version ${option.versionNumber}`}
                </option>
              ))}
            </select>
          ) : (
            <h4>{versionLabel}</h4>
          )}
        </div>
        <p className="artifact-version-meta">{version.submittedAt}</p>
      </header>

      {workType === 'explanation' ? null : version.modelImage ? (
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

      {workType !== 'model' && (
        <div className="artifact-explanation">
          <p className="card-label">Written explanation</p>
          {version.explanation ? (
            <p className="student-quote">&ldquo;{version.explanation}&rdquo;</p>
          ) : (
            <p className="empty-state-support">No written explanation was submitted in this version.</p>
          )}
        </div>
      )}
    </article>
  )
}

// A lesson learning objective as the AI Summary shows it: "Objective 1.A",
// the practices it asks for, and its full text (a tooltip only).
type ReportObjective = { label: string; practices: string[]; title: string }

// The lesson's own objectives and practices, in lesson order.
function reportObjectivesFor(lesson: LibraryLesson): ReportObjective[] {
  const context = lessonContextFor(lesson)
  return context.objectives.map((objective, index) => ({
    label: objectiveLabelFor(context.objectives, index),
    practices: practicesForObjective(objective, context.practices),
    title: objective,
  }))
}

// Everything under one model-type tab: the initial submission (fixed, left)
// beside one revision (right — the most recent by default, or any earlier
// revision from the picker), then the AI Summary of the most recent
// submission.
// Keyed by student + tab by its parent, so switching either resets to the
// most recent revision.
function StudentModelWorkView({
  studentName,
  modelTab,
  workType,
  work,
  objectives,
}: {
  studentName: string
  modelTab: ModelTab
  // Which product of each version the cards show: the model, the
  // explanation, or (a product with its own data) the whole submission.
  workType: WorkView
  work: StudentModelWork
  // The lesson's learning objectives, in order.
  objectives: readonly ReportObjective[]
}) {
  const { versions } = work
  const initialVersion = versions[0]
  const latestVersion = versions[versions.length - 1]
  const revisions = versions.slice(1)

  const [revisedVersionNumber, setRevisedVersionNumber] = useState(latestVersion.versionNumber)
  const [expandedImage, setExpandedImage] = useState<{ src: string; alt: string } | null>(null)
  const revisedVersion = revisions.find((version) => version.versionNumber === revisedVersionNumber) ?? latestVersion

  // The AI Summary is always about the most recent submission — picking an
  // earlier revision changes the artifacts above, not the summary.
  const isLatest = revisedVersion.versionNumber === latestVersion.versionNumber
  const summary = work.latestSummary
  // What changed up to the selected revision — follows the dropdown.
  const revisionChanges = work.revisionChanges[revisedVersion.versionNumber] ?? []
  // Next steps for the selected work (all of them for a product with its
  // own data), at most two.
  const nextSteps = work.nextSteps.filter((step) => workType === 'both' || step.focus === workType).slice(0, 2)

  const cardProps = {
    studentName,
    modelTab,
    workType,
    onExpandImage: (src: string, alt: string) => setExpandedImage({ src, alt }),
  }

  return (
    <div className="student-model-work">
      <div className="artifact-compare-grid" aria-label="Student artifacts">
        <ArtifactVersionCard {...cardProps} heading="Initial Submission" versionLabel={`Version ${initialVersion.versionNumber}`} version={initialVersion} />
        {revisions.length > 0 ? (
          <ArtifactVersionCard
            {...cardProps}
            heading={isLatest ? 'Most Recent Revised Submission' : 'Revised Submission'}
            versionLabel={revisionLabel(revisedVersion, latestVersion)}
            version={revisedVersion}
            versionOptions={revisions}
            optionLabel={(version) => revisionLabel(version, latestVersion)}
            onVersionChange={setRevisedVersionNumber}
          />
        ) : (
          <div className="artifact-version-card artifact-version-empty">
            <p className="card-label">Revised Submission</p>
            <p className="empty-state-support">
              Only one version has been submitted — {studentName} hasn’t revised this model yet, so there’s nothing to compare.
            </p>
          </div>
        )}
      </div>

      {/* Changes between Revisions: full width under both artifact cards,
          for whichever revision is selected on the right. */}
      <section className="revision-changes" aria-label="Changes between Revisions">
        <div className="student-report-subheader">
          <h4>Changes between Revisions</h4>
          <span className="badge">Mock AI analysis</span>
        </div>
        {revisions.length === 0 ? (
          <p className="empty-state-support">Only one version has been submitted, so there are no changes to compare yet.</p>
        ) : (
          <>
            <p className="student-analysis-comparison">
              Initial Submission (Version {initialVersion.versionNumber}) → {revisionLabel(revisedVersion, latestVersion)}
            </p>
            {revisionChanges.length > 0 ? (
              <ul className="revision-change-list">
                {revisionChanges.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            ) : (
              <p className="empty-state-support">No analysis of changes is available for this revision yet.</p>
            )}
          </>
        )}
      </section>

      {/* The AI Summary of the most recent submission, in Class Feedback's
          structure (blue Overlap, yellow Areas for Improvement), with one
          concise summary per learning objective of the lesson, in order. */}
      <section className="student-ai-analysis" aria-label="AI Summary">
        <div className="student-report-subheader">
          <h4>AI Summary</h4>
          <span className="badge">Mock AI analysis</span>
        </div>
        <p className="student-analysis-comparison">Analysis of Most Recent Submission (Version {latestVersion.versionNumber})</p>
        {objectives.length === 0 ? (
          <p className="empty-state-support">This lesson has no learning objectives to analyze the submission against.</p>
        ) : (
          <div className="student-summary-sections">
            {(
              [
                { key: 'overlap', title: 'Overlap with Practice-Oriented Learning Objectives', className: 'summary-section-objective', texts: summary.overlap },
                { key: 'improvement', title: 'Areas for Improvement', className: 'summary-section-misconception', texts: summary.areasForImprovement },
              ] as const
            ).map((section) => (
              <div key={section.key} className={`summary-section ${section.className}`}>
                <p className="summary-section-title">{section.title}</p>
                {objectives.map((objective, index) => {
                  const text = section.texts[index]
                  // Nothing to say: either the work shows no gap, or it
                  // doesn't show enough to assess the objective at all.
                  const fallback =
                    section.key === 'improvement' && summary.overlap[index]
                      ? 'No remaining gaps identified for this objective in this submission.'
                      : 'This submission doesn’t show enough evidence to assess this objective yet.'
                  return (
                    <div key={index} className="pattern-group student-objective-summary">
                      <p className="pattern-group-title" title={objective.title}>
                        {objective.label}
                        {objective.practices.length > 0 && <span className="student-objective-practices"> — {objective.practices.join(' · ')}</span>}
                      </p>
                      <p className={`finding-summary${text ? '' : ' student-objective-empty'}`}>{text ?? fallback}</p>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Suggested Next Steps for this student, in Class Feedback's style:
          at most two, for the selected work (Model or Explanation). */}
      <section className="next-steps-panel student-next-steps" aria-labelledby="student-next-steps-heading">
        <div className="student-report-subheader">
          <h4 id="student-next-steps-heading">Suggested Next Steps</h4>
          <span className="badge">Mock AI analysis</span>
        </div>
        {nextSteps.length === 0 ? (
          <p className="empty-state-support">No next steps for this submission yet.</p>
        ) : (
          <ol className="next-step-list">
            {nextSteps.map((step) => {
              const objective = objectives[step.objectiveIndex]
              return (
                <li key={step.title} className="next-step-item">
                  <p className="next-step-objective" title={objective?.title}>
                    {objective?.label ?? `Objective ${step.objectiveIndex + 1}`}
                    {objective && objective.practices.length > 0 && (
                      <span className="next-step-practices"> · {objective.practices.join(' · ')}</span>
                    )}
                  </p>
                  <p className="next-step-title">{step.title}</p>
                  <p className="next-step-action">{step.action}</p>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      {expandedImage && (
        <ArtifactImageLightbox src={expandedImage.src} alt={expandedImage.alt} onClose={() => setExpandedImage(null)} />
      )}
    </div>
  )
}

function IndividualStudentReportView({
  report,
  studentId,
  modelTab,
  onModelTabChange,
  workType,
  objectives,
  modelTabs,
}: {
  report: IndividualStudentReport
  // The student's class Student ID.
  studentId: string
  modelTab: ModelTab
  onModelTabChange: (tab: ModelTab) => void
  workType: WorkView
  objectives: readonly ReportObjective[]
  // The model types the assignment covers: tabs only when there are two.
  modelTabs: readonly ModelTab[]
}) {
  return (
    <div className="student-report">
      <div className="student-report-heading">
        <h4>{report.studentName}</h4>
        <span className="roster-id">{studentId}</span>
        <span className="tag mock-data-tag">Prototype mock data</span>
      </div>

      {modelTabs.length > 1 && (
      <div className="planning-tabs" role="tablist" aria-label="Model type">
        {modelTabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={modelTab === tab}
            className={`planning-tab ${modelTab === tab ? 'active' : ''}`}
            onClick={() => onModelTabChange(tab)}
          >
            {modelTabLabels[tab]}
          </button>
        ))}
      </div>
      )}

      <StudentModelWorkView
        key={`${report.studentName}-${modelTab}`}
        studentName={report.studentName}
        modelTab={modelTab}
        workType={workType}
        work={report.models[modelTab]}
        objectives={objectives}
      />
    </div>
  )
}

// Individual Student Reports, its own view: one lesson's submissions in one
// class (from the route). Opened from a Library lesson card it starts at the
// student selector; from Student Evidence the student is already selected.
// Only the class whose submissions were analyzed has reports — any other
// lesson or class gets an empty state, never someone else's data.
function StudentReportsPage({
  route,
  lesson,
  classroom,
  students,
  classes,
  lessons,
  onRouteChange,
  backLabel,
  onBack,
}: {
  route: StudentReportsRoute | null
  lesson: LibraryLesson | null
  classroom: LibraryClass | null
  students: readonly Student[]
  // The teacher's classes and lessons, for choosing the class and lesson.
  classes: readonly LibraryClass[]
  lessons: readonly LibraryLesson[]
  // null clears the selection (another class was chosen).
  onRouteChange: (route: StudentReportsRoute | null) => void
  backLabel: string
  // null when opened from the navigation drawer: there's no page to go back to.
  onBack: (() => void) | null
}) {
  // The class and lesson: from the route (opened from the Library or Class
  // Feedback), or chosen here (opened from the navigation drawer). A class
  // can be chosen before its lesson.
  const [pickedClassId, setPickedClassId] = useState<string | null>(null)
  const classId = route?.classId ?? pickedClassId
  const pickedClass = classes.find((item) => item.id === classId) ?? null
  const classLessons = pickedClass
    ? lessons.filter((item) => pickedClass.lessonIds.includes(item.id) && !item.demoUnavailable)
    : []
  const chooseClass = (id: string) => {
    setPickedClassId(id || null)
    onRouteChange(null)
  }
  const chooseLesson = (id: string) => {
    if (!pickedClass || !id) return
    const first = classFeedbackAssignmentsFor(id)[0]
    onRouteChange({
      lessonId: id,
      classId: pickedClass.id,
      assignmentId: first?.id ?? null,
      studentId: null,
      modelTab: first?.modelTabs[0] ?? 'descriptive',
      work: 'model',
    })
  }
  const contextPicker = (
    <div className="student-reports-controls student-reports-context">
      <label className="work-view-select">
        <span>Class</span>
        <select value={classId ?? ''} onChange={(event) => chooseClass(event.target.value)}>
          <option value="">Select a class</option>
          {classes.map((item) => (
            <option key={item.id} value={item.id}>
              {classDisplayName(item)}
            </option>
          ))}
        </select>
      </label>
      <label className="work-view-select">
        <span>Lesson</span>
        <select value={route?.lessonId ?? ''} disabled={!pickedClass} onChange={(event) => chooseLesson(event.target.value)}>
          <option value="">{pickedClass ? 'Select a lesson' : 'Select a class first'}</option>
          {classLessons.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  )

  // The class roster with each student's class Student ID.
  const roster = classroom
    ? classroom.studentIds.flatMap((key) => {
        const name = students.find((student) => student.id === key)?.name
        const studentId = classroom.studentCodes[key]
        return name && studentId ? [{ name, studentId }] : []
      })
    : []
  // The lesson's assignments (the route's, else its first) and the model
  // types the assignment covers — a single-model assignment always shows
  // that model.
  const assignments = lesson ? classFeedbackAssignmentsFor(lesson.id) : []
  const assignment = assignments.find((item) => item.id === route?.assignmentId) ?? assignments[0] ?? null
  const modelTabs: ModelTab[] = assignment?.modelTabs ?? ['descriptive', 'mechanistic']
  const modelTab = route && modelTabs.includes(route.modelTab) ? route.modelTab : modelTabs[0]
  // The assignment as the teacher chooses it, and its student-product switch.
  const choices = assignmentChoices(assignments)
  const choice = assignment ? choices.find((item) => assignmentLabel(item) === assignmentLabel(assignment)) : undefined
  const productSwitch = assignment ? productSwitchFor(assignment, route?.work ?? 'model') : null
  // A product with its own data shows its whole submission; otherwise the
  // selected Model or Explanation.
  const workView: WorkView = assignment?.productId ? 'both' : (route?.work ?? 'model')
  const hasSubmissions = Boolean(lesson && classroom && assignment && analyzedSubmissionClassIds[lesson.id] === classroom.id)
  const reports = lesson ? individualStudentReportsFor(lesson.id) : {}
  const selected = route?.studentId ? roster.find((student) => student.studentId === route.studentId) : undefined
  const report = selected ? reports[selected.name] : undefined

  let body: ReactNode
  if (!route || !lesson) {
    body = (
      <p className="empty-state-support">
        {pickedClass ? 'Select a lesson to see its student reports.' : 'Select a class and lesson to see Individual Student Reports.'}
      </p>
    )
  } else if (!classroom) {
    body = (
      <p className="empty-state-support">
        This lesson isn’t associated with a class, so there are no student submissions to report on. Open the reports from the lesson under its class in
        the Library.
      </p>
    )
  } else if (!hasSubmissions) {
    body = (
      <p className="empty-state-support student-reports-empty">
        No student submissions have been analyzed for this lesson in {classDisplayName(classroom)} yet. Individual reports appear once students in this
        class submit their work.
      </p>
    )
  } else {
    body = (
      <>
        <div className="student-reports-controls">
          <StudentSearchSelect
            key={`search-${selected?.studentId ?? 'none'}`}
            students={roster.map((student) => student.name)}
            selectedStudent={selected?.name ?? null}
            onSelect={(name) => {
              const student = roster.find((item) => item.name === name)
              if (student) onRouteChange({ ...route, studentId: student.studentId })
            }}
            reports={reports}
            modelTabs={modelTabs}
          />
          {/* The lesson's assignments, as on Class Feedback (opened from
              there, it arrives already set). */}
          {assignment && choice && (
            <label className="work-view-select">
              <span>Assignment</span>
              <select
                value={choice.id}
                disabled={choices.length < 2}
                title={choices.length < 2 ? 'This lesson has one assignment.' : undefined}
                onChange={(event) => {
                  const next = choices.find((item) => item.id === event.target.value)
                  if (next) onRouteChange({ ...route, assignmentId: next.id, modelTab: next.modelTabs[0] })
                }}
              >
                {choices.map((option) => (
                  <option key={option.id} value={option.id}>
                    {assignmentLabel(option)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {assignment && productSwitch && (
            <WorkTypeSwitch
              options={productSwitch.options}
              value={productSwitch.value}
              onChange={(productId) => {
                const next = chooseProduct(assignment, productId)
                onRouteChange({
                  ...route,
                  assignmentId: next.assignment.id,
                  modelTab: next.assignment.id === assignment.id ? modelTab : next.assignment.modelTabs[0],
                  work: next.workType ?? route.work,
                })
              }}
            />
          )}
        </div>
        {!selected && <p className="empty-state-support">Select a student to see their report.</p>}
        {selected && !report && (
          <p className="empty-state-support student-report-unavailable">
            {selected.name} ({selected.studentId}) is in this class, but their work hasn’t been analyzed individually in this prototype’s mock data yet.
          </p>
        )}
        {selected && report && (
          <IndividualStudentReportView
            key={`report-${selected.studentId}`}
            report={report}
            studentId={selected.studentId}
            modelTab={modelTab}
            onModelTabChange={(tab) => onRouteChange({ ...route, modelTab: tab })}
            workType={workView}
            objectives={reportObjectivesFor(lesson)}
            modelTabs={modelTabs}
          />
        )}
      </>
    )
  }

  return (
    <section className="report-panel student-reports-panel" aria-labelledby="student-reports-title">
      <div className="panel-header compact student-reports-header">
        <div>
          <h3 id="student-reports-title">Individual Student Reports</h3>
          <p className="empty-state-support student-reports-subtitle">
            {lesson ? lesson.title : 'No lesson selected'}
            {classroom && ` · ${classDisplayName(classroom)}`}
          </p>
        </div>
        {onBack && (
          <button type="button" className="secondary-button" onClick={onBack}>
            ← Back to {backLabel}
          </button>
        )}
      </div>
      <div className="student-reports-body">
        {contextPicker}
        {body}
      </div>
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

// "Objective 1.A" — an objective's prefix from the lesson plan, or its
// position when it has none. Used by Class Feedback and Individual Student
// Reports, so both name objectives the same way.
function objectiveLabelFor(objectives: readonly string[], index: number): string {
  const prefix = objectives[index]?.split(' ')[0] ?? ''
  return `Objective ${/^\d+(\.[A-Za-z0-9]+)?:?$/.test(prefix) ? prefix.replace(/:$/, '') : index + 1}`
}

// The class whose submissions each analyzed lesson's data came from: Class
// Summary evidence and Individual Student Reports are that class's work, so
// another class with the same lesson has no reports yet.
const analyzedSubmissionClassIds: Record<string, string> = {
  'zombie-fires': demoStudentFeedbackClassId,
  'covid-virus': 'period-1-life-science',
}

// Submitted work Class Feedback analyzes, with its own prompt, statistics,
// and analyzed patterns. `modelTabs` are the model types its Individual
// Student Reports show. Usually one entry is one assignment (Zombie Fires,
// whose Model and Explanation are views of the same work); when a lesson's
// mock data is split by student product, each entry is one product
// (`productId`, see studentProductsFor) of the same assignment
// (`assignmentTitle`) — COVID Virus's Descriptive and Mechanistic.
type ClassFeedbackAssignment = {
  id: string
  lessonId: string
  title: string
  task: { topic: string; question: string }
  metrics: { label: string; value: string; trend: string }[]
  patternIds: string[]
  modelTabs: ModelTab[]
  productId?: string
  assignmentTitle?: string
}

// Prototype mock data for the lessons with analyzed submissions.
const classFeedbackAssignments: ClassFeedbackAssignment[] = [
  {
    id: 'zombie-fires',
    lessonId: 'zombie-fires',
    title: 'Zombie Fires: Matter and Energy Flow',
    task: dashboardTask,
    metrics: metricCards,
    patternIds: zombieFiresPatternIds,
    modelTabs: ['descriptive', 'mechanistic'],
  },
  {
    id: 'covid-descriptive',
    lessonId: 'covid-virus',
    title: 'Descriptive Model',
    productId: 'descriptive',
    assignmentTitle: 'COVID Virus: Structure and Function of Soap',
    task: {
      topic: 'COVID Virus: Descriptive Model',
      question: `Prompt: ${descriptiveModelPrompt.map((part) => `${part.heading} — ${part.instruction} ${part.labels.join(', ')}.`).join(' ')}`,
    },
    metrics: [
      { label: 'Submissions', value: '24', trend: '+3' },
      { label: 'Average Time on Task', value: '16 min', trend: '+2 min' },
      { label: 'Resubmissions', value: '6', trend: '+1' },
      { label: 'AI Feedback Requests', value: '15', trend: '+4' },
    ],
    patternIds: covidDescriptivePatterns.map((row) => row.id),
    modelTabs: ['descriptive'],
  },
  {
    id: 'covid-mechanistic',
    lessonId: 'covid-virus',
    title: 'Mechanistic Model',
    productId: 'mechanistic',
    assignmentTitle: 'COVID Virus: Structure and Function of Soap',
    task: { topic: 'COVID Virus: Mechanistic Model', question: `Prompt: ${mechanisticModelPrompt}` },
    metrics: [
      { label: 'Submissions', value: '22', trend: '+2' },
      { label: 'Average Time on Task', value: '23 min', trend: '+4 min' },
      { label: 'Resubmissions', value: '9', trend: '+3' },
      { label: 'AI Feedback Requests', value: '19', trend: '+6' },
    ],
    patternIds: covidMechanisticPatterns.map((row) => row.id),
    modelTabs: ['mechanistic'],
  },
]

function classFeedbackAssignmentsFor(lessonId: string): ClassFeedbackAssignment[] {
  return classFeedbackAssignments.filter((assignment) => assignment.lessonId === lessonId)
}

// The assignment an entry belongs to, as the teacher sees it.
const assignmentLabel = (assignment: ClassFeedbackAssignment) => assignment.assignmentTitle ?? assignment.title

// The assignments to choose between: entries that are products of the same
// assignment count once.
function assignmentChoices(assignments: readonly ClassFeedbackAssignment[]): ClassFeedbackAssignment[] {
  return assignments.filter((assignment, index) => assignments.findIndex((other) => assignmentLabel(other) === assignmentLabel(assignment)) === index)
}

// The student-work switch for an entry: its lesson's products. Selecting a
// product either picks that product's entry (data split by product) or, for
// one entry covering both, changes only which work is shown (`workType`).
type ProductSwitch = { options: { id: string; label: string }[]; value: string; byEntry: boolean }

function productSwitchFor(assignment: ClassFeedbackAssignment, workType: WorkType): ProductSwitch {
  const products = studentProductsFor(assignment.lessonId)
  return {
    options: products.map((product) => ({ id: product.id, label: product.name })),
    value: assignment.productId ?? workType,
    byEntry: Boolean(assignment.productId),
  }
}

type ClassSummaryFinding = {
  objectiveIndex: number
  practices: string[]
  summary: string
  nextStep?: string
  patternIds: string[]
}

type ClassSummaryOutput = { overlap: ClassSummaryFinding[]; areasForImprovement: ClassSummaryFinding[] }

const classSummaryInstructions = [
  'You analyze one class’s submitted science work (models and written explanations) for the assignment in "assignment", part of the lesson in "lesson".',
  'A practice-oriented learning objective is one of lesson.learningObjectives read together with the science practices it asks students to use (from lesson.sciencePractices). Judge the work by what students do with those practices — modeling, explaining, questioning, reasoning from evidence — not only by the content they mention.',
  'Use only the class-level patterns in "patterns"; never invent student work. Refer to students by count, never by name.',
  'overlap: for each objective, the patterns showing students demonstrating its targeted practices, strongest first, and a one-sentence summary of what that work shows students doing.',
  'areasForImprovement: for each objective, the patterns showing gaps — missing or incomplete practice moves, difficulties, or misconceptions — a one-sentence summary of the gap, and nextStep: one concrete instructional move the teacher can make. nextStep is shown apart from the summary under Suggested Next Steps, so it must make sense on its own and must not restate the summary.',
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

// An assignment's analyzed patterns, without student evidence.
function classSummaryPatternsFor(assignment: ClassFeedbackAssignment): ClassSummaryPatternInput[] {
  return assignment.patternIds.map((id) => ({
    id,
    label: allPatternRows[id].label,
    studentCount: allPatternRows[id].count,
    source: `Submissions for “${assignment.title}”`,
  }))
}

// Stands in for the analysis model: its reading of each demo pattern in
// each assignment — which objective it speaks to and whether it shows the
// targeted practice or a gap — plus the summaries it would write.
type MockSummaryJudgment = { objective: number; finding: 'overlap' | 'improvement' }

const mockClassSummaryJudgments: Record<string, Record<string, MockSummaryJudgment>> = {
  'zombie-fires': {
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
  },
  'covid-descriptive': {
    'covid-d-virus-structures-labeled': { objective: 0, finding: 'overlap' },
    'covid-d-soap-two-ends': { objective: 0, finding: 'overlap' },
    'covid-d-envelope-unlabeled': { objective: 0, finding: 'improvement' },
    'covid-d-ends-swapped': { objective: 0, finding: 'improvement' },
    'covid-d-fat-attraction': { objective: 1, finding: 'overlap' },
    'covid-d-no-relationship': { objective: 1, finding: 'improvement' },
  },
  'covid-mechanistic': {
    'covid-m-parts-labeled': { objective: 0, finding: 'overlap' },
    'covid-m-single-molecule': { objective: 0, finding: 'improvement' },
    'covid-m-soap-surrounds-oil': { objective: 1, finding: 'overlap' },
    'covid-m-tail-into-envelope': { objective: 1, finding: 'overlap' },
    'covid-m-no-water-role': { objective: 1, finding: 'improvement' },
    'covid-m-soap-kills': { objective: 1, finding: 'improvement' },
  },
}

const mockClassSummaryText: Record<string, Record<number, { overlap: string; improvement: string; nextStep: string }>> = {
  'zombie-fires': {
    0: {
      overlap: 'Students obtained information from the images and readings and used it to reason about cause and effect, linking warming and thawing permafrost to fires that keep burning.',
      improvement: 'Some students noticed that zombie fires are unusual without using the evidence to name a cause, or generalized them to every wildfire.',
      nextStep: 'Have students who haven’t named a cause pick one piece of evidence and complete “This happens because…” before revising their models.',
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
  },
  'covid-descriptive': {
    0: {
      overlap: 'Most models label the coronavirus’s structures and draw the soap molecule with a hydrophilic head and a hydrophobic tail.',
      improvement: 'Some models leave the fatty envelope unlabeled, and a few swap which end of the soap molecule is hydrophilic.',
      nextStep: 'Have students check each label against the two-part prompt and correct any swapped soap ends before they start the mechanistic model.',
    },
    1: {
      overlap: 'A few students already connect the soap’s hydrophobic tail to the virus’s fatty envelope.',
      improvement: 'Many models show the virus and the soap side by side without showing how their structures relate.',
      nextStep: 'Ask students to draw one arrow from a soap structure to a virus structure and label why the two might interact.',
    },
  },
  'covid-mechanistic': {
    0: {
      overlap: 'Many models label which end of each soap molecule faces the oil and which faces the water.',
      improvement: 'Some models show a single soap molecule, so the combined action of many molecules isn’t shown.',
      nextStep: 'Have students redraw the interaction with several soap molecules and label which end faces the oil or the envelope.',
    },
    1: {
      overlap: 'Students show soap molecules surrounding oil and the hydrophobic tail pushing into the virus’s fatty envelope.',
      improvement: 'Many models stop before showing how water carries the trapped oil or virus away, and some describe soap as “killing” the virus.',
      nextStep: 'Ask students to add an arrow showing what water does to the soap-wrapped oil, and to replace “kills” with what happens to the envelope’s structure.',
    },
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

function mockClassSummaryReply(request: {
  lesson: ClassFeedbackLessonContext
  patterns: ClassSummaryPatternInput[]
  assignment: { id: string; title: string; prompt: string }
}): string {
  const { lesson, patterns, assignment } = request
  const judgments = mockClassSummaryJudgments[assignment.id] ?? {}
  const findings = (finding: 'overlap' | 'improvement'): ClassSummaryFinding[] =>
    lesson.objectives.flatMap((objective, objectiveIndex) => {
      const patternIds = patterns
        .filter((pattern) => judgments[pattern.id]?.objective === objectiveIndex && judgments[pattern.id].finding === finding)
        .sort((a, b) => b.studentCount - a.studentCount)
        .map((pattern) => pattern.id)
      const text = mockClassSummaryText[assignment.id]?.[objectiveIndex]
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

function analyzeClassSummary(lesson: ClassFeedbackLessonContext, assignment: ClassFeedbackAssignment): ClassSummaryOutput {
  const raw = callAiModel(
    'class-feedback-summary',
    {
      instructions: classSummaryInstructions,
      responseSchema: classSummarySchema,
      lesson,
      assignment: { id: assignment.id, title: assignment.title, prompt: assignment.task.question },
      patterns: classSummaryPatternsFor(assignment),
    },
    (request) => mockClassSummaryReply(request),
  )
  return readClassSummaryOutput(raw)
}

function FeedbackDashboardPage({
  lesson,
  assignmentId,
  onAssignmentChange,
  workType,
  onWorkTypeChange,
  selectedPatternId,
  onSelectPattern: setSelectedPatternId,
  onOpenStudentReport,
}: {
  lesson: LibraryLesson
  // The lesson's assignment being analyzed (null: its first), kept by App
  // so Back from a student's report returns to it.
  assignmentId: string | null
  onAssignmentChange: (assignmentId: string) => void
  // The student work reviewed within the assignment: Model or Explanation.
  workType: WorkType
  onWorkTypeChange: (next: WorkType) => void
  // The Class Summary finding whose students Student Evidence shows (kept
  // by App so Back from a student's report returns to it).
  selectedPatternId: string | null
  onSelectPattern: (id: string) => void
  // Opens one student's Individual Student Report for this assignment.
  onOpenStudentReport: (studentName: string, assignmentId: string) => void
}) {
  // The lesson this page is about, its assignments, and the class summary
  // of each assignment's submitted work (only lessons whose submissions
  // have been analyzed have assignments here).
  const [lessonContext] = useState(() => lessonContextFor(lesson))
  const assignments = classFeedbackAssignmentsFor(lesson.id)
  const assignment = assignments.find((item) => item.id === assignmentId) ?? assignments[0] ?? null
  // The assignment as the teacher chooses it, and its student-product switch.
  const choices = assignmentChoices(assignments)
  const choice = assignment ? choices.find((item) => assignmentLabel(item) === assignmentLabel(assignment)) : undefined
  const productSwitch = assignment ? productSwitchFor(assignment, workType) : null
  const productLabel = productSwitch?.options.find((option) => option.id === productSwitch.value)?.label ?? ''
  // A product with its own data shows its whole submission; otherwise the
  // selected Model or Explanation.
  const workView: WorkView = assignment?.productId ? 'both' : workType
  const [classSummaries] = useState<Record<string, ClassSummaryOutput>>(() =>
    Object.fromEntries(classFeedbackAssignmentsFor(lesson.id).map((item) => [item.id, analyzeClassSummary(lessonContext, item)])),
  )
  const classSummary = assignment ? (classSummaries[assignment.id] ?? null) : null
  const [questionsByAssignment, setQuestionsByAssignment] = useState<Record<string, FacilitationQuestion[]>>(() =>
    Object.fromEntries(
      classFeedbackAssignmentsFor(lesson.id).map((item) => [item.id, generateFacilitationQuestions(lessonContext, classSummaries[item.id], [], item)]),
    ),
  )
  const facilitationQuestions = assignment ? (questionsByAssignment[assignment.id] ?? []) : []
  const [isRegeneratingQuestions, setIsRegeneratingQuestions] = useState(false)

  // The last sets shown for each assignment, so a regenerated set is new;
  // older ones can come back once the ideas run out.
  const recentQuestionsRef = useRef<Record<string, string[]>>(
    Object.fromEntries(Object.entries(questionsByAssignment).map(([id, questions]) => [id, questions.map((question) => question.text)])),
  )
  const regenerationTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (regenerationTimeoutRef.current !== null) window.clearTimeout(regenerationTimeoutRef.current)
    }
  }, [])

  // The selected finding within this assignment — the first strength when
  // the teacher hasn't picked one here yet (or picked one in another).
  const assignmentPatternIds = assignment?.patternIds ?? []
  const activePatternId =
    selectedPatternId && assignmentPatternIds.includes(selectedPatternId)
      ? selectedPatternId
      : (classSummary?.overlap[0]?.patternIds[0] ?? assignmentPatternIds[0] ?? null)
  const selectedPattern = activePatternId ? allPatternRows[activePatternId] : undefined

  const objectiveLabel = (index: number) => objectiveLabelFor(lessonContext.objectives, index)

  // Suggested Next Steps: the analysis's instructional move for each
  // objective with gaps, and which student ideas it addresses.
  const nextSteps = (classSummary?.areasForImprovement ?? []).flatMap((finding) =>
    finding.nextStep
      ? [
          {
            objectiveIndex: finding.objectiveIndex,
            practices: finding.practices,
            action: finding.nextStep,
            ideas: finding.patternIds.length,
            students: finding.patternIds.reduce((total, id) => total + allPatternRows[id].count, 0),
          },
        ]
      : [],
  )

  const regenerateFacilitationQuestions = () => {
    if (!assignment) return
    setIsRegeneratingQuestions(true)
    const regenerating = assignment
    regenerationTimeoutRef.current = window.setTimeout(() => {
      const summary = classSummaries[regenerating.id]
      if (summary) {
        const recent = recentQuestionsRef.current[regenerating.id] ?? []
        const next = generateFacilitationQuestions(lessonContext, summary, recent, regenerating)
        recentQuestionsRef.current[regenerating.id] = [...recent, ...next.map((question) => question.text)].slice(-12)
        setQuestionsByAssignment((prev) => ({ ...prev, [regenerating.id]: next }))
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
    if (deeperAiTimeoutRef.current !== null) {
      window.clearTimeout(deeperAiTimeoutRef.current)
      deeperAiTimeoutRef.current = null
    }
    if (evidenceWorkspaceScrollRef.current) evidenceWorkspaceScrollRef.current.scrollTop = 0
  }, [activePatternId, assignment?.id])

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
    // Deeper AI Analysis is class-level: individual students are reviewed in
    // their Individual Student Report instead.
    deeperAiTimeoutRef.current = window.setTimeout(() => {
      const reply = callAiModel(
        'class-feedback-analysis',
        { pattern, question: text, focusedStudent: null, classAnalysis: classAnalysisForAi, assignment: assignment?.title },
        (request) => mockDeeperAnalysisReply(request.pattern, request.question, request.focusedStudent, request.classAnalysis),
      )
      setDeeperChatMessages((prev) => [...prev, { role: 'ai', text: reply }])
      setIsDeeperAiThinking(false)
    }, 700)
  }

  return (
    <div className="dashboard-page">
      <section className="dashboard-task-card">
        <div className="dashboard-task-header">
          <div>
            <p className="card-label">Assignment</p>
            <h3>{assignment?.task.topic ?? lesson.title}</h3>
          </div>
          {/* The lesson's assignments; with only one there's nothing to
              switch to, so the dropdown is shown but disabled. */}
          {assignment && choice && (
            <label className="work-view-select">
              <span>Assignment</span>
              <select
                value={choice.id}
                disabled={choices.length < 2}
                title={choices.length < 2 ? 'This lesson has one assignment.' : undefined}
                onChange={(event) => onAssignmentChange(event.target.value)}
              >
                {choices.map((option) => (
                  <option key={option.id} value={option.id}>
                    {assignmentLabel(option)}
                  </option>
                ))}
              </select>
              {choices.length < 2 && <small className="work-view-note">Only assignment in this lesson</small>}
            </label>
          )}
          {assignment && productSwitch && (
            <WorkTypeSwitch
              options={productSwitch.options}
              value={productSwitch.value}
              onChange={(productId) => {
                const next = chooseProduct(assignment, productId)
                if (next.assignment.id !== assignment.id) onAssignmentChange(next.assignment.id)
                if (next.workType) onWorkTypeChange(next.workType)
              }}
            />
          )}
        </div>
        <p className="dashboard-task-question">
          {assignment?.task.question ?? 'No student submissions have been analyzed for this lesson yet.'}
        </p>
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
        {(assignment?.metrics ?? []).map((metric) => (
          <div key={metric.label} className="metric-card">
            <p>{metric.label}</p>
            <strong>{metric.value}</strong>
            <span>{metric.trend}</span>
          </div>
        ))}
      </div>

      <div className="report-grid">
        <section className="report-panel class-summary-panel">
          <div className="panel-header compact">
            <h3>Class Summary</h3>
            {assignment && <span className="badge">{productLabel}</span>}
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
                      {/* The objective by its label only; the full text is
                          in the lesson plan (and the tooltip). */}
                      <p className="pattern-group-title" title={lessonContext.objectives[finding.objectiveIndex]}>
                        {objectiveLabel(finding.objectiveIndex)}
                      </p>
                      {finding.practices.length > 0 && (
                        <p className="finding-practices">Practices: {finding.practices.join(' · ')}</p>
                      )}
                      <p className="finding-summary">
                        <span className="finding-field-label">Summary:</span> {finding.summary}
                      </p>
                      {/* Student ideas and counts for this summary. */}
                      <div className="pattern-row-list">
                        {finding.patternIds.map((id) => (
                          <PatternRowButton
                            key={id}
                            row={allPatternRows[id]}
                            isActive={activePatternId === id}
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
                  {selectedPattern.label} · {selectedPattern.count} students · {productLabel}
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
                        alt={`${student.name}'s model`}
                        className="student-artifact-image"
                      />
                    )
                    const artifactBlock = !student.artifactImage && student.artifact && (
                      <p className="student-artifact">{student.artifact}</p>
                    )
                    return (
                      <div key={student.name} className="evidence-card">
                        <div className="student-header">
                          {/* The name and the button both open this
                              student's own report — not Deeper AI Analysis. */}
                          <h4>
                            <button
                              type="button"
                              className="student-name-link"
                              title={`Open ${student.name}'s Individual Student Report`}
                              onClick={() => assignment && onOpenStudentReport(student.name, assignment.id)}
                            >
                              {student.name}
                            </button>
                          </h4>
                        </div>
                        {/* Only the selected student work: the model, or
                            the student's written explanation. */}
                        {workView === 'both' ? (
                          <>
                            {responseBlock}
                            {imageBlock}
                            {artifactBlock}
                          </>
                        ) : workView === 'explanation' ? (
                          responseBlock || <p className="empty-state-support">No written explanation in this mock data.</p>
                        ) : (
                          imageBlock || artifactBlock || <p className="empty-state-support">No model in this mock data.</p>
                        )}
                        <div className="student-footer">
                          <button
                            type="button"
                            className="secondary-button student-report-link"
                            aria-label={`Access Individual Student Report for ${student.name}`}
                            onClick={() => assignment && onOpenStudentReport(student.name, assignment.id)}
                          >
                            Access Individual Student Report
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

                {selectedPattern ? (
                  <div className="deeper-analysis-body">
                    {/* The conversation appears once the teacher asks
                        something; until then there's only the input. */}
                    {(deeperChatMessages.length > 0 || isDeeperAiThinking) && (
                      <div className="deeper-analysis-chat">
                        <ChatThread messages={deeperChatMessages} />
                        {isDeeperAiThinking && <p className="empty-state-support">AI is analyzing these responses…</p>}
                      </div>
                    )}

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

      {/* Instructional actions for the gaps in Areas for Improvement — kept
          apart from the questions to ask students below. */}
      <section className="questions-panel next-steps-panel" aria-labelledby="next-steps-heading">
        <div className="panel-header compact">
          <h3 id="next-steps-heading">Suggested Next Steps</h3>
        </div>
        {nextSteps.length === 0 ? (
          <p className="empty-state-support">
            {classSummary
              ? 'No next steps — the analysis didn’t find gaps to address.'
              : 'Next steps will appear once this lesson’s student submissions are analyzed.'}
          </p>
        ) : (
          <ol className="next-step-list">
            {nextSteps.map((step) => (
              <li key={step.objectiveIndex} className="next-step-item">
                <p className="next-step-objective" title={lessonContext.objectives[step.objectiveIndex]}>
                  {objectiveLabel(step.objectiveIndex)}
                  {step.practices.length > 0 && <span className="next-step-practices"> · {step.practices.join(' · ')}</span>}
                </p>
                <p className="next-step-action">{step.action}</p>
                <p className="next-step-addresses">
                  Addresses {pluralize(step.ideas, 'student idea')} ({pluralize(step.students, 'response')}) in Areas for Improvement
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

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

// ---------------------------------------------------------------------------
// AppRoot — who is using the app
//
// Holds the session (nobody, the demo, or a Supabase teacher) and gives each
// one its own App: a new session means a new App with fresh state, so the
// demo's mock data and a teacher's real data never share state. In Supabase
// Mode:
//   - Explore Demo signs out any Supabase session first, then marks the
//     session as demo, so nothing in the demo can reach Supabase (see
//     getSupabase). The choice is kept for this tab across a refresh.
//   - Going to Login from the demo leaves it.
// Demo Mode (VITE_APP_MODE=demo) only ever has mock data, so it keeps one App
// and the existing mock login.
// ---------------------------------------------------------------------------

const supabaseBuild = appMode === 'supabase'

// Supabase requests have no timeout of their own; a sign-in that never gets
// an answer would otherwise leave the Login form waiting (and its buttons
// disabled) forever. A late answer still counts: a sign-in that completes
// after the timeout is picked up by onTeacherSessionChange.
const authTimeoutMs = 20_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new ApiError(message, { code: 'timeout' })), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function AppRoot() {
  const [session, setSession] = useState<AppSession>(() => {
    const demo = readStoredDemoSession()
    setSessionDataMode(demo ? 'demo' : 'none')
    return demo ? { kind: 'demo' } : { kind: 'none' }
  })
  // A teacher's saved Supabase session is checked once on load.
  const [isSessionChecked, setIsSessionChecked] = useState(() => session.kind === 'demo' || !usesSupabase('auth'))
  const [entryPage, setEntryPage] = useState<PageId | null>(null)
  const sessionRef = useRef(session)
  useEffect(() => {
    sessionRef.current = session
  }, [session])

  const isDemo = session.kind === 'demo'
  useEffect(() => {
    if (isDemo || !usesSupabase('auth')) return
    let active = true
    const applyTeacher = (teacher: TeacherSession | null) => {
      authDebug('AppRoot: session from Supabase', { signedIn: teacher !== null, user: shortId(teacher?.userId), current: sessionRef.current.kind })
      if (!active || sessionRef.current.kind === 'demo') return
      setSessionDataMode(teacher ? 'real' : 'none')
      // Signed in while on Login (e.g. a slow sign-in that finished after
      // the form gave up): continue where a sign-in goes.
      const onLoginPage = /^#?(login)?$/.test(window.location.hash.split('?')[0])
      if (teacher && sessionRef.current.kind === 'none' && onLoginPage) setEntryPage(getPostLoginPage())
      setSession((current) => {
        if (current.kind === 'demo') return current
        if (!teacher) return current.kind === 'none' ? current : { kind: 'none' }
        return current.kind === 'teacher' && current.teacher.userId === teacher.userId ? current : { kind: 'teacher', teacher }
      })
    }
    getTeacherSession()
      .then(applyTeacher)
      .catch(() => applyTeacher(null))
      .finally(() => {
        if (active) setIsSessionChecked(true)
      })
    // Follows sign-in / sign-out in other tabs. Missing or unsafe
    // configuration throws here; the login form then shows the reason.
    let unsubscribe = () => {}
    try {
      unsubscribe = onTeacherSessionChange(applyTeacher)
    } catch {
      // See above.
    }
    return () => {
      active = false
      unsubscribe()
    }
  }, [isDemo])

  const signIn = async (email: string, password: string): Promise<string | null> => {
    try {
      authDebug('signIn: calling signInWithPassword')
      const teacher = await withTimeout(signInTeacher(email, password), authTimeoutMs, 'Signing in is taking longer than expected. Check your connection and try again.')
      authDebug('signIn: signInWithPassword resolved', { user: shortId(teacher.userId) })
      setSessionDataMode('real')
      setEntryPage(getPostLoginPage())
      setSession({ kind: 'teacher', teacher })
      return null
    } catch (error) {
      authDebug('signIn: failed', { message: toApiError(error).message })
      return toApiError(error, 'Couldn’t log in. Please try again.').message
    }
  }

  const exploreDemo = async (): Promise<string | null> => {
    if (usesSupabase('auth')) {
      // No real session may stay active underneath the demo.
      try {
        await withTimeout(signOutTeacher(), authTimeoutMs, 'Signing out timed out.')
      } catch {
        // Checked below.
      }
      try {
        if (await withTimeout(getTeacherSession(), authTimeoutMs, 'Checking your session timed out.')) {
          return 'Couldn’t sign out of your account. Please try again before exploring the demo.'
        }
      } catch (error) {
        // Can't confirm the sign-out, so don't start the demo over a session.
        if (error instanceof ApiError && error.code === 'timeout') {
          return 'Couldn’t confirm you’re signed out. Check your connection and try again.'
        }
        // Otherwise there's no usable client, so no session either.
      }
    }
    storeDemoSession(true)
    setSessionDataMode('demo')
    setEntryPage(getPostLoginPage())
    setSession({ kind: 'demo' })
    return null
  }

  const exitDemo = useCallback(() => {
    storeDemoSession(false)
    setSessionDataMode('none')
    setEntryPage('login')
    setSession({ kind: 'none' })
  }, [])

  if (!isSessionChecked) {
    return (
      <div className="app-shell login-shell">
        <p className="empty-state-support" role="status">
          Checking your session…
        </p>
      </div>
    )
  }

  const appKey = supabaseBuild ? (session.kind === 'teacher' ? `teacher:${session.teacher.userId}` : session.kind) : 'demo-build'
  authDebug('AppRoot render', { session: session.kind, appKey: session.kind === 'teacher' ? `teacher:${shortId(session.teacher.userId)}` : appKey, entryPage })
  return <App key={appKey} session={session} entryPage={entryPage} onSignIn={signIn} onExploreDemo={exploreDemo} onExitDemo={exitDemo} />
}

export default AppRoot
