/**
 * Static audit of the dock's layout rules.
 *
 * The notice has two states with different cross-axis alignment needs, and the
 * bug being guarded against here is precisely a mismatch between them: the text
 * column and the button column must agree on where "center" is. This checks the
 * CSS text, since the browser is not scriptable from here.
 *
 * usage: node verify-layout.mjs
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../recover/client.js', import.meta.url), 'utf8')
const css = source.slice(source.indexOf('const CSS = `') + 'const CSS = `'.length, source.indexOf('\n`\n'))

let failures = 0
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** Read one rule's declarations by selector. */
function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  return match ? match[1] : null
}

/** Read a declaration value out of a rule body. */
function decl(body, property) {
  if (body === null) return null
  // Declarations may be separated by `;`, a comment close, or plain newlines, so
  // anchor on a line start or a `;` rather than assuming `;` alone.
  const match = body.match(new RegExp(`(?:^|;|\\*/)\\s*${property}\\s*:\\s*([^;]+)`))
  return match ? match[1].trim() : null
}

console.log('-- collapsed card')
const card = rule('.npd-card')
check('.npd-card rule exists', card !== null)
check('the card centers its cross axis while collapsed', decl(card, 'align-items') === 'center', decl(card, 'align-items'))
check('the card is a flex row', decl(card, 'display') === 'flex', decl(card, 'display'))

const main = rule('.npd-main')
check('.npd-main takes the free space', decl(main, 'flex') === '1', decl(main, 'flex'))
const collapsedMain = rule('.npd-card:not([data-expanded="true"]) .npd-main')
check(
  'the collapsed text column centers vertically',
  decl(collapsedMain, 'justify-content') === 'center',
  decl(collapsedMain, 'justify-content'),
)

const actions = rule('.npd-actions')
check('.npd-actions rule exists', actions !== null)
check(
  'the button group does NOT override the card alignment',
  decl(actions, 'align-self') === null,
  decl(actions, 'align-self'),
)
check('the button group keeps its own children centered', decl(actions, 'align-items') === 'center', decl(actions, 'align-items'))

console.log('\n-- expanded card')
const expandedCard = rule('.npd-card[data-expanded="true"]')
check('the expanded card anchors to the top', decl(expandedCard, 'align-items') === 'flex-start', decl(expandedCard, 'align-items'))
check('no expanded-only align-self override remains', !css.includes('.npd-card[data-expanded="true"] .npd-actions'))

console.log('\n-- line boxes')
const title = rule('.npd-title')
const reason = rule('.npd-reason')
const button = rule('.npd-button')
check('title line-height is set', decl(title, 'line-height') === '22px', decl(title, 'line-height'))
check('reason line-height matches the title', decl(reason, 'line-height') === '22px', decl(reason, 'line-height'))
check('button has a fixed height', decl(button, 'height') === '30px', decl(button, 'height'))
check(
  'the button is a flex box that centers its own label',
  decl(button, 'display') === 'inline-flex' && decl(button, 'align-items') === 'center',
  `${decl(button, 'display')} / ${decl(button, 'align-items')}`,
)

console.log('\n-- title row contents')
const titleRow = rule('.npd-titleRow')
check('the title row centers dot, title and reason', decl(titleRow, 'align-items') === 'center', decl(titleRow, 'align-items'))
check('the row is a flex box', decl(titleRow, 'display') === 'flex', decl(titleRow, 'display'))
const dot = rule('.npd-dot')
check('the dot is square and non-shrinking', decl(dot, 'width') === '8px' && decl(dot, 'flex') === 'none')

console.log('\n-- the expanded flag reaches the DOM')
check(
  'the card carries data-expanded when open',
  source.includes("'data-expanded': expanded ? 'true' : undefined"),
)
check(
  'both state selectors are keyed on the same attribute',
  css.includes('[data-expanded="true"]'),
)

console.log(failures === 0 ? '\nOK: layout rules are consistent' : `\nFAIL: ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
