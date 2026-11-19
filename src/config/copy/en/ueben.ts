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
      weiher: 'W',
      eingang: 'Entrance',
    },
    modules: {
      karteWasser: 'Map & water',
      atemschutzGebaeude: 'SCBA & building',
      protokollAbschluss: 'Record & closing',
    },
    drills: {
      fahrzeugLeitung: {
        title: 'Vehicle with hose line',
        task: 'The TLF stands at hydrant H1. Put it there and lay a hose line to the entrance.',
        goals: {
          tlf: 'TLF at hydrant H1',
          leitung: 'Hose line from the TLF to the entrance',
        },
        tlfFar: 'TLF is {m} m from H1',
        vehicleFar: 'Vehicle is {m} m from H1 – and not named «TLF» yet',
        nameIt: 'Placed. Now pick the name «TLF»',
        tlfFirst: 'The TLF first',
        startFar: 'Hose line starts {m} m from the TLF',
        endFar: 'Hose line ends {m} m short of the entrance',
        hint: {
          karte: 'To the map',
          addPhone: 'Add › Vehicle, then tap H1',
          addTablet: 'Symbol › Vehicle, then tap H1',
          pick: 'Choose Vehicle',
          tapH1: 'Tap H1',
          tapVehicle: 'Tap the vehicle',
          name: 'Name: TLF',
          drag: 'Drag the TLF to H1',
          linePhone: 'Add › Line, then drag from the TLF to the entrance',
          lineTablet: 'Line, then drag from the TLF to the entrance',
          linePick: 'Choose Line',
          lineDraw: 'Start at the TLF, drag to the entrance',
          lineFix: 'Drag a new line from the TLF to the entrance',
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
