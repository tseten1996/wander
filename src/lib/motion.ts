/**
 * All framer-motion animation flows through this shim so the app ships only
 * LazyMotion's lightweight `domAnimation` feature bundle instead of the full
 * `motion` proxy — ~13 kB gzipped off the shared framer-motion chunk, which is
 * what brings the app back under its bundle budget (scripts/check-invariants.mjs).
 * It is safe because Wander uses only enter/animate/exit + transform/opacity
 * animations (there are no `layout` or `drag` animations anywhere), which
 * `domAnimation` fully covers.
 *
 * Aliasing `m as motion` keeps every call site's `motion.div` JSX unchanged —
 * `m` components animate via the `<LazyMotion features={domAnimation}>` ancestor
 * mounted in main.tsx. Import motion, AnimatePresence and useReducedMotion from
 * here, never straight from 'framer-motion' (that would re-bundle the full
 * feature set and undo the saving).
 */
export { m as motion, AnimatePresence, useReducedMotion } from 'framer-motion'
