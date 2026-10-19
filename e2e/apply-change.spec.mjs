// End-to-end regression test for the AI lesson-revision workflow in the
// Lesson Workspace on Lesson Planning. This is a plain Node script (not a
// test-framework file) so it can run with zero configuration:
// `npm run test:e2e`.
//
// It spins up the Vite dev server itself, drives a real Chromium instance
// through the exact flow a teacher would use — starting at the mock Teacher
// Login, then opening the demo lesson from the Library — and asserts on the
// rendered DOM, not on internal state, so it catches the class of bug where
// the UI *looks* like it applied a change (highlight + badge) without the
// actual lesson text being replaced.
//
// Flow under test — one working lesson:
//   The lesson is driven entirely by editor.revisedLesson — it only ever
//   changes in response to the teacher explicitly clicking Apply to Lesson
//   in the conversational left-side chat, or an Edit Lesson manual edit
//   (which always wins, regardless of any AI track). A section is marked
//   "AI revised" only once the teacher has actually accepted a change.
//
//   0. A single view (no Generated / AI Suggestions tab strip): pending AI
//      suggestions are flagged as clickable highlights and summarized; a
//      section with no AI suggestion (Materials) is never flagged —
//      "don't introduce unrelated changes."
//   1. Clicking a flagged phrase opens that section's conversation in the
//      LEFT workspace, not inline in the lesson text — the right side stays
//      the lesson plan.
//   2. There is no separate "Preview Change" step. As soon as the AI has a
//      concrete proposal, the full proposed content is shown immediately in
//      a "Suggested revision — not yet applied" card in the left chat, with
//      Apply to Lesson as its action.
//   3. A follow-up typed into the left chat (behind "Ask AI about this")
//      replaces the card's content with a new concrete proposal (a
//      statement, not another clarifying question) whenever the teacher's
//      intent is clear enough to act on. AI only asks a clarifying question
//      back when the follow-up is genuinely too vague to turn into a
//      revision.
//   4. Every section with a flagged suggestion (not just one) supports the
//      same open -> Apply to Lesson flow. A freeform text selection (e.g. on
//      Standards, which has no pre-flagged suggestion) can still start a
//      conversation on the left, just with no suggested-revision card until
//      the AI actually has something concrete to propose.
//   5. Manual "Edit Lesson" still works independently, per section, and its
//      edits always win over any AI suggestion or applied change.
//   6. Opening a section's AI Suggestion card, then clicking Edit Lesson,
//      must NOT hide that suggestion — it stays visible right next to the
//      section's now-editable textarea, so the teacher can compare the
//      suggestion against what they're typing without switching views.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

const PORT = 4319
const BASE_URL = `http://localhost:${PORT}/`
const DEMO_TEACHER_EMAIL = 'demo@partners.edu'

// Every section that carries a pre-flagged AI suggestion (see
// lessonSuggestions / lessonRevisionSegments in src/App.tsx).
const ALL_SECTION_LABELS = [
  'Crosscutting Concept',
  'Equipment & Technology',
  'Engage',
  'Explore',
  'Explain',
  'Elaborate',
  'Evaluate',
  'Assessment',
]

const ORIGINAL_ASSESSMENT_TEXT =
  'Students ask questions to clarify what they still need to understand about the flow of energy and matter between the atmosphere (CO₂/smoke) and biosphere (peat/permafrost), including the role of humans in zombie fires becoming more common. These questions are collected and added to a class Driving Question Board to guide the lessons that follow. Look for: at least one question connected to matter or energy flow, and one question about cause and effect (including human influence).'
const PROPOSED_ASSESSMENT_TEXT =
  'Students exchange their initial model with a partner for a quick round of feedback, then ask questions to clarify what they still need to understand about the flow of energy and matter between the atmosphere (CO₂/smoke) and biosphere (peat/permafrost), including the role of humans in zombie fires becoming more common. These questions are collected and added to a class Driving Question Board to guide the lessons that follow. Each group posts its top question to the board so the class can track which ones get answered as the unit progresses. Look for: at least one question connected to matter or energy flow, and one question about cause and effect (including human influence).'

function log(message) {
  console.log(`[e2e] ${message}`)
}

function waitForServer(url, timeoutMs) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const res = await fetch(url)
        if (res.ok || res.status === 404) {
          resolve()
          return
        }
      } catch {
        // server not up yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for ${url}`))
        return
      }
      setTimeout(attempt, 300)
    }
    attempt()
  })
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`)
  }
  log(`PASS: ${message}`)
}

// The app opens on the mock Teacher Login. The demo teacher's email signs in
// as a returning teacher, who lands on Class Setup.
async function loginAsDemoTeacher(page) {
  await page.goto(BASE_URL)
  await page.waitForSelector('h2:has-text("Teacher Login")')
  await page.fill('input[type="email"]', DEMO_TEACHER_EMAIL)
  await page.fill('input[type="password"]', 'demo-password')
  await page.click('.login-card button[type="submit"]:has-text("Login")')
  await page.waitForSelector('h2:has-text("Class Setup")')
}

// The Lesson Workspace now lives on Lesson Planning: opening the demo
// lesson's Lesson Planning from its class in the Library shows the
// generated Zombie Fires lesson in the workspace, the same way a teacher
// reaches it.
async function gotoLessonWorkspace(page) {
  await loginAsDemoTeacher(page)
  await page.click('button[aria-label="Open prototype navigation"]')
  await page.waitForSelector('text=Prototype Navigation')
  await page.click('.nav-drawer button:has-text("Library")')
  const demoClass = page.locator('article.library-class-card', { hasText: 'Period 4 · Earth Science' })
  await demoClass.locator('button:has-text("View Lessons")').click()
  await demoClass.locator('button:has-text("Zombie Fires: Matter and Energy Flow")').click()
  await demoClass.locator('button:has-text("Lesson Planning")').click()
  await page.waitForSelector('text=Lesson Title: Zombie Fires')
}

// Opens a flagged suggestion's conversation on the left by clicking its
// highlighted phrase, and reveals the chat thread (it starts tucked behind
// "Ask AI about this" whenever there's a proposal to review).
async function openSuggestionChat(page, label, flag) {
  await flag.click()
  await page.waitForSelector('.revision-chat-panel')
  const askButton = page.locator('.revision-chat-panel button:has-text("Ask AI about this")')
  if (await askButton.count()) await askButton.click()
  await page.waitForSelector('.revision-chat-thread')
}

async function run() {
  log(`starting Vite dev server on port ${PORT}...`)
  const server = spawn(`npx vite --port ${PORT} --strictPort`, {
    cwd: projectRoot,
    shell: true,
    stdio: 'ignore',
  })

  let browser
  try {
    await waitForServer(BASE_URL, 30000)
    log('dev server is up')

    browser = await chromium.launch()

    // ====================================================================
    // PART 0: one working lesson (the Generated / AI Suggestions tab strip
    // was folded into a single view). Pending suggestions are flagged in the
    // text and summarized; nothing is marked "AI revised" until the teacher
    // has actually applied a change.
    // ====================================================================
    const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } })
    const consoleErrors = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text())
    })
    page.on('pageerror', (err) => consoleErrors.push(String(err)))

    await gotoLessonWorkspace(page)

    assert(
      (await page.locator('.state-tab').count()) === 0,
      'the workspace shows a single working lesson — no Generated / AI Suggestions / Revised tab strip',
    )
    assert(
      (await page.locator('.lesson-plan-content .ai-revised-tag').count()) === 0,
      'the working lesson shows no "AI revised" tag before anything has been applied',
    )
    const suggestionSummary = await page.locator('.lesson-suggestion-summary').innerText()
    assert(
      /\d+ AI suggestions? to review/.test(suggestionSummary),
      `pending AI suggestions are summarized above the lesson (got "${suggestionSummary}")`,
    )

    // ====================================================================
    // PART 1: the full workflow on Assessment, via the flagged suggestion —
    // clicking it opens the left chat -> the suggested revision is
    // immediately visible in full, with Apply to Lesson as the action ->
    // Apply to Lesson updates the working lesson.
    // ====================================================================
    const assessmentFlag = page.locator('[data-section-key="Assessment"] .lesson-highlight-trigger.ai-highlight', {
      hasText: 'These questions are collected and added to a class Driving Question Board',
    })
    assert((await assessmentFlag.count()) === 1, 'Assessment shows its flagged AI-suggestion trigger before any change')

    await assessmentFlag.click()
    await page.waitForSelector('.revision-chat-panel')
    assert(
      (await page.locator('.revision-chat-panel h4').innerText()) === 'Assessment',
      'the left chat is scoped to the Assessment section the teacher clicked',
    )
    assert(
      (await page.locator('.revision-chat-panel button:has-text("Preview Change")').count()) === 0,
      'there is no separate Preview Change button',
    )
    const proposalCardText = await page.locator('.revision-chat-panel .inline-ai-preview').innerText()
    assert(
      proposalCardText.toUpperCase().includes('SUGGESTED REVISION — NOT YET APPLIED'),
      'the suggested-revision card is labeled "Suggested revision — not yet applied"',
    )
    assert(
      proposalCardText.includes(PROPOSED_ASSESSMENT_TEXT),
      'the full proposed revised content is already visible in the card',
    )

    const assessmentParagraph = page.locator('[data-section-key="Assessment"] > p').first()
    assert(
      (await assessmentParagraph.innerText()).includes(ORIGINAL_ASSESSMENT_TEXT),
      'the working lesson is untouched until Apply to Lesson — only the left card shows the proposal',
    )

    await page.click('.revision-chat-panel .inline-ai-preview button:has-text("Apply to Lesson")')
    await page.waitForSelector('[data-section-key="Assessment"] .ai-revised-tag')
    const afterFirstApply = await assessmentParagraph.innerText()
    assert(!afterFirstApply.includes(ORIGINAL_ASSESSMENT_TEXT), 'the original Assessment sentence is gone from the working lesson after Apply to Lesson')
    assert(afterFirstApply.includes(PROPOSED_ASSESSMENT_TEXT), 'the applied Assessment text is now visible in the working lesson')
    assert(
      (await page.locator('.revision-chat-panel .inline-ai-applied-note').innerText()).includes('Applied to Lesson'),
      'the left chat status becomes "Applied to Lesson"',
    )

    // Only the two phrases AI actually added should be highlighted — the
    // surrounding original wording ("Students ask questions to clarify...",
    // "Look for: ...") must stay plain. This is the canned first apply, so
    // the added/plain split is exact, known data, not a guess.
    const assessmentOuterTrigger = page.locator('[data-section-key="Assessment"] .lesson-highlight-trigger').first()
    const assessmentOuterClass = (await assessmentOuterTrigger.getAttribute('class')) ?? ''
    assert(
      !assessmentOuterClass.split(' ').includes('ai-highlight'),
      'the outer clickable wrapper around Assessment is not itself a blanket highlight',
    )
    assert(
      (await page.locator('[data-section-key="Assessment"] .ai-highlight').count()) === 2,
      'exactly the two AI-added phrases are individually highlighted after the first (canned) apply',
    )

    // ====================================================================
    // PART 2: a follow-up produces a NEW proposal — applying it changes the
    // same working lesson further (there's only one working lesson, not a
    // separate static baseline).
    // ====================================================================
    const followUpInput = '.revision-chat-panel input[placeholder="Ask about this revision..."]'
    await page.click('.revision-chat-panel button:has-text("Ask AI about this")')
    await page.fill(followUpInput, 'Can you make this revision more focused on matter and energy flow?')
    await page.click('.revision-chat-panel button:has-text("Send")')
    await page.waitForSelector('.revision-chat-panel .inline-ai-preview')
    await page.click('.revision-chat-panel .inline-ai-preview button:has-text("Apply to Lesson")')
    await page.waitForSelector('.revision-chat-panel .inline-ai-applied-note')

    const workingAssessmentText = await assessmentParagraph.innerText()
    assert(
      workingAssessmentText.toLowerCase().includes('matter') && workingAssessmentText.toLowerCase().includes('label each addition'),
      'the working lesson now reflects the follow-up-refined proposal',
    )

    // The follow-up's new text extends (rather than replaces) the earlier
    // highlighting: the first apply's two added phrases are still
    // individually highlighted, PLUS the new follow-up suffix — three
    // highlighted spans total — while the true original wording remains
    // plain throughout, across both rounds.
    assert(
      (await page.locator('[data-section-key="Assessment"] .ai-highlight').count()) === 3,
      'after the follow-up round, three separate phrases are highlighted (two from the canned apply, one new) — not the whole section',
    )
    assert(
      workingAssessmentText.includes('Students ') && workingAssessmentText.includes('Look for:'),
      'the section\'s true original wording is still present, unhighlighted, after two rounds of applied changes',
    )

    assert(
      (await page.locator('[data-section-key="Assessment"] .ai-revised-tag').count()) === 1,
      'the working lesson marks Assessment "AI revised" once, after two applied rounds',
    )

    // ====================================================================
    // PART 2.5: a genuinely vague follow-up gets a clarifying question, and
    // a clear one ("make it more student-led") gets a fresh concrete
    // proposal.
    // ====================================================================
    await page.fill(followUpInput, 'ok')
    await page.click('.revision-chat-panel button:has-text("Send")')
    await page.waitForTimeout(900)
    const vagueMessages = await page.locator('.revision-chat-thread .chat-message').allInnerTexts()
    assert(vagueMessages[vagueMessages.length - 1].trim().endsWith('?'), 'a too-vague follow-up gets a clarifying question back')

    await page.fill(followUpInput, 'Make it more student-led.')
    await page.click('.revision-chat-panel button:has-text("Send")')
    await page.waitForSelector('.revision-chat-panel .inline-ai-preview')
    const studentLedReply = (await page.locator('.revision-chat-thread .chat-message').allInnerTexts()).slice(-1)[0]
    assert(!studentLedReply.trim().endsWith('?'), 'a clear follow-up gets a concrete proposal back, not another question')
    assert(
      (await page.locator('.revision-chat-panel .inline-ai-applied-note').count()) === 0,
      'the new proposal is pending again until Apply to Lesson is clicked once more',
    )

    // ====================================================================
    // PART 3: closing the chat returns the left panel to the planning
    // options the teacher had before, not a blank panel.
    // ====================================================================
    await page.click('.revision-chat-panel .drawer-close')
    assert((await page.locator('.revision-chat-panel').count()) === 0, 'closing the conversation hides the revision chat panel')
    assert(
      await page.isVisible('text=Create a new lesson'),
      'the left panel falls back to the lesson planning options once no section is being discussed',
    )

    await page.close()

    // ====================================================================
    // PART 4: every section with a flagged suggestion — not just
    // Assessment — supports the open-suggestion -> Apply to Lesson flow.
    // ====================================================================
    const page2 = await browser.newPage({ viewport: { width: 1440, height: 1300 } })
    page2.on('pageerror', (err) => consoleErrors.push(String(err)))
    await gotoLessonWorkspace(page2)
    const seenProposals = new Set()

    for (const label of ALL_SECTION_LABELS) {
      const flag = page2.locator(`[data-section-key="${label}"] .lesson-highlight-trigger.ai-highlight`)
      const flagCount = await flag.count()
      assert(flagCount >= 1, `"${label}" shows a flagged AI-suggestion trigger (got ${flagCount})`)

      const beforeText = await page2.locator(`[data-section-key="${label}"]`).first().innerText()

      await openSuggestionChat(page2, label, flag.first())

      assert(
        (await page2.locator('.revision-chat-panel h4').innerText()) === label,
        `the left chat is scoped to "${label}"`,
      )

      const messages = await page2.locator('.revision-chat-thread .chat-message').allInnerTexts()
      assert(messages.length >= 3, `"${label}" has its own multi-turn mock conversation (opener + teacher + AI), got ${messages.length}`)
      const aiProposalMessage = messages[messages.length - 1]
      assert(!seenProposals.has(aiProposalMessage), `"${label}"'s AI proposal is distinct from every other section's`)
      seenProposals.add(aiProposalMessage)

      assert(
        (await page2.locator('.revision-chat-panel .inline-ai-preview button:has-text("Apply to Lesson")').count()) === 1,
        `"${label}" offers Apply to Lesson immediately, with the proposal already visible`,
      )
      await page2.click('.revision-chat-panel .inline-ai-preview button:has-text("Apply to Lesson")')
      await page2.waitForSelector(`[data-section-key="${label}"] .ai-revised-tag`)

      const afterText = await page2.locator(`[data-section-key="${label}"]`).first().innerText()
      assert(afterText !== beforeText, `"${label}" section text actually changed in the working lesson after Apply to Lesson`)

      // Only the part AI actually added should carry .ai-highlight — never
      // the section's original wording. The outer clickable wrapper itself
      // must not be a blanket highlight once we have that finer-grained
      // information (Crosscutting Concept applies straight from the canned
      // proposal, so this is exact, not a same-text coincidence).
      if (label === 'Crosscutting Concept') {
        const outerTrigger = page2.locator('[data-section-key="Crosscutting Concept"] .lesson-highlight-trigger').first()
        const outerClass = (await outerTrigger.getAttribute('class')) ?? ''
        assert(!outerClass.split(' ').includes('ai-highlight'), 'the outer clickable wrapper is not itself a blanket highlight once the added part is known')
        const highlightedSpans = page2.locator('[data-section-key="Crosscutting Concept"] .ai-highlight')
        assert((await highlightedSpans.count()) === 1, 'exactly one highlighted span — the added sentence — not the whole section')
        const highlightedText = await highlightedSpans.first().innerText()
        assert(
          highlightedText.trim().startsWith('This lesson asks students to distinguish peat'),
          `the highlighted span is the added sentence itself, got: "${highlightedText}"`,
        )
        assert(
          afterText.includes('Energy and Matter: Flows, Cycles, and Conservation.'),
          'the original sentence is still present in the section text',
        )
        const originalSentenceSpan = page2.locator('[data-section-key="Crosscutting Concept"] .lesson-highlight-trigger', {
          hasText: 'Energy and Matter: Flows, Cycles, and Conservation.',
        })
        assert(
          !(await originalSentenceSpan.locator('.ai-highlight', { hasText: 'Energy and Matter' }).count()),
          'the original sentence itself is never wrapped in .ai-highlight',
        )
      }

      // Re-clicking the now-applied, highlighted text re-opens its
      // conversation directly — no intermediate popup.
      await page2.click(`[data-section-key="${label}"] .lesson-highlight-trigger`)
      await page2.waitForSelector('.revision-chat-panel')
      assert(
        (await page2.locator('.revision-chat-panel h4').innerText()) === label,
        `re-clicking "${label}"'s applied text re-opens its own conversation`,
      )
    }

    await page2.close()

    // ====================================================================
    // PART 5: a freeform selection on a section with no pre-flagged
    // suggestion (Standards) can still start a conversation on the left —
    // just with no proposed-change card until the AI actually has
    // something concrete to propose.
    // ====================================================================
    const page3 = await browser.newPage({ viewport: { width: 1440, height: 1400 } })
    page3.on('pageerror', (err) => consoleErrors.push(String(err)))
    await gotoLessonWorkspace(page3)

    for (const heading of ['Standards', 'Learning Objectives']) {
      assert(
        (await page3.locator('.lesson-section-heading', { hasText: new RegExp(`^${heading}$`) }).count()) === 1,
        `${heading} renders its own group heading`,
      )
    }
    const objectiveChecks = [
      ['Learning Objective 1', '1.A'],
      ['Learning Objective 2', '1.B'],
      ['Learning Objective 3', '1.C'],
    ]
    for (const [label, prefix] of objectiveChecks) {
      const container = page3.locator(`[data-section-key="${label}"]`)
      assert((await container.count()) === 1, `"${label}" is its own independently addressable component`)
      const text = await container.innerText()
      assert(text.trimStart().startsWith(prefix), `"${label}" displays as a numbered item ("${prefix}")`)
    }

    const materialsItems = await page3.locator('[data-section-key="Materials"] .lesson-bullet-list li').count()
    assert(materialsItems === 5, `Materials renders as ${materialsItems} individual bullet points (expected 5)`)
    assert(
      (await page3.locator('[data-section-key="Materials"] .ai-highlight').count()) === 0,
      'Materials never shows a blanket (or any) AI highlight — it is plain existing content',
    )

    const standardsPara = page3.locator('[data-section-key="Standards"] > p').first()
    await standardsPara.scrollIntoViewIfNeeded()
    await standardsPara.evaluate((el) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const selection = window.getSelection()
      selection.removeAllRanges()
      selection.addRange(range)
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page3.waitForSelector('.selection-ask-popup')
    await page3.click('.ask-ai-chip')
    await page3.waitForSelector('.revision-chat-panel')
    assert(
      (await page3.locator('.revision-chat-panel h4').innerText()) === 'Standards',
      'a freeform selection also switches the left workspace to that section’s AI chat',
    )
    const standardsOpener = await page3.locator('.revision-chat-thread .chat-message').first().innerText()
    assert(standardsOpener.includes('NGSS HS-LS2-3'), 'contextual "See AI Suggestions" works on Standards, scoped to its own selected text')
    assert(
      (await page3.locator('.revision-chat-panel .inline-ai-preview').count()) === 0,
      'Standards has no canned proposal, so no suggested-revision card or Apply to Lesson is offered for it',
    )
    await page3.click('.revision-chat-panel .drawer-close')

    // ====================================================================
    // PART 6: opening a flagged suggestion's card, then Edit Lesson, must
    // not hide that suggestion — it stays visible right next to the
    // section's now-editable textarea (Evaluate has never been touched by
    // any earlier part of this test, so its suggestion is still pending).
    // ====================================================================
    assert(
      (await page3.locator('[data-section-key="Evaluate"] .lesson-highlight-trigger.ai-highlight', {
        hasText: 'Two or three groups briefly share',
      }).count()) === 1,
      'Evaluate flags the phrase its suggestion is about',
    )
    await page3.click('[data-section-key="Evaluate"] .lesson-suggestion-toggle')
    await page3.waitForSelector('[data-section-key="Evaluate"] .lesson-suggestion-body')
    assert(
      (await page3.locator('[data-section-key="Evaluate"] .suggestion-popover').innerText()).includes(
        'Consider giving yourself a short checklist',
      ),
      'Evaluate\'s AI Suggestion card shows its suggestion text before editing',
    )

    await page3.click('button:has-text("Edit Lesson")')
    await page3.waitForSelector('[data-section-key="Evaluate"] textarea')
    assert(
      (await page3.locator('[data-section-key="Evaluate"] .suggestion-popover').count()) === 1,
      'the AI Suggestion popover for Evaluate is still visible next to its textarea after clicking Edit Lesson',
    )
    assert(
      (await page3.locator('[data-section-key="Evaluate"] .suggestion-popover').innerText()).includes(
        'Consider giving yourself a short checklist',
      ),
      'the same suggestion text is still readable while editing, so the teacher can compare it against their draft',
    )

    await page3
      .locator('[data-section-key="Evaluate"] textarea')
      .fill('I will listen for exactly two things while circulating: matter vs. energy, and how the fire persists through winter.')
    await page3.click('button:has-text("Save Edits")')
    await page3.waitForTimeout(100)
    const evaluateTextAfterEdit = await page3.locator('[data-section-key="Evaluate"]').innerText()
    assert(
      evaluateTextAfterEdit.includes('I will listen for exactly two things while circulating'),
      'the teacher\'s edit to Evaluate — written while referencing the visible suggestion — is saved',
    )

    // ====================================================================
    // PART 7: manual "Edit Lesson" still works independently per section,
    // and its edits always win over any AI suggestion or applied change.
    // ====================================================================
    await page3.click('button:has-text("Edit Lesson")')
    await page3.waitForTimeout(100)
    await page3
      .locator('[data-section-key="Learning Objective 2"] textarea')
      .fill('Use evidence to explain how matter and energy move through the zombie fire system.')
    await page3.click('button:has-text("Save Edits")')
    await page3.waitForTimeout(100)
    const objective2Text = await page3.locator('[data-section-key="Learning Objective 2"]').innerText()
    assert(
      objective2Text.includes('Use evidence to explain how matter and energy move through the zombie fire system.'),
      'Learning Objective 2 is independently editable via Edit Lesson, without affecting its siblings',
    )
    const objective1TextAfterEdit = await page3.locator('[data-section-key="Learning Objective 1"]').innerText()
    assert(
      objective1TextAfterEdit.includes('Obtain information about zombie fires'),
      'editing Learning Objective 2 does not affect Learning Objective 1',
    )
    const materialsTextAfterEdit = await page3.locator('[data-section-key="Materials"]').innerText()
    assert(
      materialsTextAfterEdit.includes('Zombie fire photographs and a short video clip'),
      'editing Learning Objective 2 does not affect Materials',
    )

    // Manually editing Assessment (which DOES carry a pending suggestion)
    // must override that suggestion — no AI highlight, no popover, just the
    // teacher's own final wording.
    // Save Edits above already exited editing mode, so re-enter it.
    await page3.click('button:has-text("Edit Lesson")')
    await page3.waitForTimeout(100)
    await page3
      .locator('[data-section-key="Assessment"] textarea')
      .fill('Students write down one question they still have about zombie fires.')
    await page3.click('button:has-text("Save Edits")')
    await page3.waitForTimeout(100)
    const assessmentTextAfterManualEdit = await page3.locator('[data-section-key="Assessment"]').innerText()
    assert(
      assessmentTextAfterManualEdit.includes('Students write down one question they still have about zombie fires.'),
      'a manual edit overrides Assessment\'s pending AI suggestion',
    )
    assert(
      (await page3.locator('[data-section-key="Assessment"] .ai-highlight').count()) === 0,
      'a manually-edited section shows no AI highlight — it is the teacher\'s own final wording',
    )

    await page3.close()

    assert(consoleErrors.length === 0, `no console errors (saw: ${JSON.stringify(consoleErrors)})`)

    log('ALL CHECKS PASSED')
  } finally {
    if (browser) await browser.close()
    stopServer(server)
  }
}

function stopServer(server) {
  if (!server.pid) return
  if (process.platform === 'win32') {
    // spawn(..., { shell: true }) wraps the process in cmd.exe, so a plain
    // server.kill() only kills the shell, leaving vite running. Kill the
    // whole process tree instead.
    spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    server.kill()
  }
}

run().catch((err) => {
  console.error(`[e2e] ${err.message}`)
  process.exit(1)
})
