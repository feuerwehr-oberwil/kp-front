// English copy · «Üben», the topics and their steps on the private practice Einsatz.
// One slice of the `en` overlay, assembled in ../en.ts; the German base is ../de/ueben.ts.

import type { Copy, Localizable } from '../index'

export const uebenCopy: Localizable<Pick<Copy, 'ueben'>> = {
  ueben: {
    menu: 'Practice',
    sheetLead: 'On a practice site on this device only. Nothing reaches the incident.',
    next: 'Up next',
    nextGo: 'Start',
    allDrills: 'All exercises',
    stepCount: '{n} / {total}',
    steps: '{total} short steps',
    nextStep: 'Continue with «{step}»',
    doneMark: 'Done',
    free: 'Free practice',
    freeSub: 'Practice site without a task – try anything',
    tryOut: 'Try it on the practice site',
    kicker: '{topic} · {i} / {n}',
    show: 'Show',
    showMore: 'Show more',
    solve: 'Solution',
    hideHint: 'Hide',
    closeFirst: 'Close this first',
    more: 'More',
    restart: 'Start over',
    leave: 'Leave practice',
    doneSolved: 'Done with the solution – to practise, just do it again.',
    doneNext: 'Continue',
    doneAgain: 'Again',
    doneList: 'All exercises',
    endTitle: '{topic} done',
    moreTitle: 'What else there is',
    idleTitle: 'Practice site',
    idleText: 'On this device only – no other device and no incident list sees it.',
    idlePick: 'Choose an exercise',
    restartTitle: 'Start the practice site over?',
    restartMessage: 'The practice site’s map, log, teams and report are deleted. Real incidents are not affected.',
    restartConfirm: 'Start over',
    localOnly: 'On this device only',
    siteMissing: '{name} is missing from the map – «Start over» restores the practice site',
    site: {
      hydrant: 'H1',
      eingang: 'Entrance',
    },
    introGo: 'Go',
    topics: {
      karte: {
        title: 'Map & drawing',
        intro: 'A vehicle, its hose lines and their connections: drawing on the map in six short steps. Each step builds on the one before.',
        more: [
          'Line end: arrow with stop (limit of spread) and section (the hose line divides)',
          'Line style: dashed, holding line, water drop zone – plus colour, width and text',
          'On the hose line: person, team, floor and contents',
          'On the symbol: name, rotation, count and floor',
          'More tools: area, cordon, note, measure and multi-select',
          'Lock: nothing moves by accident any more',
        ],
        hint: {
          karte: 'To the map',
          linePhone: 'Add › Line',
          lineTablet: 'Line',
          linePick: 'Choose Line',
          lineTap: 'Tap the hose line',
        },
        steps: {
          fahrzeug: {
            title: 'Place a vehicle',
            task: 'Place a vehicle at hydrant H1.',
            goals: {
              fahrzeug: 'Vehicle at hydrant H1',
            },
            learned: 'This is how you place every symbol: choose the symbol, tap the map. Dragging moves it.',
            far: 'Vehicle is {m} m from H1 – drag it closer to the hydrant',
            hint: {
              addPhone: 'Add › Vehicle, then tap beside H1',
              addTablet: 'Symbol › Vehicle, then tap beside H1',
              pick: 'Choose Vehicle',
              tapBeside: 'Tap beside H1',
              drag: 'Drag the vehicle to H1',
            },
          },
          leitung: {
            title: 'Hose line with arrow',
            task: 'Draw a hose line from the vehicle to the entrance and give it an arrow.',
            goals: {
              leitung: 'Hose line with arrow from the vehicle to the entrance',
            },
            learned: 'The arrow shows where the water flows. «Reverse direction» turns it without drawing again.',
            startFar: 'Hose line starts {m} m from the vehicle',
            endFar: 'Hose line ends {m} m short of the entrance',
            noArrow: 'Arrow missing – it shows where the water flows',
            arrowBack: 'Arrow points at the vehicle – the water flows to the entrance',
            hint: {
              draw: 'Start at the vehicle, drag to the entrance',
              fix: 'Drag a new line from the vehicle to the entrance',
              arrow: 'Line end: arrow',
              reverse: 'Reverse direction',
            },
          },
          verbinden: {
            title: 'Connect',
            task: 'Draw a second hose line from hydrant H1 to the vehicle and hold still on the vehicle until the blue ring is full. Then move the vehicle.',
            goals: {
              zubringer: 'Hose line connected to H1 and to the vehicle',
              mitziehen: 'Vehicle moved – the hose lines come along',
            },
            learned: 'A connected hose line moves with its vehicle. Starting on the symbol connects at once; at the end it needs the full ring.',
            looseVehicle: 'The hose line is not connected to the vehicle – draw it again and hold on the vehicle until the ring is full',
            looseH1: 'The hose line is not connected to the hydrant – draw it again and start right on H1',
            hint: {
              draw: 'Start on H1, drag to the vehicle and hold there until the ring is full',
              close: 'Close the hose line',
              move: 'Tap the vehicle, then drag',
            },
          },
          beschriften: {
            title: 'Label the hose line',
            task: 'Give the hose line to the entrance a number and a hose.',
            goals: {
              nummer: 'Hose line has a number',
              schlauch: 'Hose chosen',
            },
            learned: 'Number and hose stand on the map at the end of the line. In the same sheet: person, team, floor and text.',
            hint: {
              nummer: 'Line no.: +',
              schlauch: 'Choose the hose',
            },
          },
          punkte: {
            title: 'Points',
            task: 'Insert a point into the hose line to the entrance. Then remove a point.',
            goals: {
              einfuegen: 'Point inserted',
              entfernen: 'Point removed',
            },
            learned: 'Points lead a hose line round an obstacle: «+» inserts one, dragging moves it, holding removes it.',
            hint: {
              plus: 'Tap +: a new point',
              hold: 'Hold the point until the ring is full',
            },
          },
          loesen: {
            title: 'Release and remove',
            task: 'Release a hose line from the vehicle. Then remove it and bring it back with «Undo».',
            goals: {
              geloest: 'Connection released',
              geloescht: 'Hose line removed',
              zurueck: 'Brought back with «Undo»',
            },
            learned: '«Undo» takes back every step – on the map, with the teams and in attendance.',
            hint: {
              detach: 'Release the connection',
              remove: 'Remove',
              undo: 'Undo',
            },
          },
        },
      },
    },
  },
}
