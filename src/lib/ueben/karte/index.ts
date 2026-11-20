// «Üben» · Karte & Zeichnen: the topic. Six short steps on one scene, each building on the one
// before (owner pick, 20.11.2026): a Fahrzeug, its Leitung, the connection, the Leitung's
// attributes, its points, and letting go / removing / «Rückgängig». What the topic does not
// practise is named on its closing card (`copy.ueben.topics.karte.more`).

import type { Topic } from '../model'
import { beschriften } from './beschriften'
import { fahrzeug } from './fahrzeug'
import { leitung } from './leitung'
import { loesen } from './loesen'
import { punkte } from './punkte'
import { verbinden } from './verbinden'

export const karte = { id: 'karte', steps: [fahrzeug, leitung, verbinden, beschriften, punkte, loesen] } as const satisfies Topic
