// Shared by KP Front and KP Rück: keep this file byte-identical in both repositories.
// Run in the head before CSS to avoid a flash. The default follows the OS; only a manual
// choice is persisted. Native picture sources cover the no-JavaScript case as well.
(function () {
  var root = document.documentElement;
  var key = 'kp-landing-theme';
  var system = window.matchMedia('(prefers-color-scheme: dark)');
  var choice = null;
  try { choice = localStorage.getItem(key); } catch (_) { /* Storage can be blocked. */ }
  if (choice !== 'light' && choice !== 'dark') choice = null;

  function apply() {
    var dark = choice ? choice === 'dark' : system.matches;
    root.dataset.theme = dark ? 'dark' : 'light';
    document.querySelectorAll('source[data-theme-dark]').forEach(function (source) {
      source.media = dark ? 'all' : 'not all';
    });
    document.querySelectorAll('.theme-toggle').forEach(function (button) {
      button.setAttribute('aria-pressed', String(dark));
      button.hidden = false;
    });
  }

  apply();
  document.addEventListener('DOMContentLoaded', function () {
    apply();
    document.querySelectorAll('.mobile-options').forEach(function (menu) {
      document.addEventListener('pointerdown', function (event) {
        if (!menu.contains(event.target)) menu.open = false;
      });
      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || !menu.open) return;
        menu.open = false;
        menu.querySelector('summary').focus();
        event.preventDefault();
      });
    });
    document.querySelectorAll('.theme-toggle').forEach(function (button) {
      button.addEventListener('click', function () {
        choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(key, choice); } catch (_) { /* Keep the in-page choice. */ }
        apply();
      });
    });
  });
  system.addEventListener('change', apply);
  window.addEventListener('storage', function (event) {
    if (event.key !== key && event.key !== null) return;
    var next = event.key === null ? null : event.newValue;
    choice = next === 'light' || next === 'dark' ? next : null;
    apply();
  });
})();
