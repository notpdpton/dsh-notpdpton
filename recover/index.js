/**
 * Host half of 异常中断恢复 (dsh-notpdpton-recover).
 *
 * The component contributes one session-projection unit named `interruption`. It
 * folds the durable session log into the small amount of state the browser needs
 * to answer two questions:
 *
 *   1. Did this Session end abnormally?
 *   2. What progress — including the todo list — had it reached?
 *
 * Doing this in a projection unit (rather than folding events in the browser) is
 * what makes the answer complete: the browser only ever holds a paged event
 * window, while this fold always sees every committed event. The unit declares a
 * `wire` view, so the value reaches the Client already computed and is cached by
 * the framework like every other projection.
 *
 * THE WIRE VIEW IS REFERENCE-STABLE, and that is load-bearing. The registry
 * publishes when consecutive `view` results differ by `Object.is`, and a publish
 * costs a Host control-stream frame, a Client store write, a whole Session-list
 * snapshot rebuild and a re-render of the open conversation. A live turn emits a
 * `step/start` and a `step/end` per tool call, and neither changes anything a
 * Client renders, so the fold tracks them in HOST-ONLY fields that the wire view
 * omits. Measured over a real 45-session corpus: 13,099 state changes, of which
 * 12,799 are step bookkeeping; 300 publications remain (0.6% of events, 2.9 KiB
 * per 1000 events) versus 12,799 before. Do not add a field to the wire shape
 * without also checking that the event producing it is one a Client must see.
 *
 * This module imports nothing. It is loaded from the profile, and the only
 * contract it needs from the Host is `ctx.sessionProjections.register`.
 *
 * @module dsh-notpdpton-recover
 */

/** Host plugin name, used in diagnostics. */
export const name = 'notpdpton'

/**
 * Hard dependency. Without the projection registry this feature has nothing to
 * contribute, so the plugin should stay inactive rather than activate into a
 * half-working state.
 */
export const inject = ['sessionProjections']

/** The projection key the Client reads. */
export const INTERRUPTION_KEY = 'interruption'

/**
 * Upper bound on todo items carried through one projection value.
 *
 * The wire value is cached and pushed to every browser, so it stays bounded: a
 * pathological list must not inflate every projection update.
 */
const MAX_TODOS = 100

/** Upper bound on one todo's content length in the wire value. */
const MAX_TODO_CONTENT = 300

/**
 * Validate one todo item, returning the bounded wire shape.
 *
 * @param item - candidate todo item from a `todo/write` event.
 * @returns the bounded item, or null when it is not a usable todo.
 */
function wireTodo(item) {
  if (typeof item !== 'object' || item === null) return null
  const status = item.status
  if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
  const content = typeof item.content === 'string' ? item.content : ''
  return {
    content: content.length > MAX_TODO_CONTENT ? `${content.slice(0, MAX_TODO_CONTENT)}…` : content,
    status,
  }
}

/**
 * State schema. The projection registry parses persisted checkpoint rows with
 * it, so a corrupted or stale row is rejected instead of silently restored.
 *
 * A plain `{ parse }` object is enough: the registry only ever calls `parse`, and
 * this unit produces plain JSON.
 */
const interruptionStateSchema = {
  parse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('interruption projection state must be an object')
    }
    if (typeof value.status !== 'string') {
      throw new TypeError('interruption projection state is missing status')
    }
    if (typeof value.turn !== 'number') {
      throw new TypeError('interruption projection state is missing turn')
    }
    if (!Array.isArray(value.todos)) {
      throw new TypeError('interruption projection state is missing todos')
    }
    return value
  },
}

/**
 * The initial fold state: a Session with no turn yet.
 *
 * A fresh object is returned on every call: a projection cell compares state by
 * reference, so sharing one frozen instance across Sessions would suppress change
 * publication.
 *
 * @returns a blank interruption state.
 */
function initialState() {
  return {
    /**
     * `none` | `crash` | `interrupted` | `error` | `aborted` | `max-tokens` | `blocked`.
     * `crash` means the log's tail turn never closed; `interrupted` is the
     * harness's crash-repair marker (`turn/end { kind: 'interrupted' }`), which is
     * what a cold read of a crashed log carries.
     */
    status: 'none',
    /** Turn number of the tail turn (the open one for `crash`). */
    turn: 0,
    /** Closed-turn reason kind when the log is balanced, else null. */
    reason: null,
    /** Cancellation cause of an `aborted` turn (`user` / `parent` / `hook` / `disposed` / `legacy`). */
    abortCause: null,
    /** Failure code of an `error` turn. */
    errorCode: null,
    /** Failure message of an `error` turn. */
    errorMessage: null,
    /**
     * Whether the tail also sits inside an open step.
     *
     * HOST-ONLY: no Client renders this, and {@link wireInterruption} omits it.
     * It is kept because the harness's own crash accounting needs the same
     * distinction this fold makes, and the fold's tests pin it — but it must
     * never reach the wire, or every `step/start`/`step/end` in a live turn
     * would publish (96% of all publications measured over a real corpus: one
     * per tool call, each one a control-stream frame and a Client re-render).
     */
    openStep: false,
    /**
     * Whether the tail turn contains a model message the harness marked
     * `interrupted: true`.
     *
     * This is the one reliable way to tell a deliberate Stop from a shutdown
     * abort, because BOTH close the turn with `aborted` / cause `user`. The flag
     * is only written when a *cancelled stream* appends its delivered prefix, so
     * a user pressing Stop mid-answer sets it — while a turn killed between steps
     * (page refresh, app restart, reconnect) has no such message.
     */
    partialMessage: false,
    /** Whether the Session contains any turn at all. HOST-ONLY; see `openStep`. */
    hasTurns: false,
    /**
     * The todo list of the tail turn, as the harness's own `todos` projection
     * would show it: cleared by `turn/start`, replaced by every `todo/write`.
     * Captured here because the live `todos` projection clears as soon as the
     * continue message opens a new turn.
     */
    todos: [],
  }
}

/**
 * Fold one committed session event into the interruption state.
 *
 * The crash signature is an unbalanced tail: a `turn/start` whose `turn/end`
 * never arrived. A graceful close always balances the log (the agent loop's
 * teardown cancels with `{ kind: 'disposed' }` and its `finally` appends the
 * `turn/end`), so an open turn can only mean the writer died. Note that
 * `turn/end`'s `kind: 'interrupted'` is *not* the crash itself: the harness
 * writes that marker when it repairs a crashed log on resume, so it is an audit
 * trail rather than a live state.
 *
 * @param state - previous fold state.
 * @param event - committed session event.
 * @returns the next state, or the same reference for events this unit ignores.
 */
function foldInterruption(state, event) {
  switch (event.type) {
    case 'turn/start': {
      // A turn just opened. Until its `turn/end` lands the tail is "open", which
      // is exactly the interrupted shape. A genuinely running turn produces the
      // same fold, so the Client also checks the live Agent's running status
      // before showing anything.
      //
      // `todos` is deliberately CARRIED OVER here, unlike the harness's own
      // `todos` projection, which clears on `turn/start`: that projection answers
      // "the current turn's list", while this unit answers "the last plan the
      // agent recorded, i.e. the work to resume". The list written by an earlier
      // turn is exactly the progress a crashed tail turn needs.
      //
      // `partialMessage` starts fresh: it describes THIS turn only.
      return {
        ...initialState(),
        hasTurns: true,
        turn: event.data.turn,
        status: 'crash',
        todos: state.todos,
      }
    }
    case 'assistant/message': {
      // Only meaningful as a marker for how the enclosing turn will end.
      if (event.data?.interrupted !== true || state.partialMessage) return state
      return { ...state, partialMessage: true }
    }
    case 'turn/end': {
      const reason = event.data.reason ?? { kind: 'completed' }
      let status = 'none'
      let abortCause = null
      let errorCode = null
      let errorMessage = null
      switch (reason.kind) {
        case 'error':
          status = 'error'
          errorCode = reason.error?.code ?? null
          errorMessage = reason.error?.message ?? null
          break
        case 'aborted': {
          // `aborted` covers two very different events, and the recorded cause
          // cannot tell them apart. Pressing Stop records
          // `{ kind: 'aborted', reason: { kind: 'user' } }`, and so does every
          // non-UI path that stops a Session's work: the Workspace registry's
          // `workspace/session-stop` (an archived workspace, an app shutdown) calls
          // `agent.cancel({ kind: 'user' })` deliberately "the way the user's own
          // stop does". A turn killed that way is exactly the interruption this
          // feature exists to resume, so it must NOT be dismissed as a user choice.
          //
          // The discriminator is `partialMessage`. A turn stopped while the model
          // was streaming had a live stream to truncate, so the harness appends the
          // delivered prefix as an `interrupted: true` message. A turn killed between
          // steps has no stream in flight and therefore no such message.
          //
          // Positive samples for the Stop case are rare (this corpus has none), so
          // the default falls to `interrupted`: showing a resumable notice the user
          // does not need is harmless, while hiding one after a crash loses work.
          abortCause = reason.reason?.kind ?? null
          status = abortCause === 'user' && state.partialMessage ? 'aborted' : 'interrupted'
          break
        }
        case 'max-tokens':
          status = 'max-tokens'
          break
        case 'blocked':
          status = 'blocked'
          break
        case 'interrupted':
          // The harness's crash-repair marker. A cold read of a crashed log has
          // its open tail closed with this synthetic `turn/end` before any
          // projection sees it, so this IS the abnormal-interruption signal for
          // every stored Session — treating it as "clean" would hide the notice
          // in exactly the case the feature exists for. Live turns never produce
          // it (only `AgentLoop.resume` does), so it cannot be a false positive.
          status = 'interrupted'
          break
        default:
          status = 'none'
          break
      }
      return {
        ...state,
        status,
        turn: event.data.turn,
        reason: reason.kind,
        abortCause,
        errorCode,
        errorMessage,
        openStep: false,
        hasTurns: true,
      }
    }
    // Step bookkeeping is host-only (see `openStep`): carrying the previous wire
    // view forward is what stops these two cases from publishing. They are by far
    // the most frequent events in a live turn — one `step/start` and one
    // `step/end` per tool call — so without this they publish twice per tool.
    case 'step/start': {
      return state.status === 'crash' && !state.openStep ? withHostOnlyChange(state, { openStep: true }) : state
    }
    case 'step/end': {
      return state.status === 'crash' && state.openStep ? withHostOnlyChange(state, { openStep: false }) : state
    }
    case 'todo/write': {
      const raw = Array.isArray(event.data.todos) ? event.data.todos : []
      const todos = []
      for (const item of raw) {
        if (todos.length >= MAX_TODOS) break
        const todo = wireTodo(item)
        if (todo !== null) todos.push(todo)
      }
      return { ...state, todos }
    }
    default:
      return state
  }
}

/**
 * The fields a Client actually renders.
 *
 * Everything else in the fold state (`openStep`, `hasTurns`) is host-only
 * bookkeeping; `recover/client.js` reads exactly these eight and nothing more,
 * so a change confined to a host-only field is not a change anyone can observe.
 */
const WIRE_FIELDS = Object.freeze([
  'status',
  'turn',
  'reason',
  'abortCause',
  'errorCode',
  'errorMessage',
  'partialMessage',
  'todos',
])

/** Wire schema: the same shape as the state, minus the host-only fields. */
const interruptionViewSchema = {
  parse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('interruption projection view must be an object')
    }
    if (typeof value.status !== 'string') {
      throw new TypeError('interruption projection view is missing status')
    }
    if (typeof value.turn !== 'number') {
      throw new TypeError('interruption projection view is missing turn')
    }
    if (!Array.isArray(value.todos)) {
      throw new TypeError('interruption projection view is missing todos')
    }
    return value
  },
}

/**
 * Wire view per fold state, so a state can be viewed more than once for free.
 *
 * A WeakMap rather than a property on the state: the state is the registry's
 * value, other code spreads it, and `structuredClone` writes it into checkpoint
 * rows. Nothing here should be visible to any of those.
 */
const viewsByState = new WeakMap()

/**
 * Reference-stable wire view of one fold state.
 *
 * The registry publishes when consecutive `view` results differ by `Object.is`,
 * so this MUST return the previous object when nothing a Client can see changed.
 * The identity view it replaces published once per `step/start`/`step/end` —
 * measured over a real 45-session corpus, 97.7% of all 12.9k publications were
 * step bookkeeping that no Client renders, and each one costs a Host
 * control-stream frame, a Client store write, a whole Session-list snapshot
 * rebuild and a re-render of the conversation.
 *
 * A fresh view is built for any state that does not already carry one. Only
 * `step/start`/`step/end` — the two events that touch host-only fields and
 * nothing else — carry the previous state's view forward (see
 * {@link withHostOnlyChange}). That direction is deliberate: forgetting to carry
 * costs one harmless extra publication, while carrying a view across a wire
 * change would serve a stale value.
 *
 * @param state - the fold state.
 * @returns the view for this state, reused when it already exists.
 */
function wireInterruption(state) {
  const cached = viewsByState.get(state)
  if (cached !== undefined) return cached
  const view = {}
  for (const field of WIRE_FIELDS) view[field] = state[field]
  viewsByState.set(state, view)
  return view
}

/**
 * Build the next state for an event that changes ONLY host-only fields.
 *
 * The previous state's wire view travels with it, which is what keeps such an
 * event from publishing. The patch must not touch a field in
 * {@link WIRE_FIELDS}: this helper does not look at which fields changed, so a
 * wire field patched here would reuse a stale view.
 *
 * @param state - previous fold state.
 * @param patch - host-only fields to replace.
 * @returns the next state, sharing the previous wire view.
 */
function withHostOnlyChange(state, patch) {
  const next = { ...state, ...patch }
  const view = viewsByState.get(state)
  if (view !== undefined) viewsByState.set(next, view)
  return next
}

/**
 * Register the `interruption` projection unit.
 *
 * `wire` is required for the value to reach the Client; state without a wire
 * view stays host-only. `stateVersion` is part of every persisted checkpoint
 * row, so bumping it is how a fold-semantics change invalidates stale cached
 * rows.
 *
 * @param ctx - plugin context carrying the projection registry.
 */
function registerInterruptionProjection(ctx) {
  ctx.sessionProjections.register({
    key: INTERRUPTION_KEY,
    stateSchema: interruptionStateSchema,
    init: initialState,
    apply: foldInterruption,
    wire: {
      viewSchema: interruptionViewSchema,
      view: wireInterruption,
    },
    stateVersion: 2,
  })
}

/**
 * The plugin body.
 *
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  registerInterruptionProjection(ctx)
}

// Test seam: the offline verifier replays real stored logs through the exact
// fold the projection uses. The Loader only reads `apply`/`inject`, so these
// extra exports do not affect activation.
export { initialState, foldInterruption, interruptionStateSchema, interruptionViewSchema, wireInterruption }
