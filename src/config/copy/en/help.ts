// English copy · the «Funktionen & Hilfe» overlay.
// One slice of the `en` overlay, assembled in ../en.ts; the German base is ../de/help.ts.

import type { Copy, Localizable } from '../index'

export const helpCopy: Localizable<Pick<Copy, 'help'>> = {
  help: {
    menu: 'Features & help',
    title: 'What can KP Front do?',
    contents: 'Contents',
    close: 'Close',
    search: 'Search help …',
    searchHint: 'Try another keyword – headings and body text are both searched.',
    introFallback: 'KP Front is your brigade’s digital situation and incident command: a tactical situation map, object plans, SCBA monitoring and a shared log – all live across multiple devices at once.',
    sections: [
      {
        id: 'ueberblick', title: 'Overview', icon: 'info',
        blocks: [
          { kind: 'intro' },
          { kind: 'sub', text: 'The work areas (left rail)', only: 'wide' },
          { kind: 'sub', text: 'The work areas (bar at the bottom)', only: 'phone' },
          { kind: 'list', items: [
            '**Map** – the tactical map with symbols, lines, areas and the utility layers.',
            '**Plans** – this brigade’s modules and building views as tactical work surfaces, storey by storey.',
            '**Checklist** – runnable incident checklists.',
            '**Teams** – monitoring of deployed teams with time and pressure, with and without SCBA.',
            '**Attendance** – who is on the incident, with times and a remark; guests from outside the roster too.',
            '**Material** – what was used, from the catalogue or recorded freely.',
            '**Report** – the incident report: a pre-filled form that is completed across the whole incident and printed at the end.',
          ] },
          { kind: 'note', text: 'Guiding principle: usable at 3am, after six months without practice. Recognition over recall, usable with gloves and offline.' },
        ],
      },
      {
        id: 'anmelden', title: 'Sign in & roles', icon: 'lock',
        blocks: [
          { kind: 'lead', text: 'You sign in once per device: **Who are you?** shows the brigade’s accounts – tap your own, enter the **PIN**, **Sign in**.' },
          { kind: 'list', items: [
            'The sign-in stays on the device; every time the app is opened it is extended. **Log out** (in the menu) asks first.',
            'Without a network you cannot sign in – but a signed-in device opens saved incidents offline too.',
            'Forgot the PIN, need a new account? That is set up by **the administration** – the app itself cannot change a PIN.',
            'Where the brigade has set it up, **Sign in with Microsoft** works too.',
          ] },
          { kind: 'sub', text: 'Roles' },
          { kind: 'list', items: [
            '**Editor** – everything: map, plans, teams, log, report; opening and sharing incidents.',
            '**Incident commander** – sees everything and writes attendance, material, checklists, report, incident data and log; closes and reopens. Map, plans and teams stay read-only.',
            '**Viewer** – read only.',
            'What a role may not do is simply not there – no grey button. The top then reads **View only**, and the menu says why. Which account has which role is set by the administration.',
          ] },
        ],
      },
      {
        id: 'karte-objekte', title: 'Map & objects – no incident', icon: 'pin',
        blocks: [
          { kind: 'lead', text: 'With no incident open, KP Front lands here: the brigade’s map with all its objects, to look things up and prepare. This is not an incident – measuring, marking and looking things up happens on this device only, and none of it is saved.' },
          { kind: 'sub', text: 'Search & objects' },
          { kind: 'list', items: [
            'The field at the top searches **addresses and objects**. A hit opens its details: hazards, hydrants nearby and the **object plans**.',
            'Every object is outlined on the map with its buildings and carries its name; tap it to open it. Tapping another building shows what the register knows about it.',
            'The selected object’s plans stand in the left rail and open in the same plan reader as in an incident – read-only. The button at the bottom left leads back to the object.',
          ], only: 'wide' },
          { kind: 'list', items: [
            'The search at the top right finds **addresses and objects**. A hit opens its details: hazards, hydrants nearby and the **object plans**.',
            'Every object is outlined on the map with its buildings and carries its name; tap it to open it. Tapping another building shows what the register knows about it.',
            'The plans are rows in the object’s details and open in the same plan reader as in an incident – read-only. «Back» at the bottom leads to the map.',
          ], only: 'phone' },
          { kind: 'list', items: [
            '**Object visit** and **Report** in the details start the capture, where the brigade has set it up.',
          ] },
          { kind: 'sub', text: 'Tools' },
          { kind: 'list', items: [
            '**Drop pin** – a point with its address and coordinates (LV95 + WGS84) to copy. A long press on free map drops one too – on a phone that is the only way.',
            '**Measure** – distance or area.',
            '**Dangerous goods** – enter the UN number: the ADR/ERG facts and the distances as rings around the chosen point.',
            '**Layers** – utilities, hydrants, weather radar and the station data; a setting of its own, independent of any incident.',
            '**Checklist** – the brigade’s checklists and device guides to read, with their own search.',
          ] },
          { kind: 'list', only: 'keyboard', items: [
            'With a keyboard: every shortcut of this view is under **Keyboard shortcuts** › «Map & objects».',
          ] },
          { kind: 'note', text: 'When an incident is running it stands in the bar at the top – red, or hatched with the word «Exercise» for an exercise – and a tap opens it. An alarm is shown but never opened by itself.' },
        ],
      },
      {
        id: 'einsatz', title: 'Manage incidents', icon: 'swap',
        blocks: [
          { kind: 'lead', text: 'Everything is in the **Menu** at the top left – during an incident it carries the incident name, on «Map & objects» the brigade’s emblem.' },
          { kind: 'list', items: [
            'At the very top, the open incident: **Edit** (the incident data), **Complete** with the count of what is still open, and **Share**.',
            'Below it the other running incidents – tap one to switch. When several are running, the incident at the top shows a **+N**.',
            '**New alarm** – an incoming alarm that is not an incident yet: **Open** opens it. The **✕** only hides it on this device; it stays as a grey row «Hidden», and **Show** brings it back.',
            '**Open incident** – an incident by hand, without an alarm. The first question is **Real | Exercise**, then the location (object, address or on the map) and the keyword. What is half typed stays, even if the app reloads.',
            '**All incidents** – the closed ones too: tap one to read it, **Reopen** to add to it.',
            '**Leave incident** – back to the map; the incident keeps running.',
            '**Close incident** closes out the running incident – the same dialog as in the report, with the same list of what is still open. With neither a PDF nor a finished print, **Report not created yet** stands at the top – again too once the report is edited afterwards; **Complete anyway** still closes.',
          ] },
          { kind: 'sub', text: 'Exercise' },
          { kind: 'list', items: [
            'An exercise is an incident like any other – everything works the same. It does not count in the incident statistics and stands hatched, with the word «Exercise», in the bar.',
            'To open one: **Open incident** › **Exercise** – the button then reads **Open exercise**. A running incident becomes an exercise, or goes back, via **Edit**.',
            'In **All incidents** only a closed exercise that was one from the start can be deleted. Where that is not possible it reads «Delete: only in the administration».',
          ] },
        ],
      },
      {
        id: 'alarme', title: 'Alarms on this device', icon: 'bell',
        blocks: [
          { kind: 'lead', text: 'A new alarm wakes every device that is signed in with an **Editor** account and allows alarms – as «Neuer Einsatz», even when the app is closed.' },
          { kind: 'list', items: [
            'Whether this device is ready is shown by **Settings › This device** with **Alarm ready**: installed as an app, notifications allowed, alarm subscription, login. What is missing stands there openly, with its button; **Test alarm** checks the whole way.',
            '«Neuer Einsatz» does not wake accounts for an **Incident commander** or a **Viewer** – under «Alarm ready» the **Account** row says so.',
            '**SCBA** alarms (overdue, alarm pressure, emergency) sound on every device that has the incident open, with any account.',
            '**No alarms on this device** switches them off here; **Switch on** turns them back on.',
          ] },
        ],
      },
      {
        id: 'navigation', title: 'Navigation & interface', icon: 'cursor',
        blocks: [
          { kind: 'lead', text: 'Three fixed zones: the area rail on the left, the incident bar on top, the tool rail on the right.', only: 'wide' },
          { kind: 'lead', text: 'Two bars at the bottom, one on top: the area bar at the very bottom, the tool bar above it, the incident bar on top.', only: 'phone' },
          { kind: 'sub', text: 'Bottom bars', only: 'phone' },
          { kind: 'list', only: 'phone', items: [
            'The **area bar** at the very bottom has five tiles: Map, Plans, Checklist, Teams and Report. **Plans** and **Report** stand for several pages (Report, Attendance, Material): tap the tile again or hold it to open the chooser.',
            'Above it, the **tool bar** of the map or the plan. **+** is the one door to everything that is put on it.',
            'A button that carries only an icon says its word when you **hold it down**. In **Settings**, «Rail labels» writes the words underneath for good.',
          ] },
          { kind: 'sub', text: 'Left rail', only: 'wide' },
          { kind: 'list', items: [
            'With a keyboard and mouse, the tiles of the left and the right rail that have a shortcut carry its letter – as do «Log» and «Entry» at the top. Every shortcut is under **Keyboard shortcuts**.',
            'Dragging the right edge of the rail expands it with labels, or collapses it again.',
          ], only: 'wide' },
          { kind: 'sub', text: 'Top incident bar' },
          { kind: 'list', items: [
            'On the left, the incident name with the **Menu** (close incident, the other running incidents, settings, this help …) and the **incident clock**.',
            'On the right, the **Weather**, **Undo/Redo**, **Log** and **Entry**.',
          ], only: 'wide' },
          { kind: 'list', only: 'phone', items: [
            'On the left, the incident name with the **Menu** (close incident, the other running incidents, settings, this help …); on the right, **Undo** and the **Log**.',
            'The round button at the bottom right is **Entry**.',
          ] },
          { kind: 'sub', text: 'Message strip' },
          { kind: 'list', items: [
            'Directly under the incident bar sits **one** strip for everything that is pending and stays until somebody acts: an overdue SCBA team, a new alarm, a due reminder, unchecked alarm data, a waiting update. Every message is one row below the next – no more cards covering each other.',
            'The order is fixed, not by arrival: **SCBA** first, then the **alarm**, then the **reminder**. What waits for somebody always outranks what goes away by itself.',
            'Only the labelled buttons act, the **✕** and – where the message has a place – its **title**. A tap anywhere else on the row does nothing: reading must not be the same as acting. With nothing pending the strip is not there at all.',
          ] },
          { kind: 'sub', text: 'Right tool rail', only: 'wide' },
          { kind: 'list', items: [
            'The drawing and placement tools.',
            'Below them, in the bottom-right corner, the **view bar** – always visible, even when the tools scroll: on the map **Layers** and **Views** (the compass), on the plan **Fit** and the north arrow; with a mouse also **−** and **+**.',
          ], only: 'wide' },
        ],
      },
      {
        id: 'tastatur', title: 'Keyboard shortcuts', icon: 'type', only: 'keyboard',
        blocks: [
          { kind: 'lead', text: 'With a keyboard everything is reachable without a mouse. Shortcuts do nothing while you are typing in a text field, nor behind an open window. Where a tile has a key, its letter is printed on it – in both rails, in the view bar at the bottom right and on «Log» and «Entry» at the top.' },
          { kind: 'sub', text: 'Switching areas' },
          { kind: 'list', items: [
            'Numbers open the plan module with that number – which ones exist depends on this brigade’s modules: [[1]] module 1, [[2]] or [[3]] the «2/3» module, [[4]] module 4 …',
            '[[K]] Map · [[C]] Checklist · [[A]] Teams (A as in Atemschutz) · [[P]] Attendance · [[M]] Material · [[R]] Report – each the first letter of the German area name (Anwesenheit: P as in Personal).',
            '[[⌘]] [[[]] / [[⌘]] [[]]] steps through all areas one at a time (including Surroundings and Building, which have no number).',
          ] },
          { kind: 'sub', text: 'Tools (the same on map & plan)' },
          { kind: 'list', items: [
            '[[V]] Select · [[W]] Multi-select · [[S]] Symbol · [[L]] Line · [[F]] Area · [[U]] Cordon · [[N]] Note · [[T]] Team · [[D]] Measure.',
          ] },
          { kind: 'sub', text: 'Editing' },
          { kind: 'list', items: [
            '[[⌘]] [[Z]] Undo · [[⌘]] [[⇧]] [[Z]] Redo · [[⌘]] [[D]] Duplicate · [[⌫]] deletes the selection.',
            '[[Esc]] takes back one layer per press until the map is clear: Layers / Views → a symbol being placed, or picking coordinates → the tool → the note panel → the selection – in the same order on the plans. A menu, card or window on top is closed by [[Esc]] first and alone. In a field [[Esc]] only leaves the field and keeps what was typed; it closes the **Entry** and keeps its text for the next time.',
          ] },
          { kind: 'sub', text: 'View & panels' },
          { kind: 'list', items: [
            '[[+]] / [[−]] Zoom · [[0]] Fit · [[G]] My location · [[X]] Pick coordinates on/off. «Face north» has no key – that is what the compass is for, always visible and turning with the map.',
            '[[J]] Log · [[E]] Entry · [[B]] Layers · [[⌘]] [[,]] Settings · [[?]] this help.',
            'On the **board**, [[PgUp]] / [[PgDn]] page through its sheets.',
          ] },
          { kind: 'sub', text: 'Map & objects (no incident)' },
          { kind: 'list', items: [
            'The same keys where the same thing exists: [[K]] Map · [[C]] Checklist · numbers the modules of the selected object · [[D]] Measure · [[B]] Layers · [[G]] My location · [[0]] Fit · [[+]] / [[−]] Zoom · [[⌘]] [[,]] Settings · [[?]] this help.',
            'Plus what only exists here: [[P]] Drop pin (P as in Punkt) · [[U]] Dangerous goods (U as in UN number) · [[/]] or [[⌘]] [[K]] the search.',
            '[[Esc]] steps back towards the map one step at a time: search → Views → tool → open plan → selection.',
          ] },
        ],
      },
      {
        id: 'lage', title: 'Map – the tactical map', icon: 'map',
        blocks: [
          { kind: 'lead', text: 'The tactical map over the real map background (operational area and surroundings).' },
          { kind: 'list', items: [
            '**Base map** (top of the layers panel) switches the background: Carto, OpenStreetMap or satellite.',
            '**Views** – the compass (bottom right, on a phone in the tool bar next to Layers) – holds **Face north**, **Fit**, **My location**, **Pick coordinates** and the saved views; with a mouse **−** and **+** stand beside it. When picking, tap the map to fix a point (LV95 + WGS84).',
            '**Weather** stands in the incident bar all the time: temperature, an arrow in the direction the wind is blowing, and its strength – the spread direction at a glance. A tap shows gusts and the direction in degrees.',
            '**Vehicles** appear live via GPS (name + heading), your own position as a calm blue dot.',
            '**Building info** at the bottom left names the hazards of the building at the incident location (⚠ gas · PV) – the number beside it counts the immediate measures – and opens its card: hazards, **Immediate measures** and **Remarks** at the top, the register facts below. The first time this device opens the incident, the card opens by itself so it gets read – the map stays usable. ✕ closes it; after that the chip opens it. A different location or object with content shows it once more.',
          ] },
        ],
      },
      {
        id: 'ebenen', title: 'Layers & data', icon: 'layers',
        blocks: [
          { kind: 'lead', text: 'Via **Layers** you show the utility and hazard data – ordered by type.' },
          { kind: 'list', items: [
            '**Inhalte** – tactical symbols, vehicles, vehicle tracks, people (live), sketches & notes. When one of them is hidden, the **Layers** button carries a dot.',
            '**Station** – underground structures (garages, shelters, tunnels) from the official survey, dashed from street zoom; shown by default.',
            'Which layers exist depends on this brigade’s geodata – none of it ships with the app. Common ones are:',
            '**Sewer** – foul/combined, storm/clean, manholes / gullies.',
            '**Gas** – mains.',
            '**Power** – lines, PV systems.',
            '**Hazards** – flooding, inundation depth.',
          ] },
          { kind: 'lead', text: 'Every layer can be shown/hidden and its opacity adjusted.' },
          { kind: 'list', items: [
            'Pre-loading for offline happens by itself – what is ready is shown by **Settings › This device** (see «Multi-device & offline»).',
          ] },
          { kind: 'note', text: 'The utility data covers the configured operational area and is available locally – it works offline too.' },
        ],
      },
      {
        id: 'zeichnen', title: 'Drawing & symbols', icon: 'pen',
        blocks: [
          { kind: 'lead', text: 'The map’s tools – the same ones on the plan.' },
          { kind: 'list', items: [
            '**Symbol** – the tactical symbol (FKS/VKF). Quick-pick of the most common symbols or search the whole library. Tap to place; with «Place several» set several in a row.',
            '**Shapes** – in the same window, behind the hazards: **Arrow**, **Rectangle** and **Shuttle run** (with carrier Heli or TLF), for everything that has no tactical symbol. The handle rotates; on the rectangle its own handles drag width and height, on the arrow the end sets distance and direction. On the arrow, **Stop bar** adds the bar across its tip – the spread limit: this far, and stopped there.',
            '**Select** – tap objects, move them, adjust in the editor.',
            '**Multi** – tap **Select** again while it is active: the button switches to Multi (icon and word), and dragging a frame selects several symbols/drawings at once. Another tap switches back to Select.',
            '**Line** – **Freehand** (drag) or **Points** (tap, ✓) is chosen in the tool’s bar. Afterwards in the editor the **line** – Solid, Dashed, Holding line or Water drop zone – and the **Line end** – **None**, **Arrow**, **Arrow with stop** (the same bar across the tip) or **Section**; **Reverse direction** moves it to the other end without moving the line.',
            '**Area** – drag the outline freely or tap corner points and ✓ (area shown from 3 points). Dragging a corner moves it, the **+** in the middle of an edge inserts one, **holding down** a point removes it.',
            '**Cordon** – drag from the centre to the edge to set the radius in metres (fill adjustable).',
            '**Note** – free text directly on the map.',
            '**Team** – place a team’s marker: tap and choose the team.',
            '**Measure** – distance (length + elevation profile) or area (area + perimeter). Drag points to move them, the **+** in the middle of a segment sets an intermediate point, **holding down** a point removes it (with a mouse: right-click).',
            '**Measuring point** – for gas readings (CO, Ex, O₂, H₂S) at one spot, on the map or on a storey: search «Measuring point» in the symbol window, place it, enter the values. Yellow = A1 (pre-alarm), red = A2 (main alarm); an old value carries its age («18′»). **Readings** lists every measuring point.',
            '**Water relay** – below a distance’s elevation profile or in a hose line: choose hose Ø, flow, source (hydrant, pond, pump) and inlet pressure; the chart shows the pressure along the line and places the pumps. **Put on the map as a line** keeps the calculation; on a line the **Pumps on map** switch draws them as symbols.',
          ] },
          { kind: 'sub', text: 'Symbol presets' },
          { kind: 'lead', text: 'Each symbol brings only the controls that make sense: **Rotation** for directional symbols (arrows, ladders, walls), **Count** where several matter, **Floor** or a **floor range** (e.g. stairs/lift), **Spread** for damage situations – plus matching input fields (e.g. name, substance, status).' },
        ],
      },
      {
        id: 'wassertransport', title: 'Water relay', icon: 'drop',
        blocks: [
          { kind: 'lead', text: 'Calculates a relay line: how much pressure arrives where, and where the pumps have to stand. A **planning aid** – the sources of the numbers are behind the **ⓘ** in the header (AGV, FKS).' },
          { kind: 'sub', text: 'Drawing the line' },
          { kind: 'list', items: [
            'Draw a **Line** along the road, **from the source to the incident** – the water runs from the first point to the last. Tap the line, open **Dimensions** and tap **Calculate water relay**.',
            'Or try it first: **Measure › Distance**, then **Calculate water relay** below the elevation profile. **Put on the map as a line** keeps the distance with the whole calculation.',
            'Wrong direction? **⇄** in the header reverses it; the drawing stays. The letter at the start of the line (**H**, **W**, **P**) shows where the source is.',
          ] },
          { kind: 'sub', text: 'Source, water, inlet pressure' },
          { kind: 'list', items: [
            '**Hose Ø** – 55, 75, 2× 75 or 110 mm (in a line, the **Hose** row, with 40 mm as well); the friction comes from the AGV table.',
            '**Water** – the flow that should arrive at the end (l/min). Pick a suggestion or type another amount.',
            '**Source** – hydrant, pond or pump. **Inlet pressure** is the pressure the line starts with there: the static pressure at a hydrant, the outlet pressure of a pump. A pond has no pressure of its own – the first pump stands at the source.',
          ] },
          { kind: 'sub', text: 'Reading the chart' },
          { kind: 'list', items: [
            'The black line is the **pressure** along the line, the **terrain** below it. The bands: green **good** above 3 bar, yellow **tight** 2–3 bar, red **too low** below 2 bar.',
            'The dots **P1**, **P2** … are the pumps – placed automatically where the pressure falls to 2 bar (FKS: a pump needs at least 2 bar inlet pressure). On the map they carry the same names.',
            'Hovering over the chart or tapping it with a finger shows the pressure at that spot – the map marks the point.',
            'Below it **ascent/descent** and **pressure at the end**. **Hoses** names the reserve separately, e.g. «34 + 3 spare × 20 m».',
          ] },
          { kind: 'sub', text: 'Moving pumps' },
          { kind: 'list', items: [
            'Tapping a pump shows where it stands, its **inlet pressure** and its **outlet pressure** (set with **−**/**+**).',
            '**Dragging** a pump – sideways in the chart, or along the line on the map – fixes it there («by hand»); the pumps after it are recalculated. Then **All pumps automatic** appears and resets everything.',
            '**Pumps on map** draws the pumps as motor pumps on the map and on the printed sketch. Tapping a pump on the map opens the line with **Dimensions** open.',
          ] },
          { kind: 'sub', text: 'Warnings' },
          { kind: 'list', items: [
            '**Pump 1: inlet pressure below 2 bar** – a pump set by hand stands too far down the line; drag it closer to the source or tap **All pumps automatic**. **No pressure**: no water arrives there at all.',
            '**More than usual** – a lot of pumps; next to it, how many another hose Ø would need.',
            '**Calculated without elevation profile** (offline, outside Switzerland) and **outside the AGV table** – the numbers are estimates.',
            'A pump warning is noted once in the **log** when it appears, and so reaches the report.',
          ] },
        ],
      },
      {
        id: 'plan', title: 'Plan – modules & buildings', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'One work surface per object over the module and building plans – storey by storey, with its own tools.' },
          { kind: 'list', items: [
            'At the bottom left stands the **object** chip with a small lamp – tap it to open «Plan · …» with the rows **Object** (choose another object), **Map** and **Scale**. The object decides which plans are on offer.',
            'The same tools as on the map: **Select**, **Symbol**, **Line**, **Area**, **Cordon**, **Note**, **Team** and **Measure**.',
            '**Storeys** as a stack: use the **OG/UG** buttons on the plan to add a floor above/below.',
            '**Fit** and the north arrow in the view bar, just like on the map.',
            '**Teams** as coloured markers; a team’s **Trails** show its path: **Mark** on its marker sets the next point, **More** shows or hides them. Team chips whose team is «out» are greyed out/struck through.',
            '**Scale** – tap the two ends of the printed scale bar and enter the real length. After that lines, areas and **Measure** read in real metres. Without a scale, **Measure** asks for one first – the field stays empty until a length is typed, and **Undo** takes back a wrong calibration.',
            'A sheet **linked** to the map already measures by itself – as does the building’s floor stack, which knows its size from the footprint. There the **Scale** row behind the object chip says where it comes from. Only what is not linked is calibrated by hand.',
            '**Quick hand note?** The plan is the sketch surface: draw freely, strike through, scribble. The map stays structured (symbols, lines, notes) so the report and the log stay clean.',
          ] },
          { kind: 'sub', text: 'Link to map (georeference)' },
          { kind: 'list', items: [
            '**Link to map** (behind the object chip) puts this sheet onto the map: the plan gives up half the surface and the map sits beside it. On a phone there is no room for both – there the bar at the bottom switches between **Map** and the plan, you slide the spot under the crosshair and tap **+**; the magnifier at the bottom left shows what it sits on, and the **0/2** status opens the steps. Set the same spot on both surfaces – a house corner, a hydrant, a junction. **Order does not matter**: a half that has been set finds its counterpart by itself, and you may switch between the surfaces at will. Two points are enough to lay the sheet down.',
            'The **traffic light** in the bar says where you stand at all times: two points solve exactly and are therefore **unchecked** – only the third measures the deviation («4 points · ⌀ 1.2 m»). **Check the overlay** lays the sheet over the map for a visual check.',
            '**Dragging** a cross that has been set moves it, **tapping** it opens **Move**, **Remove point** or **Keep**. A tap on **linked** opens the **Accuracy** with pairs and deviation; **Copy** copies the points to another module of the same object, **Remove** takes them away (with a confirmation). **Close** discards nothing – what has been set is saved already.',
            'From then on **both surfaces show the same objects** – no copy, the same object: tap to see the details, drag to move, the same vertices and handles on either side.',
            'Where an object **stands** is decided by the last hand that placed it: dragged onto a sheet it stands on the sheet – and moves along when the link is corrected. Dragged onto the map it stands on the ground. A corrected link relocates everything standing on that sheet – one row in the log, and one ↶ takes it back. **Sheet shape measured** is the same relocation without a hand involved: the app measured the opened sheet and re-solved the link at its true shape. **Removing** the link loses nothing: sheet and map both keep what they show.',
            'In **Layers** every linked sheet gets one row of its own («Plan (Module 2)»): the sheet itself, as an image under the map. The objects on it need no row any more – they belong to the layer they were placed on.',
          ] },
          { kind: 'note', text: '**Building** is ONE tile in the area bar: as long as none is chosen (outline icon) it shows the building outlines live from OpenStreetMap – tap a building, apply, and the tile becomes the floor stack. When the incident has a location, the building there is already marked – checking and applying is enough. At the bottom left, «Choose another building» leads back to the choice. **Module 6** (floor plans) is by default a pure page/zoom viewer – annotations go on the building’s floor stack, not on the Module 6 PDF. Whether a module is a viewer is set in this brigade’s module configuration.' },
          { kind: 'note', text: '**Which way is the building facing?** A tap on the floor stack’s **north arrow** (in the view bar) opens the small window «Rotate building»: a **Rotation** slider with live preview, plus **North up** and **Rotate to long axis** as one tap each. The outline turns with it, the markings stay where they sit on the building – and the printed floor pages show the angle you set.' },
        ],
      },
      {
        id: 'atemschutz', title: 'Teams & SCBA monitoring', icon: 'stopwatch',
        blocks: [
          { kind: 'lead', text: 'Gap-free monitoring of every SCBA team per FKS – the safety signal is the **time since last radio contact**, not an estimated remaining time.' },
          { kind: 'sub', text: 'Register a team' },
          { kind: 'list', items: [
            '**Who goes in**: three slots, the top one is the **Leader** – tapping the whole row makes that person the team leader, the **✕** removes them. A larger team simply adds rows.',
            'The **person search** reaches the whole roster, not only those present; beside each name stands whatever argues against them (not present, at the station, already in a team). **(+)** records a guest (neighbouring brigade) – added to the attendance at the same time, and counted there as the same person.',
            '**Entry pressure** (bar) and **Radio channel** sit to the right of it.',
            'Below that the **Task**: type (under SCBA Rescue, Extinguish, Search, Secure, Reconnoitre, Other; without SCBA Traffic, Medical, Water supply, Secure, Standby, Other), **Target** in plain text, **Line no.** (lines already drawn are offered beside it as a quick pick) and the **colour** on the map and plan.',
            'The task holds nobody up: **Register team** works without it. The card then reads **«No task yet»**, and tapping that opens the form.',
            'What is typed survives closing the window with **✕** or a tap outside – only **Cancel** discards it.',
          ] },
          { kind: 'sub', text: 'Monitoring per team' },
          { kind: 'list', items: [
            'Every team’s clock counts **since last contact**: **Contact ok** → after {contactMin} min yellow **Contact due** → after another {graceSec} s red **Overdue** with an alarm. The brigade sets both values in the administration.',
            '**Contact** confirms radio contact and resets the clock.',
            '**Pressure** opens the values: **a tap on a value saves it at once** – there is no confirm. That counts as contact and is logged. Tapped the wrong one? **↶ Undo** takes it back. At the alarm pressure the pressure turns red.',
            'Status **Registered → Deployed → Withdrawing → Out**. **Withdraw** can be reverted with **Continue**; **Out** asks for the remaining pressure. A team that is out returns to monitoring with **Re-deploy** (new cylinder) – the **pressure log of the first deployment is kept** and prints in full on the report later.',
            'Teams that are out stand grey under **Out**. In the order «As placed» they keep their place instead.',
            'A **removed team** only leaves monitoring: it still prints on the report, with everything that was measured, marked **«Removed»**. **Removed teams** in the header brings it back – the «undo» toast is the quick door, not the only one.',
            '**Log** per team (expandable) shows every contact with time and pressure.',
            'The **⋯** at the foot of the card: **Edit** adjusts task / target or team mid-incident, **Place** puts the team on the map or plan (then **Show on plan**), plus line, order and **Remove**.',
            'Somebody in a team cannot be signed out in **Attendance** – a tap on the row jumps to that team’s card instead and highlights it briefly.',
            'Overdue teams move to the top and a counter appears. The **bell** mutes the alarm per device – sound **and** notification, and only until this incident ends. If it shows red the browser has not released audio: tap it. The monitoring itself is never muted. Everything lands in the log.',
            '**Hand over monitoring** (the QR next to the bell) hands the teams to another device – see «Share & present».',
          ] },
          { kind: 'sub', text: 'SCBA emergency' },
          { kind: 'list', items: [
            'A team that is inside carries the wide tile **Emergency**. It is **held down** until it has filled completely – a short tap triggers nothing.',
            'Then the team is red everywhere, with its own emergency clock and an alarm on every device. Its page names what counts now: where it was, last contact, last pressure, channel – and **Deploy safety team**.',
            'It is ended the same way: hold **Emergency ended** – or report **Out**, which ends it too. Both stand in the log and on the report; ↶ takes it back.',
          ] },
        ],
      },
      {
        id: 'anwesenheit', title: 'Attendance', icon: 'people',
        blocks: [
          { kind: 'lead', text: 'Who is on this incident, and from when to when – the basis for the personnel sheet and the hours. The roster comes from the administration; this only records who is here today.' },
          { kind: 'sub', text: 'Recording' },
          { kind: 'list', items: [
            '**Tapping** a row cycles it: **not present → present → left → not present**. The first «present» starts at the **Alarm time** (ticking usually happens later than arriving); a return starts now.',
            'Every row takes a **Remark** («driver TLF», «injured, relieved 21:40»). It describes what this person did here and prints on the personnel sheet. If a row is set to «not present» by accident, the remark is back with the next «present».',
            'Whether somebody is **On scene** or at the **Station** is a pair in the row – the answer to «who could I still call in». The header shows the split as soon as somebody is at the station.',
            'Somebody who is not on the roster (neighbouring brigade, guest): type the name into the search, and the last row then reads **Add «…» as a guest**. The person carries the **Guest** badge – a statement about this incident, not about brigade membership.',
            'Somebody **in a team** cannot be signed out here – a tap jumps to that team’s card instead; report **Out** there first.',
          ] },
          { kind: 'sub', text: 'Correcting' },
          { kind: 'list', items: [
            '**Undo / Redo** in the incident bar takes back the last tap. The log keeps both: the tap and the correction.',
            'Times wrong? The **clock** in the row opens the person’s **Recorded times**: correct from/to, also for an earlier block if somebody was here twice. Somebody coming back gets a new time with **Back again**.',
            'The three views on top: **Attendance** (who is here), **Schedule** (who is available when), **Shifts** (relief as bands).',
          ] },
          { kind: 'note', text: 'Recording also runs **by QR** (a poster at the station): whoever signs in there appears here – and both sides may touch the same person without anything being lost.' },
        ],
      },
      {
        id: 'mittel', title: 'Material', icon: 'box',
        blocks: [
          { kind: 'lead', text: 'What was used – from the brigade’s catalogue or recorded freely. The report prints the material list from it.' },
          { kind: 'list', items: [
            'The **catalogue** comes from the administration, with unit and source («on the TLF», «Pio»). **+** raises the amount; the row stays.',
            '**Other material** records something the catalogue does not know – a name and an amount are enough.',
            'Where a symbol on the map or a plan stands for a material (fan, oil binder) that is not logged yet, a **strip above the list** says so: «Placed, but not logged». **Apply** records everything missing with the source from the stock – one tap instead of recording the same thing twice. When there is more than one option, the button reads **Log …** and asks.',
            'Setting an amount to **0** does not remove the row from the record – the report shows what was used and what was taken back.',
          ] },
        ],
      },
      {
        id: 'zeitplan', title: 'Schedule & shifts', icon: 'clock',
        blocks: [
          { kind: 'lead', text: 'The second and third view of the attendance: not «who is here» but **who is available when** – for an incident that outlasts one shift.' },
          { kind: 'list', items: [
            'In the **Schedule** every person has a row; dragging (or the pen) plans an availability window. It is a **plan**, not a record: it writes no attendance – that only happens when somebody actually taps.',
            '**assigned** (solid) or **available** (hollow) – the difference between «is coming» and «could come»; green is whoever is really here.',
            'The **Window** on top decides how many hours are visible at once.',
            'In **Shifts** the same windows are grouped into named bands («night 22–06»): creating a band writes no shift, and deleting a row deletes no availability.',
            'Both views print: **To paper** (the printer in the header) – **Availability**, and as soon as there are bands **Shift plan**; as a PDF or straight to the station printer.',
          ] },
        ],
      },
      {
        id: 'checkliste', title: 'Checklist', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'One list with one search: runnable tasks, look-ups on tactics and keywords, the brigade’s device guides.' },
          { kind: 'list', items: [
            '**Matching** stands at the top: the entries for what is in the incident’s keyword.',
            '**Tasks** – incident checklists (e.g. command support, situation report) with progress; tick items off, branches follow multi-step procedures.',
            'The brigade’s look-up groups – search a keyword and open the entry (with hazard colour code and sketches) – and **Manuals** for the devices.',
          ] },
          { kind: 'lead', text: 'The state is preserved and synced to all devices.' },
        ],
      },
      {
        id: 'verlauf', title: 'Log & entry', icon: 'verlauf',
        blocks: [
          { kind: 'lead', text: 'A shared, running log across map and plan – the incident chronicle.' },
          { kind: 'list', items: [
            '**Entry**: a short tap opens text input. **Press and hold** opens two fields – **Voice memo** and **Photo** – that stay until one is tapped; the button itself becomes an **✕** meanwhile and cancels. In the entry itself, record, file and photo attach something; when space runs short (mostly with the keyboard up) they are gathered under **Attach**.',
            'From **two letters** on, names are suggested – personnel, material, partner organisations, vehicles and alarm groups, plus the posts **EL** and **Stv. EL**. Tapping one inserts the whole name; it is highlighted in the log and on the printed report. Write the post and you get the name too («EL (Widmer Céline)»), write the name and you get the post. There is no separate «from» field: the sentence already says who reported it.',
            'As soon as the sentence ends on a name, **→** and **←** are offered beside it: one tap writes the arrow, and «EL → ambulance: patient stable» reads like the radio log the log is. On paper it becomes «->».',
            'While the field is **empty**, starter chips stand ready: **EL →** first, then the phrases already written on this incident (otherwise the brigade’s list). They stay until something is actually typed – a second chip appends to the first.',
            'Significant actions (symbol placed, drawing created/removed …) land in the log automatically.',
            '**Undo/Redo** applies to map, plan, teams – and to **Attendance**, where it takes back the last tap.',
            'A log entry with a location jumps back to the spot in map or plan when tapped; photos and voice memos can be opened/played directly in the log.',
            'A **typo** can be corrected: the **pencil** in the row sits on everything somebody typed themselves – not on what the app wrote about an action («Team 2 back in»). The row then carries **Corrected HH:MM**; the original wording stays in the record and in the audit chain.',
            '**Playback** (▶ by the log, on a phone at the time ruler) plays map and plan back to an earlier point in time (time slider; editing is locked meanwhile). On a running incident it opens at «Now», and **Play** starts from the beginning; on a closed one it opens at the beginning.',
            'In the log’s filter menu, **Print log / PDF** leads to the report PDF with the incident journal ticked.',
            'Half-typed text in the **Entry** stays, even if the app reloads – photos and voice memos do not.',
          ] },
          { kind: 'sub', text: 'Open items' },
          { kind: 'list', items: [
            'The **ring** next to «Info · Order · Immediate measure» turns an entry into an **open item**: it stays open until it is ticked off. A tap on the ring opens the choice – **New open item**, **Urgent open item**, or one that is already open, to which this entry is attached as an **Update**.',
            'Open items stand **at the top of the log**, urgent ones first, then the oldest. The time says **when they were given**; a tap on it shows the age instead. The ring on the left ticks them off.',
            'An open item collects **updates**: tapping the row writes one – with everything an entry can do, so as a voice memo or photo too. All updates stand under their open item, and in the log each carries the start of the open item as a reference; a tap on it jumps there.',
            'An open item has **no due time** by itself – on the incident ground nobody reports back on the clock. If you want one, tap the **clock** next to the ring: **in 5/10/15/30/60 min** or **Time …** with day and time – in the same time picker as everywhere (wheels, or type the time), today or on one of the next days; a moment that has already passed cannot be applied. So a reminder is no longer a row of its own kind, but an entry that also reports by itself – with type, photo and voice memo like any other. In the list the due time stands as a time next to the row.',
            'On the report they appear as **«Tasks / open items»** with what, who, given and done; ones still open stand as **open**. The section can be deselected under **More print options** (the **▾** beside the PDF). On the **board** the same list stands as the page «Tasks / open items» – ticked off on one side is ticked off on both.',
          ] },
          { kind: 'note', text: '**Who** is not asked for: the sentence names it. «Werkhof Oberwil provides barrier material» is enough – the highlighted name lands on the report as who.' },
        ],
      },
      {
        id: 'rapport', title: 'Report & closing out', icon: 'doc',
        blocks: [
          { kind: 'lead', text: 'The **incident report** is its own area in the area bar, after Material – a pre-filled capture sheet, not a form from scratch. It is filled in across the whole incident, not only at the end.' },
          { kind: 'list', items: [
            'On wide screens, two columns: on the left the **form** to type in (alerting, short report, times, remarks, report back to dispatch), on the right the **reconciliation** to tick off (attendance, material, partner organisations, photos).',
            'Under the title stands what has been captured – and a **Checks** chip that counts what is **still open** («4 open · 1 note»): times, attendance, material, incident commander, short report, report back to dispatch. A tap opens the list. None of it ever blocks printing.',
            'The **sketch section** sits as a field next to the form: pan, zoom, **Portrait/Landscape** and the **sketch time** – which moment the picture shows, with marks where something happened. What prints is exactly what is on screen; there is no confirmation step.',
            '**Incident report (PDF)** produces the finished report – rendered server-side, one button. The **▾** beside it, **More print options**, chooses the sections – what goes on paper (sketch, plans, building, SCBA, attendance, material, incident log, tasks / open items, photos …) – and downloads the attachments as a ZIP. The menu stays open while you tick.',
            'Where a brigade runs a **station printer**: **Print** puts the report in its queue. Queued is not printed – while the job is outstanding, **Print job outstanding** stands under the report head, with **Check** and **Cancel**. Only when the printer reports «printed» does the report count as produced.',
            'If the brigade has stored its own forms (Administration › Report), **Forms & links** appears at the end, below the sketch section – a list to tick off. **Open** calls the form up with keyword, location, date and incident commander already filled in, as far as the link allows. The tick is set by hand: the app cannot see whether a form was submitted.',
            'If something about the record is off – a broken audit chain, a voice memo without a transcript, a photo still queued – **Checks** counts it as a **note**; when everything is in order the chip does not appear at all.',
            'Contact person and report back to dispatch carry a **Not applicable** at the end of the line – for the false alarm or the oil spill where neither exists. That is an answer, not a skip: it is recorded and reads that way on the report.',
            '**Close incident** closes the incident and records the time it ended – in the report head as soon as there is a PDF or a print, otherwise in the menu (the dialog then names the missing report as an open point). After that the report can only be read and signed. Photos and voice memos that have not been synced yet are synced first; if that is impossible (offline) they **stay saved on this device** and are synced the next time it is opened – the confirmation says how many.',
            '**Signatures** (optional): the incident commander and the commander sign with a finger – on a running incident as on a closed one. If the signed part changes afterwards, the signature stands as **invalid**; a tap signs again.',
            '**Share** (at the bottom of the report, and in the menu under **Share incident**): a link to this incident alone, read-only – more under «Share & present».',
          ] },
          { kind: 'note', text: 'A closed incident can be **reopened** – later additions appear in the log and the report as **addenda**, and nothing is lost.' },
        ],
      },
      {
        id: 'links', title: 'Share & present', icon: 'link',
        blocks: [
          { kind: 'lead', text: '**Share incident** (in the menu by the open incident, and in the report) gives a link as a QR code and as an address. **Revoke link** makes it invalid at once.' },
          { kind: 'list', items: [
            '**Incident · read** – map, plans, log, photos, times. No login, nothing can be changed. For dispatch, the IC and a neighbouring brigade during the incident, for the municipality and neighbouring brigades afterwards: it holds beyond the close.',
            '**Teams · operate** – only this incident’s teams, to carry along on a device of their own (in the teams: **Hand over monitoring**). What is entered there stands in the report. Holds until the close.',
            'Want to work along instead of only watching? **Sign in** on the other device – a link makes nobody an editor. The menu of a link device carries **Sign in** for that.',
          ] },
          { kind: 'sub', text: 'Present' },
          { kind: 'list', items: [
            '**Present** – in the menu by the open incident, or in **Share incident** – › **Start**: whoever has the incident or the read link open can **Follow** – their screen shows what yours shows, on every surface.',
            '**Point** turns a tap into a dot and a stroke into a line, which fade again – visible to everyone, nothing is saved.',
            '**End** stops; **Stop following** frees your own screen again. If a presentation is already running, it can be **taken over**. Presenting needs a network.',
          ] },
        ],
      },
      {
        id: 'erfassung', title: 'Capture by QR code', icon: 'cam',
        blocks: [
          { kind: 'lead', text: 'Where a brigade has enabled capture (Administration › «Links & access»), a **QR poster** in the fire station opens the capture view – no login, for everyone without access to a tablet.' },
          { kind: 'list', items: [
            'You pick a running incident, or one whose report is still open; on your own phone you can capture **attendance**, **material**, times, details, partner organisations and photos.',
            'A name is stepped on by tapping it: **absent → station → on scene → left**. The **ⓘ** next to the search says so again, including what the time beside it means (from = arrival, to = departure).',
            'The entries flow into the **same incident** as the command-post tablet and are merged (with a note to check where they disagree).',
            'As a fallback there is the **Blank capture sheet (PDF)** to print and fill in by hand.',
          ] },
        ],
      },
      {
        id: 'sync', title: 'Multi-device & offline', icon: 'check',
        blocks: [
          { kind: 'lead', text: 'All devices see the same incident live.' },
          { kind: 'list', items: [
            'Changes are synced automatically; the indicator on top shows the state.',
            'Concurrent editing is merged per object (latest change wins).',
            '**Read-only**: viewers see the map live, without the tactical tools.',
          ] },
          { kind: 'sub', text: 'Offline' },
          { kind: 'list', items: [
            '**Offline preparation**: the installed app fetches map, plans, symbols and reference layers by itself shortly after an incident is opened – no dialog, no toast. **Every** configured map layer comes along, including the one currently hidden: experience says it gets switched on once the network is already gone. The **Load everything for offline** button fetches the same at any time by hand.',
            'How much is loaded is set by the station’s **Offline radius** (in the administration, the same for every device).',
            'What is actually ready is shown by **Settings › This device** in the menu – row by row: map, plans, symbols, dangerous goods, reference layers, personnel, device storage. **Weather** and **Object search** need a network and stand there as «network only».',
            'Only the **installed app** is reliably offline. In a browser tab the storage can be cleared at any time, and the tab would have to still be open at the next incident.',
            'Without a network everything on the device keeps working: drawing and placing symbols, SCBA, attendance, material, log and report. Photos and voice memos stay stored and go out later.',
            'As soon as there is a network again the changes go out by themselves and are merged with the other devices – per object, latest change wins. While anything is pending, the indicator on top says so.',
          ] },
        ],
      },
      {
        id: 'bedienung', title: 'Operation & day/night', icon: 'move',
        blocks: [
          { kind: 'sub', text: 'Tap & drag (touch/iPad)' },
          { kind: 'list', items: [
            'One finger pans the map/plan; two fingers zoom (pinch).',
            'When the app comes back from the background, no tool is in hand any more – a drawing that was started asks, as always, whether it stays.',
            'One finger zooms too: **double-tap** zooms in; **tap, then press again and drag** zooms smoothly – down to zoom in, up to zoom out. The same on the map and the plan, with **Select**. A tool comes first: where it taps (points, measure, add, note, circle …) every tap is its own; where it drags (freehand, multi) a double-tap still zooms. Two fingers always zoom. A line or area tapped out point by point is finished with ✓, never with a double-tap.',
            'Tapping **Select** again switches the button to **Multi**: dragging a frame selects several objects. Tap an object first, then drag – a finger on an object that is not selected pans the map. Lines, areas and circles are moved with **✥**. A single selected object is copied by **Duplicate** in the selection’s bar.',
            '**Holding down** a measure, line or area point until the ring closes removes it; the **+** in the middle of a segment inserts one.',
          ] },
          { kind: 'sub', text: 'Mouse', only: 'keyboard' },
          { kind: 'list', only: 'keyboard', items: [
            'Scroll to zoom; **right-click** on a measure, line or area point removes it.',
          ] },
          { kind: 'sub', text: 'Keys', only: 'keyboard' },
          { kind: 'list', only: 'keyboard', items: [
            '[[Esc]] takes back one layer – tool, open panel, selection (the full order is under **Keyboard shortcuts**).',
            '[[Del]] / [[Backspace]] deletes the selection (not while typing in a field).',
          ] },
          { kind: 'sub', text: 'Labelled bars' },
          { kind: 'list', items: [
            'In **Settings** ([[⌘]] [[,]]) under «Rail labels»: **On** writes its word under every icon – in the left and the right rail, in the bar of the chosen tool (for the line «Freehand» · «Points» · «Cancel») and in the view bar at the bottom right, on an incident as on «Map & objects». **Off** leaves only the icons everywhere. For everyone who does not know the symbols by heart yet – the bars get a little wider for it, and on an incident «Expand» is no longer needed. On a **phone** it is set to **On** from the start.',
            'When it is off, the icon stays; a tap on **Expand** shows the names for as long as the rail stays open.',
            'Everywhere else: **hold down** a button that carries only an icon – after a short moment its word appears as a bubble above it, on touch with a short buzz. Letting go does **not** trigger the button: asking what something is must not also do it. With a mouse, hovering is enough.',
          ] },
          { kind: 'sub', text: 'Day / night' },
          { kind: 'list', items: [
            'In **Settings** ([[⌘]] [[,]]) under «Color scheme»: Automatic (follows daylight), Device (follows the tablet’s or phone’s light/dark setting), Day or Night. Night mode dims the map and interface for the dark.',
          ] },
        ],
      },
      {
        id: 'verwaltung', title: 'Administration & station data', icon: 'gear',
        blocks: [
          { kind: 'lead', text: 'Anything that holds for the whole brigade – personnel, ranks, vehicles, material, map layers, object plans, checklists – is maintained under **Administration**, not during an incident. Getting in takes its own **Admin key**, not the incident PIN.' },
          { kind: 'sub', text: 'The workbook (Excel)' },
          { kind: 'list', items: [
            'Under **Data › Workbook** the brigade’s lists come as one Excel file: download it, edit it in Excel, Numbers or LibreOffice, upload it back. Eight sheets – Mannschaft, Dienstgrade, Fahrzeuge, Mittel, Mittel-Bestände, Quellen, Partnerorganisationen, Symbolfelder (the sheets are named as they appear in the file).',
            'A **preview** always comes before any writing: sheet by sheet, what would be new, what changes, what falls away – and every refused row with its sheet and row number. Nothing is written until you confirm, and cancelling writes nothing.',
            'Uploading the same file again changes nothing at all. The download is therefore also the template – and safe to fetch just to look at.',
          ] },
          { kind: 'note', text: '**An absent sheet is not an empty sheet.** Deleting a whole sheet from the file leaves that list untouched. Deleting only its rows and leaving the header row clears it – which is exactly how you empty a list on purpose.' },
          { kind: 'note', text: '**«Missing» means two different things.** A person missing from the Mannschaft sheet is **deactivated**, never deleted – closed incidents resolve their name through that row. An id missing from any of the other lists is **removed**. The preview names both with exactly those words and does not just count them.' },
          { kind: 'sub', text: 'When something goes wrong anyway' },
          { kind: 'list', items: [
            'Every change to the **lists** keeps the previous state: **Backup › Recent changes** lists them with a timestamp and puts one back – whether a form, the workbook or the terminal wrote it.',
            '**The personnel is not in there.** People are their own records, not configuration – an import that touches only the Mannschaft sheet does not appear under «Recent changes» at all. In exchange nobody is ever deleted there, only deactivated: undoing it means re-activating. To put the whole list back, use the file you downloaded before the import.',
            'The workbook is **not a backup**: it covers the lists only. The backup is the JSON export under **Backup**.',
          ] },
        ],
      },
    ],
  },
}
