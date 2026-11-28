import { useLayoutEffect, useMemo, useRef } from 'react'

type Fn = (...args: never[]) => unknown

/**
 * A record of functions that keep ONE identity for the component's life and call the latest
 * version – what a parent hands a memo'd child, so its fresh closures on every render do not
 * render the child again (components/PlanAnno). A key whose function is undefined stays
 * undefined (whether a handler exists decides what a child offers); the record changes only
 * when that set of keys changes. A wrapper kept past that change – a window listener of a press
 * that began before the handler went away – does nothing.
 *
 * Call them from events or after the layout phase (a passive effect or its cleanup, e.g. a
 * field's unmount – NoteField · onEnd), not during render: they reach the functions of the last
 * committed render.
 */
export function useSteadyFns<T extends Record<string, Fn | undefined>>(fns: T): T {
  const latest = useRef(fns)
  useLayoutEffect(() => { latest.current = fns })
  // keyed on which handlers EXIST: the functions themselves are read through `latest`
  const shape = Object.keys(fns).filter((k) => fns[k]).join('|')
  return useMemo(() => {
    const out: Record<string, Fn> = {}
    for (const k of shape ? shape.split('|') : []) out[k] = (...args: never[]) => (latest.current[k] as Fn | undefined)?.(...args)
    return out as T
  }, [shape])
}
