/**
 * Style-conformance and render audit of every icon this pack ships: the package
 * icon ('icon.svg') and one icon per component ('recover/icon.svg',
 * 'window/icon.svg'). These are separate packages, so the Plugins list draws
 * them as separate rows and each row must carry its OWN unmistakable drawing;
 * the pairwise assertions below fail a copy even though a copy is a valid icon.
 *
 * Both files are package resources the harness paints through an <img src>, so
 * they load in isolation: no external references, no stylesheet, no script, no
 * text. The style is the one the official DSH plugin icons use, calibrated
 * against the 36x36 '<plugin>/icon.svg' files extracted from the app asar into
 * .tmp-icons/ (the two 64x64 cordis-plugin-development templates are not part
 * of that icon family):
 *
 *   - viewBox="0 0 36 36" and no conflicting pixel width/height;
 *   - flat geometric shapes filled by linear gradients only;
 *   - gradients are userSpaceOnUse with at least two stops;
 *   - the optical footprint sits inside 6..31.5 of 36. Measured over the 13
 *     official 36x36 icons, no footprint starts before 6.0 and none ends after
 *     31.1 (inspector-profile's round-capped magnifier handle), so the bound is
 *     the observed extreme plus half a unit of optical tolerance: it flags a
 *     full-bleed icon without ever flagging official artwork;
 *   - every painted color is one of the 31 colors in PALETTE below.
 *
 * Color comes from the markup. Geometry is measured by the pure-JavaScript
 * evaluator below — every painted element, stroke width included — so the
 * footprint and safe-area checks run on a clean checkout with no native
 * modules. A sharp/librsvg rasterization is used only when one happens to be
 * resolvable: it adds "it actually paints" evidence (36px/30px tiles and a
 * contact sheet in .tmp-render/) and cross-checks the evaluator; its absence is
 * a `skip`, never a silent pass.
 *
 * usage: node verify-icons.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)
const renderDir = fileURLToPath(new URL('.tmp-render/', root))

let failures = 0
let skipped = 0
function check(label, condition, detail) {
  if (condition) console.log('  ok   ' + label)
  else {
    failures++
    console.log('  FAIL ' + label + (detail === undefined ? '' : ' — ' + detail))
  }
}
function note(label, detail) {
  console.log('  note ' + label + (detail === undefined ? '' : ' — ' + detail))
}
function skip(label, detail) {
  skipped++
  console.log('  skip ' + label + (detail === undefined ? '' : ' — ' + detail))
}

/** The official icon canvas, in user units. */
const VIEW_BOX = [0, 0, 36, 36]
/** Documented safe area: where the official 36x36 set keeps its optical footprint. */
const SAFE_MIN = 6
const SAFE_MAX = 31.5
/** npm packages and the renderer both choke on large resources. */
const MAX_BYTES = 256 * 1024
/** Raster sample used to measure geometry: 8x the 36-unit canvas. */
const SAMPLE = 288
/** Alpha (of 255) at or above which a sample counts as painted; drops edge fuzz. */
const INK_ALPHA = 8

/**
 * The official palette: every color the 15 icons extracted from the app asar
 * paint with. A color from outside this map is a style break, not a taste call.
 */
const PALETTE = new Map(
  Object.entries({
    // neutral ink, mask fill, and the one neutral gradient end in the set
    '#FFFFFF': 'neutral ink',
    '#000000': 'mask cut-out',
    '#E2E2E2': 'neutral gradient end',
    // blues: the dominant family
    '#7AC2FF': 'sky',
    '#7CB7FF': 'sky',
    '#7FB7FC': 'sky',
    '#6DB9FB': 'sky',
    '#69B9FF': 'sky',
    '#67C7FE': 'cyan-blue',
    '#6FB2EE': 'steel',
    '#86B8F5': 'steel',
    '#679EFE': 'accent',
    '#658EFF': 'accent',
    '#4D6BFE': 'primary',
    '#4A65E8': 'primary deep',
    '#4561EE': 'indigo',
    '#3F77D8': 'indigo',
    '#3E58D6': 'indigo deep',
    '#3650DE': 'indigo deep',
    '#324DE2': 'indigo deep',
    '#145AF3': 'blue strong',
    '#5269E1': 'periwinkle',
    // teals, cyans and mints
    '#108792': 'teal deep',
    '#37A6B1': 'teal',
    '#45D9E7': 'cyan',
    '#51CFDB': 'cyan',
    '#41E1AC': 'mint',
    '#6AECB6': 'mint',
    // violet and amber accents
    '#A797FC': 'lilac',
    '#A23AE7': 'violet',
    '#F2AF63': 'amber',
  }),
)

/**
 * The two shipped icons. 'stem' names the files written under .tmp-render/.
 *
 * 'reference' is the footprint a sharp/librsvg rasterization measured on this
 * final artwork at SAMPLE before native builds left the checkout. It is the
 * positive control for the pure-JS evaluator below: a disagreement means the
 * evaluator drifted, not that the icons changed (their artwork is final).
 */
const ICONS = [
  {
    // The package's own identity. Every component is now its own package, so this
    // row appears once and says what the pack is, not what any one feature does.
    label: 'package icon',
    path: 'icon.svg',
    stem: 'icon',
    reference: { left: 6.3, top: 6.1, right: 30.3, bottom: 29.0 },
  },
  {
    // The recovery component. It must own a DISTINCT drawing: an earlier split
    // shipped a byte copy of the package icon here, which is invisible in markup
    // checks (a valid icon is still a valid icon) and only the cross-icon
    // assertions below catch. The reference is from the verified artwork.
    label: 'recovery component icon',
    path: 'recover/icon.svg',
    stem: 'recover-icon',
    reference: { left: 6.4, top: 6.4, right: 29.6, bottom: 29.6 },
  },
  {
    // Window placement is its own package/component since the split, so the
    // Plugins list draws a second component icon beside its row. The reference is
    // a pixel-supersampled rasterization of THIS artwork (8 px/unit, 4x4
    // subsamples), not the analytic evaluator it cross-checks.
    label: 'window component icon',
    path: 'window/icon.svg',
    stem: 'window-icon',
    reference: { left: 6.0, top: 7.5, right: 31.0, bottom: 28.25 },
  },
]

/** Allowed distance, in 36-unit space, between the evaluator and the reference. */
const FOOTPRINT_TOLERANCE = 0.5

/** Elements that put ink on the canvas. */
const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path'])

/** Color-valued presentation attributes and inline style properties. */
const COLOR_PROPS = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color'])

// ---------------------------------------------------------------- markup utilities

/** Parse an attribute string into a lower-cased name -> value map. */
function attrsOf(source) {
  const attrs = new Map()
  for (const match of source.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.set(match[1].toLowerCase(), match[2] === undefined ? match[3] : match[2])
  }
  return attrs
}

/** Attribute body that does not stop at a '>' inside a quoted value. */
const BODY = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*?`

/** Every opening element in the markup, with parsed attributes. */
function elementsOf(markup) {
  const pattern = new RegExp('<([a-zA-Z][a-zA-Z0-9:_-]*)(' + BODY + ')/?>', 'g')
  const elements = []
  for (const match of markup.matchAll(pattern)) {
    elements.push({ name: match[1].toLowerCase(), attrs: attrsOf(match[2]) })
  }
  return elements
}

/** Normalize #rgb / #rrggbb to upper-case #RRGGBB; anything else is no palette literal. */
function normalizeHex(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (match === null) return null
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1]
  return '#' + digits.toUpperCase()
}

/** Judge one color value: palette member, neutral keyword, or offender. */
function judgeColor(value, used, offenders) {
  const trimmed = value.trim()
  if (trimmed === '') return
  if (/^(none|currentColor|transparent|inherit)$/.test(trimmed)) return
  if (/^url\(\s*#[^)]+\)$/.test(trimmed)) return
  const normalized = normalizeHex(trimmed)
  if (normalized !== null && PALETTE.has(normalized)) used.add(normalized)
  else offenders.add(trimmed)
}

/** Collect every painted color, and every color value outside the official palette. */
function colorsOf(markup) {
  const used = new Set()
  const offenders = new Set()
  // A hex literal anywhere outside url(#id) / href="#id" is a color; there the # starts
  // an id, and an id such as "abc" would otherwise read as the color #ABC.
  const scrubbed = markup
    .replace(/url\(\s*['"]?#[^)]*\)/g, 'url(#)')
    .replace(/((?:xlink:)?href\s*=\s*)(?:"#[^"]*"|'#[^']*')/gi, '$1"#')
  for (const match of scrubbed.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const normalized = normalizeHex(match[0])
    if (normalized !== null && PALETTE.has(normalized)) used.add(normalized)
    else offenders.add(match[0])
  }
  // Named colors and rgb()/hsl() only show up in presentation attributes or inline style.
  for (const element of elementsOf(markup)) {
    for (const [name, value] of element.attrs) {
      if (name === 'style') {
        for (const declaration of value.split(';')) {
          const parts = declaration.split(':')
          if (COLOR_PROPS.has((parts[0] === undefined ? '' : parts[0]).trim().toLowerCase())) {
            judgeColor(parts.slice(1).join(':'), used, offenders)
          }
        }
      } else if (COLOR_PROPS.has(name)) {
        judgeColor(value, used, offenders)
      }
    }
  }
  return { used: [...used].sort(), offenders: [...offenders].sort() }
}

/** Parse every linear gradient with its attribute map and stop count. */
function gradientsOf(markup) {
  const pattern = new RegExp('<linearGradient\\b(' + BODY + ')(?:/>|>([\\s\\S]*?)</linearGradient>)', 'gi')
  const gradients = []
  for (const match of markup.matchAll(pattern)) {
    const body = match[2] === undefined ? '' : match[2]
    gradients.push({ attrs: attrsOf(match[1]), stops: (body.match(/<stop\b/gi) || []).length })
  }
  return gradients
}

// ---------------------------------------------------------------- geometry evaluator

/**
 * Footprint measurement that does not need a rasterizer.
 *
 * The safe-area check is the reason this audit exists — it caught a spark that
 * reached y = 4.9 against a 6.0 floor — so it must never depend on a native
 * module being installed. This evaluator walks the markup, keeps the inheritable
 * presentation properties, and unions one axis-aligned box per painted element,
 * in 36-unit user space:
 *
 *   - rect/circle/ellipse/line/polyline/polygon are exact (rx/ry only round
 *     rect corners, which cannot change an axis-aligned box);
 *   - <path> is tokenized command by command. Cubics and quadratics are
 *     flattened into CURVE_STEPS points — never measured by their control
 *     points, which would overstate a Q/C box and false-fail — and A/a is
 *     converted from endpoint to centre parameterization and sampled, with the
 *     axis-tangent angles added exactly so the extreme points cannot be missed;
 *   - a stroked element grows by stroke-width / 2 on every side, because the
 *     stroke straddles the path. That is the envelope the rasterizer measured;
 *     a miter join can spike further (up to miterlimit x half-width) and both
 *     shipped icons use round joins, so the model is conservative but honest.
 *
 * Anything the evaluator cannot honour (a transform, a percentage length, a
 * painted element outside SHAPES) is reported as a problem, and the caller
 * fails the audit loudly instead of trusting a silently wrong number.
 */

/** Flattening steps per cubic/quadratic segment. */
const CURVE_STEPS = 64
/** Presentation defaults from SVG 2. */
const DEFAULT_FILL = '#000000'
const DEFAULT_STROKE = 'none'
const DEFAULT_STROKE_WIDTH = 1

/** Containers whose children are not painted where they sit. */
const NON_PAINTING = new Set([
  'defs',
  'clippath',
  'mask',
  'marker',
  'pattern',
  'symbol',
  'lineargradient',
  'radialgradient',
  'filter',
  'title',
  'desc',
  'metadata',
  'style',
  'script',
])

/** Elements that paint but that this evaluator cannot measure. */
const PAINTING_UNSUPPORTED = new Set(['use', 'image', 'text', 'tspan', 'textpath', 'foreignobject'])

/** Parse a plain user-unit length (a number with an optional px suffix); NaN when unsupported. */
function lengthOf(value) {
  if (value === undefined) return NaN
  const text = String(value).trim()
  const match = /^([+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?)(?:px)?$/i.exec(text)
  return match === null ? NaN : Number(match[1])
}

/** Read a length attribute; absent attributes take the SVG default, unsupported ones throw. */
function readLength(attrs, name, fallback) {
  if (!attrs.has(name)) {
    if (fallback === undefined) throw new Error('missing ' + name)
    return fallback
  }
  const value = lengthOf(attrs.get(name))
  if (!Number.isFinite(value)) throw new Error('unsupported ' + name + '="' + attrs.get(name) + '"')
  return value
}

/** Union two boxes ([minX, minY, maxX, maxY]) or one point into a growing box. */
function unionBox(box, other) {
  if (other === null) return box
  if (box === null) return [other[0], other[1], other[2], other[3]]
  return [
    Math.min(box[0], other[0]),
    Math.min(box[1], other[1]),
    Math.max(box[2], other[2]),
    Math.max(box[3], other[3]),
  ]
}

/** Grow a box by the same amount on every side (a centred stroke's half-width). */
function growBox(box, amount) {
  if (amount === 0) return box
  return [box[0] - amount, box[1] - amount, box[2] + amount, box[3] + amount]
}

/** Add the CURVE_STEPS points of a cubic Bezier; the start point is already in. */
function addCubic(x0, y0, x1, y1, x2, y2, x3, y3, add) {
  for (let step = 1; step <= CURVE_STEPS; step++) {
    const t = step / CURVE_STEPS
    const u = 1 - t
    add(
      u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3,
      u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3,
    )
  }
}

/** Add the CURVE_STEPS points of a quadratic Bezier; the start point is already in. */
function addQuadratic(x0, y0, x1, y1, x2, y2, add) {
  for (let step = 1; step <= CURVE_STEPS; step++) {
    const t = step / CURVE_STEPS
    const u = 1 - t
    add(u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2)
  }
}

/**
 * Add a sampled elliptical arc, following SVG's endpoint-to-centre
 * parameterization (appendix F.6). The points where the ellipse is tangent to
 * an axis are added exactly as well: on a 36-unit canvas a sampled arc can miss
 * a true extreme by a few hundredths of a unit, and the exact points keep the
 * measurement rasterizer-grade.
 */
function addArc(x0, y0, x1, y1, rx, ry, rotation, largeArc, sweep, add) {
  if (x0 === x1 && y0 === y1) return
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx === 0 || ry === 0) {
    add(x1, y1)
    return
  }
  const phi = (rotation * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x0 - x1) / 2
  const dy = (y0 - y1) / 2
  const px = cos * dx + sin * dy
  const py = -sin * dx + cos * dy
  // F.6.6.2: radii too small for the endpoints are scaled up until they fit.
  const expansion = (px * px) / (rx * rx) + (py * py) / (ry * ry)
  if (expansion > 1) {
    const scale = Math.sqrt(expansion)
    rx *= scale
    ry *= scale
  }
  const rx2 = rx * rx
  const ry2 = ry * ry
  const denominator = rx2 * py * py + ry2 * px * px
  const numerator = rx2 * ry2 - denominator
  // The + sign is chosen when the flags differ, the - sign when they agree.
  const factor = Math.sqrt(Math.max(0, numerator) / denominator) * (largeArc === sweep ? -1 : 1)
  const centreXp = factor * ((rx * py) / ry)
  const centreYp = factor * (-(ry * px) / rx)
  const cx = cos * centreXp - sin * centreYp + (x0 + x1) / 2
  const cy = sin * centreXp + cos * centreYp + (y0 + y1) / 2
  const ux = (px - centreXp) / rx
  const uy = (py - centreYp) / ry
  const vx = (-px - centreXp) / rx
  const vy = (-py - centreYp) / ry
  const start = Math.atan2(uy, ux)
  let delta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  if (sweep && delta < 0) delta += Math.PI * 2
  if (!sweep && delta > 0) delta -= Math.PI * 2
  const at = (angle) => {
    const cosAngle = Math.cos(angle)
    const sinAngle = Math.sin(angle)
    add(cx + rx * cosAngle * cos - ry * sinAngle * sin, cy + rx * cosAngle * sin + ry * sinAngle * cos)
  }
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 128)))
  for (let step = 1; step <= steps; step++) at(start + (delta * step) / steps)
  // dx/dt and dy/dt vanish at these angles: the ellipse's axis-tangent points.
  const tangentX = Math.atan2(-ry * sin, rx * cos)
  const tangentY = Math.atan2(ry * cos, rx * sin)
  const low = Math.min(start, start + delta)
  const high = Math.max(start, start + delta)
  for (const tangent of [tangentX, tangentX + Math.PI, tangentY, tangentY + Math.PI]) {
    const turn = Math.ceil((low - tangent) / (Math.PI * 2))
    const angle = tangent + turn * Math.PI * 2
    if (angle >= low - 1e-9 && angle <= high + 1e-9) at(angle)
  }
  add(x1, y1)
}

/**
 * Measure one <path> 'd' attribute: [minX, minY, maxX, maxY], or null when the
 * path paints no point. Throws on anything it cannot honour — unknown commands,
 * malformed data, coordinates after Z — so the caller can fail loudly.
 */
function pathBox(data) {
  const source = String(data)
  const first = source.trim()[0]
  if (first !== undefined && !/[Mm]/.test(first)) {
    throw new Error('path data must start with a moveto, found "' + first + '" in "' + source + '"')
  }
  const length = source.length
  let index = 0
  const skip = () => {
    while (index < length && (source[index] === ',' || /\s/.test(source[index]))) index += 1
  }
  const hasMore = () => {
    skip()
    return index < length
  }
  const number = () => {
    skip()
    const match = /^[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/.exec(source.slice(index))
    if (match === null) throw new Error('expected a number at offset ' + index + ' of "' + source + '"')
    index += match[0].length
    return Number(match[0])
  }
  const flag = () => {
    skip()
    const character = source[index]
    if (character !== '0' && character !== '1') throw new Error('expected an arc flag at offset ' + index)
    index += 1
    return character === '1'
  }
  let box = null
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('non-finite coordinate in "' + source + '"')
    box =
      box === null
        ? [x, y, x, y]
        : [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]
  }
  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  let command = null
  let cubic = null
  let quadratic = null
  while (hasMore()) {
    const character = source[index]
    if (/[a-zA-Z]/.test(character)) {
      if (!/[MmZzLlHhVvCcSsQqTtAa]/.test(character)) throw new Error('unsupported path command "' + character + '"')
      command = character
      index += 1
    } else if (command === null) {
      throw new Error('path data must start with a command')
    } else if (command === 'Z' || command === 'z') {
      throw new Error('coordinates after close (Z)')
    } else if (command === 'M') {
      command = 'L'
    } else if (command === 'm') {
      command = 'l'
    }
    const relative = command === command.toLowerCase()
    const place = (dx, dy) => (relative ? [x + dx, y + dy] : [dx, dy])
    switch (command.toUpperCase()) {
      case 'M': {
        const point = place(number(), number())
        x = point[0]
        y = point[1]
        startX = x
        startY = y
        add(x, y)
        cubic = null
        quadratic = null
        break
      }
      case 'L': {
        const point = place(number(), number())
        x = point[0]
        y = point[1]
        add(x, y)
        cubic = null
        quadratic = null
        break
      }
      case 'H': {
        const value = number()
        x = relative ? x + value : value
        add(x, y)
        cubic = null
        quadratic = null
        break
      }
      case 'V': {
        const value = number()
        y = relative ? y + value : value
        add(x, y)
        cubic = null
        quadratic = null
        break
      }
      case 'C': {
        const control1 = place(number(), number())
        const control2 = place(number(), number())
        const point = place(number(), number())
        addCubic(x, y, control1[0], control1[1], control2[0], control2[1], point[0], point[1], add)
        cubic = control2
        quadratic = null
        x = point[0]
        y = point[1]
        break
      }
      case 'S': {
        const control2 = place(number(), number())
        const point = place(number(), number())
        const control1 = cubic === null ? [x, y] : [2 * x - cubic[0], 2 * y - cubic[1]]
        addCubic(x, y, control1[0], control1[1], control2[0], control2[1], point[0], point[1], add)
        cubic = control2
        quadratic = null
        x = point[0]
        y = point[1]
        break
      }
      case 'Q': {
        const control = place(number(), number())
        const point = place(number(), number())
        addQuadratic(x, y, control[0], control[1], point[0], point[1], add)
        quadratic = control
        cubic = null
        x = point[0]
        y = point[1]
        break
      }
      case 'T': {
        const point = place(number(), number())
        const control = quadratic === null ? [x, y] : [2 * x - quadratic[0], 2 * y - quadratic[1]]
        addQuadratic(x, y, control[0], control[1], point[0], point[1], add)
        quadratic = control
        cubic = null
        x = point[0]
        y = point[1]
        break
      }
      case 'A': {
        const rx = number()
        const ry = number()
        const rotation = number()
        const largeArc = flag()
        const sweep = flag()
        const point = place(number(), number())
        addArc(x, y, point[0], point[1], rx, ry, rotation, largeArc, sweep, add)
        cubic = null
        quadratic = null
        x = point[0]
        y = point[1]
        break
      }
      case 'Z': {
        x = startX
        y = startY
        add(x, y)
        cubic = null
        quadratic = null
        break
      }
      default:
        throw new Error('unsupported path command "' + command + '"')
    }
  }
  return box
}

/** The axis-aligned box of one shape before its stroke, or null when it paints nothing. */
function shapeBox(name, attrs) {
  switch (name) {
    case 'rect': {
      const x = readLength(attrs, 'x', 0)
      const y = readLength(attrs, 'y', 0)
      const width = Math.abs(readLength(attrs, 'width'))
      const height = Math.abs(readLength(attrs, 'height'))
      return width === 0 || height === 0 ? null : [x, y, x + width, y + height]
    }
    case 'circle': {
      const cx = readLength(attrs, 'cx', 0)
      const cy = readLength(attrs, 'cy', 0)
      const r = Math.abs(readLength(attrs, 'r'))
      return r === 0 ? null : [cx - r, cy - r, cx + r, cy + r]
    }
    case 'ellipse': {
      const cx = readLength(attrs, 'cx', 0)
      const cy = readLength(attrs, 'cy', 0)
      const rx = Math.abs(readLength(attrs, 'rx'))
      const ry = Math.abs(readLength(attrs, 'ry'))
      return rx === 0 || ry === 0 ? null : [cx - rx, cy - ry, cx + rx, cy + ry]
    }
    case 'line': {
      const x1 = readLength(attrs, 'x1', 0)
      const y1 = readLength(attrs, 'y1', 0)
      const x2 = readLength(attrs, 'x2', 0)
      const y2 = readLength(attrs, 'y2', 0)
      return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)]
    }
    case 'polyline':
    case 'polygon': {
      const points = attrs.get('points')
      if (points === undefined) throw new Error('missing points')
      const values = [...String(points).matchAll(/[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g)].map((match) => Number(match[0]))
      if (values.length === 0) return null
      if (values.length % 2 !== 0) throw new Error('odd number of point coordinates')
      let box = null
      for (let index = 0; index < values.length; index += 2) {
        const x = values[index]
        const y = values[index + 1]
        box = unionBox(box, [x, y, x, y])
      }
      return box
    }
    case 'path': {
      const data = attrs.get('d')
      if (data === undefined) throw new Error('missing d')
      return pathBox(data)
    }
    default:
      throw new Error('unsupported shape <' + name + '>')
  }
}

/** Merged attribute and inline-style map, lower-case names; an inline style wins. */
function presentationOf(attrs) {
  const properties = new Map(attrs)
  const style = attrs.get('style')
  if (style !== undefined) {
    for (const declaration of style.split(';')) {
      const colon = declaration.indexOf(':')
      if (colon < 0) continue
      const name = declaration.slice(0, colon).trim().toLowerCase()
      if (name !== '') properties.set(name, declaration.slice(colon + 1).replace(/!\s*important/i, '').trim())
    }
  }
  return properties
}

/** Whether a paint value actually puts ink down at the given opacity. */
function paints(value, opacity) {
  if (value === undefined) return false
  const text = String(value).trim()
  if (text === '' || /^(none|transparent)$/i.test(text)) return false
  const alpha = Number.parseFloat(opacity)
  return !(Number.isFinite(alpha) && alpha <= 0)
}

/** Stroke width in user units; throws on anything that is not a plain length. */
function strokeWidthOf(value) {
  const text = String(value === undefined ? DEFAULT_STROKE_WIDTH : value).trim()
  if (text.includes('%')) throw new Error('percentage stroke-width is not supported')
  const width = Number.parseFloat(text)
  if (!Number.isFinite(width) || width < 0) throw new Error('unsupported stroke-width "' + text + '"')
  return width
}

/**
 * Measure every painted element and return the union box, the elements, and
 * everything the evaluator could not honour. Nesting is tracked so inherited
 * fill/stroke behave, and <defs> subtrees are skipped where they sit.
 */
function measureSvg(markup) {
  const elements = []
  const problems = []
  const transforms = []
  const stack = []
  const pattern = new RegExp('<\\s*(/?)\\s*([a-zA-Z][a-zA-Z0-9:_-]*)(' + BODY + ')\\s*(/?)\\s*>', 'g')
  let state = {
    fill: DEFAULT_FILL,
    stroke: DEFAULT_STROKE,
    strokeWidth: DEFAULT_STROKE_WIDTH,
    fillOpacity: 1,
    strokeOpacity: 1,
    visibility: 'visible',
    hidden: false,
  }
  let inert = 0
  for (const match of markup.matchAll(pattern)) {
    const name = match[2].toLowerCase()
    const selfClosing = match[4] === '/' || /\/\s*>$/.test(match[0])
    if (match[1] === '/') {
      const previous = stack.pop()
      if (previous !== undefined) {
        state = previous.state
        inert = previous.inert
      }
      continue
    }
    const attrs = attrsOf(match[3])
    if (attrs.has('transform')) transforms.push(name + ' transform="' + attrs.get('transform') + '"')
    // A nested <svg> is a new viewport: its children are in other units, and
    // measuring them as if they were in the outer one would be silently wrong.
    const nestedViewport = name === 'svg' && stack.length > 0
    if (nestedViewport) problems.push('nested <svg> viewport is not supported by the geometry evaluator')
    const opening = state
    const properties = presentationOf(attrs)
    const skipped = inert > 0 || NON_PAINTING.has(name) || nestedViewport
    if (!skipped) {
      const effective = {
        fill: properties.has('fill') ? properties.get('fill').trim() : opening.fill,
        stroke: properties.has('stroke') ? properties.get('stroke').trim() : opening.stroke,
        strokeWidth: properties.has('stroke-width') ? properties.get('stroke-width').trim() : opening.strokeWidth,
        fillOpacity: properties.has('fill-opacity') ? properties.get('fill-opacity').trim() : opening.fillOpacity,
        strokeOpacity: properties.has('stroke-opacity') ? properties.get('stroke-opacity').trim() : opening.strokeOpacity,
        visibility: properties.has('visibility') ? properties.get('visibility').trim() : opening.visibility,
        hidden:
          opening.hidden ||
          (properties.has('display') && properties.get('display').trim() === 'none') ||
          (properties.has('opacity') && Number.parseFloat(properties.get('opacity')) === 0) ||
          (properties.has('fill-opacity') && Number.parseFloat(properties.get('fill-opacity')) === 0 &&
            properties.has('stroke-opacity') && Number.parseFloat(properties.get('stroke-opacity')) === 0),
      }
      if (SHAPES.has(name)) {
        try {
          const shape = shapeBox(name, attrs)
          const fill = paints(effective.fill, effective.fillOpacity)
          const stroke = paints(effective.stroke, effective.strokeOpacity)
          const strokeWidth = stroke ? strokeWidthOf(effective.strokeWidth) : 0
          const invisible = effective.hidden || /^(hidden|collapse)$/i.test(effective.visibility)
          if (!invisible && shape !== null && (fill || strokeWidth > 0)) {
            elements.push({
              name: name,
              box: strokeWidth > 0 ? growBox(shape, strokeWidth / 2) : shape,
              strokeWidth: strokeWidth,
            })
          }
        } catch (error) {
          problems.push('<' + name + '>: ' + error.message)
        }
      } else if (PAINTING_UNSUPPORTED.has(name)) {
        problems.push('<' + name + '> is not supported by the geometry evaluator')
      }
      if (!selfClosing) {
        stack.push({ state: opening, inert: inert })
        state = effective
      }
    } else if (!selfClosing) {
      stack.push({ state: opening, inert: inert })
      inert += 1
    }
  }
  let box = null
  for (const element of elements) box = unionBox(box, element.box)
  return {
    box: box,
    painted: elements.length,
    stroked: elements.filter((element) => element.strokeWidth > 0).length,
    elements: elements,
    problems: problems,
    transforms: transforms,
  }
}

/** Render a box the way the report prints footprints. */
function formatBox(box) {
  if (box === null || box === undefined) return 'none'
  return 'x ' + box[0].toFixed(1) + '..' + box[2].toFixed(1) + ' y ' + box[1].toFixed(1) + '..' + box[3].toFixed(1)
}

// ---------------------------------------------------------------- rasterization

/**
 * Locate a sharp build for the raster checks.
 *
 * sharp is deliberately NOT a dependency of this package (it ships zero
 * dependencies and the Host resolves it), so nothing guarantees a copy next to
 * the icon. The candidates are, in order: an explicit override, a build
 * extracted from the app asar into this checkout's .tmp-native, a copy
 * resolvable from the package itself, and the profile's own install. When none
 * loads, the raster checks report `skip` — the markup rules, which are the
 * ones that bind, still run and still fail.
 */
const RENDER_REQUIRE_ROOTS = process.env.DSH_ICON_RENDER_ROOT
  ? [process.env.DSH_ICON_RENDER_ROOT]
  : [
      new URL('.tmp-native/', root),
      root,
      'file:///C:/Users/notpdpton/.dsh/profiles/desktop/',
    ]
let sharp = null
let sharpError = null
for (const candidate of RENDER_REQUIRE_ROOTS) {
  try {
    sharp = createRequire(candidate)('sharp')
    sharpError = null
    break
  } catch (error) {
    sharpError = error
  }
}

/** Human-readable description of where the renderer was looked for. */
const RENDER_SEARCH = RENDER_REQUIRE_ROOTS.map((entry) => String(entry)).join(', ')

/** Composite the icon onto the light Plugins-page background at exactly size px. */
async function renderEvidence(buffer, size) {
  return sharp(buffer, { density: 300 })
    .resize(size, size, { fit: 'contain', background: '#f4f6fa' })
    .flatten({ background: '#f4f6fa' })
    .png()
    .toBuffer()
}

/**
 * Rasterize on a transparent 8x canvas and measure where the painted pixels
 * land, in 36-unit icon space, plus the share of the canvas they cover.
 */
async function measureFootprint(buffer) {
  const { data, info } = await sharp(buffer, { density: 72 * (SAMPLE / 36) })
    .resize(SAMPLE, SAMPLE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  let minX = Infinity
  let minY = Infinity
  let maxX = -1
  let maxY = -1
  let painted = 0
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] < INK_ALPHA) continue
      painted++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const unit = 36 / info.width
  return {
    ink: (painted / (info.width * info.height)) * 100,
    left: painted === 0 ? null : minX * unit,
    top: painted === 0 ? null : minY * unit,
    right: painted === 0 ? null : (maxX + 1) * unit,
    bottom: painted === 0 ? null : (maxY + 1) * unit,
  }
}

/** One sheet: a 128px preview plus the real 36px and 30px tiles, on the page background. */
async function writeContactSheet(rows, path) {
  const MARGIN = 16
  const PREVIEW = 128
  const tiles = []
  rows.forEach((row, index) => {
    const top = MARGIN + index * (PREVIEW + MARGIN)
    let left = MARGIN
    tiles.push({ input: row.preview, left: left, top: top })
    left += PREVIEW + MARGIN
    for (const tile of row.sizes) {
      tiles.push({ input: tile.png, left: left, top: top + (PREVIEW - tile.size) / 2 })
      left += tile.size + MARGIN
    }
  })
  const width = MARGIN * 4 + PREVIEW + 36 + 30
  const height = MARGIN + rows.length * (PREVIEW + MARGIN)
  const sheet = await sharp({ create: { width: width, height: height, channels: 4, background: '#f4f6fa' } })
    .composite(tiles)
    .png()
    .toBuffer()
  writeFileSync(path, sheet)
}

// ---------------------------------------------------------------- read the icons

const records = []
for (const icon of ICONS) {
  const file = new URL(icon.path, root)
  let stat = null
  try {
    stat = statSync(file)
  } catch {
    stat = null
  }
  const svg = stat === null ? null : readFileSync(file, 'utf8')
  const record = { label: icon.label, path: icon.path, stem: icon.stem, reference: icon.reference, stat: stat, svg: svg }
  record.buffer = svg === null ? null : Buffer.from(svg, 'utf8')
  if (svg !== null) {
    const markup = svg.replace(/<!--[\s\S]*?-->/g, '')
    const rootPattern = new RegExp('<svg\\b(' + BODY + ')>', 'i')
    const rootMatch = rootPattern.exec(markup)
    record.markup = markup
    record.elements = elementsOf(markup)
    record.rootAttrs = rootMatch === null ? null : attrsOf(rootMatch[1])
    record.svgTags = (markup.match(/<svg\b/gi) || []).length
    record.gradients = gradientsOf(markup)
    record.ids = record.elements.flatMap((element) => (element.attrs.has('id') ? [element.attrs.get('id')] : []))
    record.refs = [...markup.matchAll(/url\(\s*#([^)\s]+)\s*\)/g)].map((match) => match[1])
    record.colors = colorsOf(markup)
    record.shapes = record.elements.filter((element) => SHAPES.has(element.name)).length
  }
  records.push(record)
}

// ---------------------------------------------------------------- structure

console.log('-- structure')
for (const record of records) {
  const label = record.label
  check(label + ' exists', record.stat !== null && record.stat.isFile(), record.path)
  if (record.svg === null) continue
  check(label + ' is under the 256 KiB limit', record.stat.size < MAX_BYTES, record.stat.size + ' B')
  check(label + ' parses as a single <svg> root', record.rootAttrs !== null && record.svgTags === 1, record.svgTags + ' <svg> tags')
  check(
    label + ' declares the SVG namespace',
    record.rootAttrs === null ? false : record.rootAttrs.get('xmlns') === 'http://www.w3.org/2000/svg',
    record.rootAttrs === null ? 'no root' : record.rootAttrs.get('xmlns') || 'missing xmlns',
  )

  const viewBox = record.rootAttrs === null ? null : (record.rootAttrs.get('viewbox') || '').trim().split(/[\s,]+/).map(Number)
  check(
    label + ' uses the 36x36 viewBox',
    viewBox !== null && viewBox.length === 4 && viewBox.every((value, index) => value === VIEW_BOX[index]),
    record.rootAttrs === null ? 'no root' : record.rootAttrs.get('viewbox') || 'no viewBox',
  )

  const width = record.rootAttrs === null ? undefined : record.rootAttrs.get('width')
  const height = record.rootAttrs === null ? undefined : record.rootAttrs.get('height')
  const sized = [width, height].every((value) => value === undefined || /^36(?:px)?$/i.test(value.trim()))
  check(label + ' fixes no conflicting pixel size', sized, 'width=' + (width || '-') + ' height=' + (height || '-'))
}

// ---------------------------------------------------------------- self-containment

console.log('\n-- self-containment')
for (const record of records) {
  if (record.svg === null) continue
  const label = record.label
  const markup = record.markup
  const withoutNamespaces = markup.replace(/xmlns(?::[\w-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/g, '')

  check(label + ' embeds no raster payload', !/<image\b/i.test(markup) && !/;base64,|data:image\//i.test(markup))
  check(label + ' embeds no script or event handler', !/<script\b/i.test(markup) && !/\son[a-z]+\s*=/i.test(markup))
  check(
    label + ' references nothing external',
    !/https?:\/\//i.test(withoutNamespaces) && !/\bhref\s*=/i.test(withoutNamespaces) && !/url\(\s*['"]?(?:https?:|data:)/i.test(markup),
  )
  check(label + ' ships no stylesheet', !/<style\b/i.test(markup) && !/<\?xml-stylesheet/i.test(markup))
  check(label + ' paints no text', !/<text\b|<tspan\b|<textPath\b|<foreignObject\b/i.test(markup))
  const animatedStyle = record.elements.some((element) => /\b(animation|transition)\s*:/i.test(element.attrs.get('style') || ''))
  check(
    label + ' is static (no animation)',
    !/<animate\b|<animateTransform\b|<animateMotion\b|<set\b|<mpath\b|<discard\b/i.test(markup) && !animatedStyle,
  )
}

// ---------------------------------------------------------------- gradients

console.log('\n-- gradients')
for (const record of records) {
  if (record.svg === null) continue
  const label = record.label
  check(label + ' uses linear gradients only', !/<radialGradient\b/i.test(record.markup))

  const wrongUnits = record.gradients.filter((gradient) => gradient.attrs.get('gradientunits') !== 'userSpaceOnUse')
  check(
    label + ' gradients are userSpaceOnUse',
    wrongUnits.length === 0,
    wrongUnits.map((gradient) => gradient.attrs.get('gradientunits') || 'missing gradientUnits').join(', '),
  )

  const thin = record.gradients.filter((gradient) => gradient.stops < 2)
  check(label + ' gradients have at least two stops', thin.length === 0, thin.length + ' gradient(s) with < 2 stops')

  const dangling = record.refs.filter((id) => !record.ids.includes(id))
  check(label + ' gradient references resolve', dangling.length === 0, dangling.map((id) => '#' + id).join(', '))

  const gradientFilled = record.elements.filter((element) => (element.attrs.get('fill') || '').startsWith('url(#')).length
  const totalStops = record.gradients.reduce((sum, gradient) => sum + gradient.stops, 0)
  note(
    label + ' gradients: ' + record.gradients.length + ' linear, ' + totalStops + ' stops',
    gradientFilled === 0 ? 'no shape is gradient-filled' : gradientFilled + ' shape(s) gradient-filled',
  )
}

// ---------------------------------------------------------------- identifiers

console.log('\n-- identifiers')
for (const record of records) {
  if (record.svg === null) continue
  const duplicates = record.ids.filter((id, index) => record.ids.indexOf(id) !== index)
  check(record.label + ' ids are unique', duplicates.length === 0, duplicates.map((id) => '#' + id).join(', '))
}
// Every pair, not just the first two: once the icon set grew past two files, a
// check written against indices 0 and 1 silently stopped covering the rest — and
// a component that shipped a copy of the package icon is exactly the regression
// that hides from the per-file rules, because a copied icon is still a valid icon.
const present = records.filter((record) => record.svg !== null)
if (present.length === ICONS.length) {
  for (let i = 0; i < present.length; i++) {
    for (let j = i + 1; j < present.length; j++) {
      const shared = present[i].ids.filter((id) => present[j].ids.includes(id))
      check(
        present[i].label + ' and ' + present[j].label + ' share no id (no collision when inlined)',
        shared.length === 0,
        shared.map((id) => '#' + id).join(', '),
      )
      // Two icons painted from one drawing make the Plugins list show the same
      // picture twice, so the row the user is toggling is ambiguous.
      check(
        present[i].label + ' and ' + present[j].label + ' are distinct artwork',
        present[i].svg !== present[j].svg,
        present[i].svg === present[j].svg ? 'byte-identical files' : undefined,
      )
    }
  }
}

// ---------------------------------------------------------------- palette

console.log('\n-- palette')
for (const record of records) {
  if (record.svg === null) continue
  check(record.label + ' uses only official palette colors', record.colors.offenders.length === 0, record.colors.offenders.join(', '))
  note(record.label + ' colors (' + record.colors.used.length + ')', record.colors.used.join(' '))
}

// ---------------------------------------------------------------- geometry

console.log('\n-- geometry')
// The footprint comes from the pure-JS evaluator, so these checks run
// everywhere — a clean checkout with no native modules included. The rasterizer
// is only an optional cross-check and source of render evidence; its absence is
// reported as a skip rather than silently trusted.
for (const record of records) {
  if (record.svg === null) continue
  record.measurement = measureSvg(record.markup)
  record.footprint = record.measurement.box
}

// Positive control: the evaluator has to reproduce what the rasterizer measured
// on this final artwork. If it does not, its numbers are wrong and the safe-area
// check below would be measuring the wrong thing.
for (const record of records) {
  if (record.svg === null) continue
  const reference = record.reference
  const referenceBox = [reference.left, reference.top, reference.right, reference.bottom]
  const box = record.footprint
  const delta =
    box === null
      ? null
      : [box[0] - reference.left, box[1] - reference.top, box[2] - reference.right, box[3] - reference.bottom]
  check(
    record.label + ' footprint matches the rasterized reference (±' + FOOTPRINT_TOLERANCE + ')',
    delta !== null && delta.every((value) => Math.abs(value) <= FOOTPRINT_TOLERANCE),
    (box === null ? 'nothing painted' : formatBox(box) + ' vs reference ' + formatBox(referenceBox)) +
      (delta === null ? '' : ' (Δ ' + delta.map((value) => value.toFixed(2)).join(', ') + ')'),
  )
}

for (const record of records) {
  if (record.svg === null) continue
  const measurement = record.measurement
  const box = record.footprint
  check(
    record.label + ' declares no transform',
    measurement.transforms.length === 0,
    measurement.transforms.join(', ') || 'none',
  )
  check(
    record.label + ' uses only geometry the evaluator can measure',
    measurement.problems.length === 0,
    measurement.problems.join('; ') || 'none',
  )
  check(
    record.label + ' paints a visible footprint',
    box !== null && box[2] > box[0] && box[3] > box[1],
    box === null ? 'nothing painted' : formatBox(box),
  )
  check(
    record.label + ' footprint stays inside the ' + SAFE_MIN + '..' + SAFE_MAX + ' safe area',
    box !== null && box[0] >= SAFE_MIN && box[1] >= SAFE_MIN && box[2] <= SAFE_MAX && box[3] <= SAFE_MAX,
    box === null ? 'nothing painted' : formatBox(box),
  )
  const stroked = measurement.elements.filter((element) => element.strokeWidth > 0)
  note(
    record.label + ' painted elements',
    measurement.painted + ' measured' +
      (stroked.length === 0
        ? ', no stroke'
        : ', ' + stroked.length + ' stroked (half-width ' +
          stroked.map((element) => (element.strokeWidth / 2).toFixed(1)).join(', ') + ' included)'),
  )
}

// Optional raster cross-check: same final artwork, two independent measurements.
if (sharp === null) {
  skip('raster cross-check of the footprint (±' + FOOTPRINT_TOLERANCE + ')', 'no sharp at ' + RENDER_SEARCH)
} else {
  note('icon renderer available (sharp)', 'vips ' + (sharp.versions?.vips ?? 'unknown'))
  for (const record of records) {
    if (record.svg === null) continue
    const raster = await measureFootprint(record.buffer)
    record.raster = raster
    const box = record.footprint
    const agrees =
      box !== null &&
      raster.left !== null &&
      Math.abs(box[0] - raster.left) <= FOOTPRINT_TOLERANCE &&
      Math.abs(box[1] - raster.top) <= FOOTPRINT_TOLERANCE &&
      Math.abs(box[2] - raster.right) <= FOOTPRINT_TOLERANCE &&
      Math.abs(box[3] - raster.bottom) <= FOOTPRINT_TOLERANCE
    check(
      record.label + ' rasterizer agrees with the evaluator (±' + FOOTPRINT_TOLERANCE + ')',
      agrees,
      (raster.left === null ? 'nothing painted' : formatBox([raster.left, raster.top, raster.right, raster.bottom])) + ' rasterized',
    )
  }
}

// ---------------------------------------------------------------- render

console.log('\n-- render')
const rendered = []
if (sharp !== null) mkdirSync(renderDir, { recursive: true })
for (const record of records) {
  if (record.svg === null) continue
  if (sharp === null) {
    skip(record.label + ' 36px/30px render', 'no sharp at ' + RENDER_SEARCH)
    continue
  }
  const sizes = []
  for (const size of [36, 30]) {
    const png = await renderEvidence(record.buffer, size)
    writeFileSync(join(renderDir, record.stem + '-' + size + '.png'), png)
    const metadata = await sharp(png).metadata()
    check(
      record.label + ' renders at ' + size + 'px',
      metadata.width === size && metadata.height === size,
      '.tmp-render/' + record.stem + '-' + size + '.png (' + png.byteLength + ' B)',
    )
    sizes.push({ size: size, png: png })
  }
  const preview = await renderEvidence(record.buffer, 128)
  writeFileSync(join(renderDir, record.stem + '-preview.png'), preview)
  rendered.push({ preview: preview, sizes: sizes })
  console.log('  wrote .tmp-render/' + record.stem + '-36.png, .tmp-render/' + record.stem + '-30.png, .tmp-render/' + record.stem + '-preview.png')
}
if (sharp !== null && rendered.length > 0) {
  await writeContactSheet(rendered, join(renderDir, 'icons-sheet.png'))
  console.log('  wrote .tmp-render/icons-sheet.png (128px preview + real 36px/30px tiles)')
}

// ---------------------------------------------------------------- report

console.log('\n-- report')
for (const record of records) {
  if (record.svg === null) continue
  const box = record.footprint
  const span = box === null ? 'footprint none' : 'footprint ' + formatBox(box)
  const viewBox = record.rootAttrs === null ? 'no viewBox' : record.rootAttrs.get('viewbox') || 'no viewBox'
  console.log(
    '  ' +
      record.path.padEnd(16) +
      ' viewBox ' + viewBox.padEnd(11) +
      ' ' + span.padEnd(48) +
      ' shapes ' + record.shapes +
      '  gradients ' + record.gradients.length +
      '  colors ' + (record.colors.used.length + record.colors.offenders.length) +
      '  ' + record.stat.size + ' B',
  )
}

console.log(failures === 0 ? '\nOK: icon audit passes' : '\nFAIL: ' + failures + ' failures' + (skipped === 0 ? '' : ' (' + skipped + ' checks skipped)'))
process.exit(failures === 0 ? 0 : 1)