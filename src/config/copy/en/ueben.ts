// English copy · «Üben», the drills on the private practice Einsatz.
// One slice of the `en` overlay, assembled in ../en.ts; the German base is ../de/ueben.ts.

import type { Copy, Localizable } from '../index'

export const uebenCopy: Localizable<Pick<Copy, 'ueben'>> = {
  ueben: {
    menu: 'Practice',
    sheetLead: 'On a practice site on this device only. Nothing reaches the incident.',
    next: 'Up next',
    nextGo: 'Start',
    allDrills: 'All drills',
    doneCount: '{n} of {total} done',
    soon: 'soon',
    doneMark: 'Done',
    kicker: '{module} · {i} / {n}',
    show: 'Show',
    showMore: 'Show more',
    solve: 'Solution',
    hideHint: 'Hide',
    more: 'More',
    restart: 'Start over',
    leave: 'Leave practice',
    doneTitle: 'Done',
    doneSolved: 'Done with the solution – to practise, just do it again.',
    doneNext: 'Next drill',
    doneAgain: 'Again',
    doneList: 'All drills',
    idleTitle: 'Practice site',
    idleText: 'On this device only – no other device and no incident list sees it.',
    idlePick: 'Choose a drill',
    restartTitle: 'Start the practice site over?',
    restartMessage: 'The practice site’s map, log, teams and report are deleted. Real incidents are not affected.',
    restartConfirm: 'Start over',
    localOnly: 'On this device only',
    siteMissing: '{name} is missing from the map – «Start over» restores the practice site',
    site: {
      hydrant: 'H1',
      eingang: 'Entrance',
    },
    modules: {
      karteWasser: 'Map & water',
      atemschutzGebaeude: 'SCBA & building',
      protokollAbschluss: 'Record & closing',
    },
    introGo: 'Go',
    drills: {
      fahrzeugLeitung: {
        title: 'Vehicle with hose line',
        intro: 'On the map, a hose line with an arrow shows where the water comes from and where it flows. You place a TLF beside a hydrant and lay the line from the TLF to the entrance.',
        task: 'Place the TLF beside hydrant H1 and lay a hose line with an arrow from the TLF to the entrance.',
        goals: {
          tlf: 'TLF beside hydrant H1',
          leitung: 'Hose line with arrow from the TLF to the entrance',
        },
        tlfFar: 'TLF is {m} m from H1 – too far for the hose to the hydrant',
        tlfOnTop: 'TLF is on top of the hydrant – place it beside',
        vehicleFar: 'Vehicle is {m} m from H1 – and not named «TLF» yet',
        startFar: 'Hose line starts {m} m from the TLF',
        endFar: 'Hose line ends {m} m short of the entrance',
        noArrow: 'Arrow missing – it shows where the water flows',
        arrowBack: 'Arrow points at the TLF – the water flows to the entrance',
        hint: {
          karte: 'To the map',
          addPhone: 'Add › Vehicle, then tap beside H1',
          addTablet: 'Symbol › Vehicle, then tap beside H1',
          pick: 'Choose Vehicle',
          tapBeside: 'Tap beside H1',
          tapVehicle: 'Tap the vehicle',
          name: 'Name: TLF',
          drag: 'Drag the TLF beside H1',
          linePhone: 'Add › Line, then drag from the TLF to the entrance',
          lineTablet: 'Line, then drag from the TLF to the entrance',
          linePick: 'Choose Line',
          lineDraw: 'Start at the TLF, drag to the entrance',
          lineFix: 'Drag a new line from the TLF to the entrance',
          lineTap: 'Tap the hose line',
          arrow: 'Line end: arrow',
          reverse: 'Reverse direction',
        },
      },
      absperrkreis: {
        title: 'Cordon circle',
      },
      messen: {
        title: 'Measure',
      },
      leitungRechnen: {
        title: 'Calculate a hose line',
      },
      pumpenVerschieben: {
        title: 'Move pumps',
      },
      truppAnmelden: {
        title: 'Register a team',
      },
      funkkontakt: {
        title: 'Radio contact & pressure',
      },
      rueckzug: {
        title: 'Withdrawal',
      },
      notfall: {
        title: 'SCBA emergency',
      },
      truppGeschoss: {
        title: 'Team on a storey',
      },
      gefahrUg: {
        title: 'Hazard in the basement',
      },
      eintrag: {
        title: 'Log entry',
      },
      pendenz: {
        title: 'Open item',
      },
      checkliste: {
        title: 'Checklist',
      },
      anwesenheit: {
        title: 'Attendance',
      },
      material: {
        title: 'Equipment',
      },
      fehlalarm: {
        title: 'Close a false alarm',
      },
    },
  },
}
