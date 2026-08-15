/**
 * All framer-motion animation flows through this shim so the app ships only
 * LazyMotion's lightweight `domAnimation` feature bundle instead of the full
 * `motion` proxy — ~13 kB gzipped off the shared framer-motion chunk, which is
 * what brings the app back under its bundle budget (scripts/check-invariants.mjs).
 * `domAnimation` covers enter/animate/exit + transform/opacity + gestures —
 * every animation Wander uses. It deliberately EXCLUDES framer-motion's
 * `layout` and `drag` features, which live only in the heavier `domMax`
 * bundle whose extra ~13 kB gzipped would blow the budget. The consequence
 * is a rule: no `m` component may use the `layout` or `drag` props — under
 * `<LazyMotion features={domAnimation}>` they are silent no-ops (no crash, no
 * warning). Two rows (checklist item, weather nudge) previously used `layout`
 * to smooth sibling reflow; that polish was dropped as the deliberate trade
 * for the budget when this shim landed — their enter/exit fades still play.
 *
 * Aliasing `m as motion` keeps every call site's `motion.div` JSX unchanged —
 * `m` components animate via the `<LazyMotion features={domAnimation}>` ancestor
 * mounted in main.tsx. Import motion, AnimatePresence and useReducedMotion from
 * here, never straight from 'framer-motion' (that would re-bundle the full
 * feature set and undo the saving).
 */
export { m as motion, AnimatePresence, useReducedMotion } from 'framer-motion'
