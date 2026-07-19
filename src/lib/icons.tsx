// Minimal inline line-icon set for UI chrome (NOT tactical symbols — those come from FireGIS).
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden>
      <symbol id="cursor" viewBox="0 0 24 24"><path d="M5 3l15 6.5-6.5 2.2L11 21z" /></symbol>
      <symbol id="hex" viewBox="0 0 24 24"><path d="M12 3 20 7.5v9L12 21 4 16.5v-9z" /></symbol>
      <symbol id="pen" viewBox="0 0 24 24"><path d="M4 20l3.5-1 11-11-2.5-2.5L5 16.5z" /><path d="M14 6.5 17.5 10" /></symbol>
      <symbol id="area" viewBox="0 0 24 24"><path d="M5 7l7-3 7 4-2 9-9 2z" /></symbol>
      <symbol id="circle" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="1.3" /></symbol>
      <symbol id="type" viewBox="0 0 24 24"><path d="M5 5h14M12 5v14M9 19h6" /></symbol>
      <symbol id="people" viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5" /><path d="M16 5.2a3 3 0 0 1 0 5.8M21 20c0-2.6-1.6-4.5-4.2-5.1" /></symbol>
      <symbol id="mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" /></symbol>
      <symbol id="cam" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="12" cy="13.5" r="3.4" /><path d="M8 7l1.5-3h5L16 7" /></symbol>
      <symbol id="eye" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></symbol>
      <symbol id="eyeoff" viewBox="0 0 24 24"><path d="M3 3l18 18M10.6 6.2A9.5 9.5 0 0 1 12 6c6.5 0 10 6 10 6a16 16 0 0 1-3.3 3.8M6.4 7.7A15.7 15.7 0 0 0 2 12s3.5 6 10 6a9.4 9.4 0 0 0 3.2-.6" /></symbol>
      <symbol id="layers" viewBox="0 0 24 24"><path d="M12 3 3 8l9 5 9-5z" /><path d="M3 13l9 5 9-5" /></symbol>
      <symbol id="plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></symbol>
      <symbol id="minus" viewBox="0 0 24 24"><path d="M5 12h14" /></symbol>
      <symbol id="cross" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></symbol>
      <symbol id="locate" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" /><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" /></symbol>
      <symbol id="coords" viewBox="0 0 24 24"><path d="M5 9V5h4M15 5h4v4M19 15v4h-4M9 19H5v-4" /><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" /></symbol>
      <symbol id="sat" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18" /></symbol>
      <symbol id="map" viewBox="0 0 24 24"><path d="M9 4 3 6.5v14L9 18l6 2.5 6-2.5v-14L15 6.5z" /><path d="M9 4v14M15 6.5v14" /></symbol>
      <symbol id="doc" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12.5h6M9 16h6" /></symbol>
      <symbol id="truck" viewBox="0 0 24 24"><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7z" /><circle cx="7" cy="18" r="1.7" /><circle cx="17" cy="18" r="1.7" /></symbol>
      <symbol id="box" viewBox="0 0 24 24"><path d="M12 3 4 7v10l8 4 8-4V7z" /><path d="M4 7l8 4 8-4M12 11v10" /></symbol>
      <symbol id="warn" viewBox="0 0 24 24"><path d="M12 3.5 22 20.5H2z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.7" r=".4" /></symbol>
      <symbol id="drop" viewBox="0 0 24 24"><path d="M12 3.5c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z" /></symbol>
      <symbol id="radio" viewBox="0 0 24 24"><circle cx="12" cy="12" r="2" /><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M6 6a9 9 0 0 0 0 12M18 6a9 9 0 0 1 0 12" /></symbol>
      <symbol id="flag" viewBox="0 0 24 24"><path d="M6 3v18M6 4h11l-2.5 3.5L17 11H6" /></symbol>
      <symbol id="arrow" viewBox="0 0 24 24"><path d="M4 12h14M13 6l6 6-6 6" /></symbol>
      <symbol id="photo" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M3 17l5-4 4 3 3-2 6 5" /></symbol>
      <symbol id="snapshot" viewBox="0 0 24 24"><path d="M12 4v11M8 11l4 4 4-4M5 19h14" /></symbol>
      <symbol id="upload" viewBox="0 0 24 24"><path d="M12 15V4M8 8l4-4 4 4M5 19h14" /></symbol>
      <symbol id="wave" viewBox="0 0 24 24"><path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" /></symbol>
      <symbol id="sparkle" viewBox="0 0 24 24"><path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z" /></symbol>
      <symbol id="skip-back-15" viewBox="0 0 24 24"><path d="M11 6 5 12l6 6M19 6l-6 6 6 6" /></symbol>
      <symbol id="skip-fwd-15" viewBox="0 0 24 24"><path d="M13 6l6 6-6 6M5 6l6 6-6 6" /></symbol>
      <symbol id="search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M16 16l5 5" /></symbol>
      <symbol id="close" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></symbol>
      <symbol id="info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5" /><circle cx="12" cy="7.7" r=".5" /></symbol>
      <symbol id="more-vert" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none" /></symbol>
      <symbol id="compass" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 4.5 14.5 13 12 11 9.5 13z" fill="var(--red)" stroke="none" /><path d="M12 13v6" stroke-opacity=".4" /></symbol>
      <symbol id="undo" viewBox="0 0 24 24"><path d="M9 7 4 12l5 5" /><path d="M4 12h11a5 5 0 0 1 0 10h-2" /></symbol>
      <symbol id="redo" viewBox="0 0 24 24"><path d="M15 7l5 5-5 5" /><path d="M20 12H9a5 5 0 0 0 0 10h2" /></symbol>
      <symbol id="plus-bold" viewBox="0 0 24 24"><path d="M12 4v16M4 12h16" stroke-width="2.6" /></symbol>
      <symbol id="select" viewBox="0 0 24 24"><path d="M6 3.5 6 20 10.2 15.8 13 21 15.2 20 12.4 14.6 18.5 14.5z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /></symbol>
      <symbol id="history" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></symbol>
      <symbol id="clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></symbol>
      <symbol id="bell" viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 20a2 2 0 0 0 4 0" /></symbol>
      <symbol id="check" viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7" stroke-width="2.2" /></symbol>
      <symbol id="checklist" viewBox="0 0 24 24"><rect x="3.5" y="6.5" width="14" height="14" rx="2" /><path d="M8 3.5h10.5a2 2 0 0 1 2 2V16" /><path d="M6.8 12.4l1.5 1.5 2.7-3M13.2 13h2" /><path d="M6.8 17.2l1.5 1.5 2.7-3M13.2 17.8h2" /></symbol>
      <symbol id="lock" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2.2" /><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" /></symbol>
      <symbol id="play" viewBox="0 0 24 24"><path d="M7 4.8 19 12 7 19.2z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" /></symbol>
      <symbol id="pause" viewBox="0 0 24 24"><path d="M8 5h2.4v14H8zM13.6 5H16v14h-2.4z" fill="currentColor" /></symbol>
      <symbol id="chevron" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" /></symbol>
      <symbol id="chevron-down" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6" /></symbol>
      <symbol id="chevron-up" viewBox="0 0 24 24"><path d="M6 15l6-6 6 6" /></symbol>
      <symbol id="skipback" viewBox="0 0 24 24"><path d="M18.5 6 11 12l7.5 6V6z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /><path d="M6 5.5v13" stroke-width="2" stroke-linecap="round" /></symbol>
      <symbol id="skipfwd" viewBox="0 0 24 24"><path d="M5.5 6 13 12l-7.5 6V6z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" /><path d="M18 5.5v13" stroke-width="2" stroke-linecap="round" /></symbol>
      <symbol id="trash" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6" /></symbol>
      <symbol id="rotate" viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 1-2.4-5.7" /><path d="M20 4v4.2h-4.2" /></symbol>
      <symbol id="resize" viewBox="0 0 24 24"><path d="M10 4H4v6" /><path d="M4 4l7 7" /><path d="M14 20h6v-6" /><path d="M20 20l-7-7" /></symbol>
      <symbol id="move" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" /></symbol>
      <symbol id="measure" viewBox="0 0 24 24"><path d="M3 14.5 14.5 3 21 9.5 9.5 21z" /><path d="M7 10.5l2 2M10.5 7l2.5 2.5M14 3.5l2 2" /></symbol>
      <symbol id="polygon" viewBox="0 0 24 24"><path d="M12 3.5 20 9 17 19.5 7 19.5 4 9z" /><circle cx="12" cy="3.5" r="1.5" fill="currentColor" stroke="none" /><circle cx="20" cy="9" r="1.5" fill="currentColor" stroke="none" /><circle cx="17" cy="19.5" r="1.5" fill="currentColor" stroke="none" /><circle cx="7" cy="19.5" r="1.5" fill="currentColor" stroke="none" /><circle cx="4" cy="9" r="1.5" fill="currentColor" stroke="none" /></symbol>
      <symbol id="logout" viewBox="0 0 24 24"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M9 12h11M16 8l4 4-4 4" /></symbol>
      <symbol id="swap" viewBox="0 0 24 24"><path d="M4 9h13l-3-3M20 15H7l3 3" /></symbol>
      <symbol id="footprint" viewBox="0 0 24 24"><path d="M4 20V8h8V4h8v16z" /></symbol>
      <symbol id="bell" viewBox="0 0 24 24"><path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M9.5 19a2.5 2.5 0 0 0 5 0" /></symbol>
      <symbol id="bell-off" viewBox="0 0 24 24"><path d="M3 3l18 18" /><path d="M8.2 6.1A6 6 0 0 1 18 11v5l1.8 1.8M6 11.4V16l-2 2h12.6" /><path d="M9.5 19a2.5 2.5 0 0 0 5 0" /></symbol>
      <symbol id="gauge" viewBox="0 0 24 24"><circle cx="12" cy="10.5" r="7" /><path d="M12 10.5 15.4 7.9" /><circle cx="12" cy="10.5" r="1.2" fill="currentColor" stroke="none" /><path d="M10.7 17.4h2.6v1.6a1.3 1.3 0 0 1-2.6 0z" /><path d="M12 4.6v1.3M17.6 8.7l-1.2.5M6.4 8.7l1.2.5" stroke-opacity=".55" /></symbol>
      <symbol id="marquee" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" stroke-dasharray="3.4 3" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" fill="currentColor" stroke="none" /></symbol>
      <symbol id="gear" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.1" /><path d="M19.4 13.5a1.7 1.7 0 0 0 .34 1.87l.05.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-2.87 1.2V21a2 2 0 0 1-4 0v-.08a1.7 1.7 0 0 0-2.88-1.21l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 1.2-2.87H3a2 2 0 0 1 0-4h.09a1.7 1.7 0 0 0 1.2-2.88l-.05-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 2.87-1.2V3a2 2 0 0 1 4 0v.09a1.7 1.7 0 0 0 2.88 1.2l.06-.05a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-1.2 2.87V10.5a1.7 1.7 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.08a1.7 1.7 0 0 0-1.52.99z" /></symbol>
      <symbol id="wind" viewBox="0 0 24 24"><path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5" /><path d="M3 16h15a2.5 2.5 0 1 1-2.5 2.5" /><path d="M3 12h7a2 2 0 1 0-2-2" /></symbol>
      <symbol id="moon" viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></symbol>
      <symbol id="sun" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2" /><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.2 5.2l1.7 1.7M17.1 17.1l1.7 1.7M18.8 5.2l-1.7 1.7M6.9 17.1l-1.7 1.7" /></symbol>
      <symbol id="wx-cloud" viewBox="0 0 24 24"><path d="M7 18a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1.06A3.75 3.75 0 0 1 17 18z" /></symbol>
      <symbol id="wx-partly" viewBox="0 0 24 24"><circle cx="8" cy="8" r="3.2" /><path d="M8 1.8v1.6M1.8 8h1.6M3.6 3.6l1.1 1.1M12.4 3.6l-1.1 1.1" /><path d="M9 19a3.5 3.5 0 0 1-.4-6.98 4.8 4.8 0 0 1 9.2-.9A3.3 3.3 0 0 1 18 19z" /></symbol>
      <symbol id="wx-rain" viewBox="0 0 24 24"><path d="M7 15a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1.06A3.75 3.75 0 0 1 17 15z" /><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5" /></symbol>
      <symbol id="wx-snow" viewBox="0 0 24 24"><path d="M7 14a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1.06A3.75 3.75 0 0 1 17 14z" /><path d="M8.5 18.5v2M11.5 17.5v2M14.5 18.5v2" stroke-linecap="round" /></symbol>
      <symbol id="wx-fog" viewBox="0 0 24 24"><path d="M7 12a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1.06A3.75 3.75 0 0 1 17 12z" /><path d="M5 16h14M7 19.5h12" stroke-linecap="round" /></symbol>
      <symbol id="wx-storm" viewBox="0 0 24 24"><path d="M7 14a4 4 0 0 1-.5-7.97 5.5 5.5 0 0 1 10.6-1.06A3.75 3.75 0 0 1 17 14z" /><path d="M12 14l-2.5 4h3l-2 3.5" /></symbol>
      <symbol id="share-ios" viewBox="0 0 24 24"><path d="M8 8.5H6.5A1.8 1.8 0 0 0 4.7 10.3v8.4a1.8 1.8 0 0 0 1.8 1.8h11a1.8 1.8 0 0 0 1.8-1.8v-8.4a1.8 1.8 0 0 0-1.8-1.8H16" /><path d="M12 14V3M8.5 6.5 12 3l3.5 3.5" /></symbol>
    </svg>
  )
}

export function Icon({ id, className }: { id: string; className?: string }) {
  return (
    <svg className={`i ${className ?? ''}`}><use href={`#${id}`} /></svg>
  )
}
