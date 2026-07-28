import { appConfig } from '../config/appConfig'

/** Shared label set for <TimeBlockSheet>, so the Anwesenheit and the Zeitplan read the same
 *  words. Lives outside the component file so fast refresh keeps working there.
 *
 *  `remove` deliberately comes from the CALLER's own namespace via the argument — wiring the
 *  Zeitplan's «Schicht löschen» into an attendance block would label the wrong noun. */
export const timeBlockLabels = (remove: string) => ({
  from: appConfig.copy.anwesenheit.von,
  to: appConfig.copy.anwesenheit.bis,
  done: appConfig.copy.anwesenheit.done,
  remove,
  fromStart: appConfig.copy.zeitplan.fromStart,
  // «noch da» — the named clear inside a «bis» picker. Only the Anwesenheit ever offers it: a
  // shift always has an end, a person's presence does not.
  reopen: appConfig.copy.anwesenheit.stillHere,
  flip: appConfig.copy.anwesenheit.flip,
})
