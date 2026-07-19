"""Server-side i18n for user-facing error details.

Single-tenant: one deployment = one station = ONE language, taken from the deployment
config at ``identity.locale`` (default ``de-CH``). The frontend surfaces backend
``HTTPException`` ``detail`` strings verbatim in toasts, so we translate those details to
the configured locale at the edge (a global exception handler) instead of touching the
many raise sites.

The German source string is the translation KEY. If the configured locale is German, the
detail is unknown, or there's no translation for the base language, the original German is
returned unchanged — so a config-less DB (e.g. tests) keeps the German details intact.
"""

from __future__ import annotations

DEFAULT_LOCALE = "de-CH"

# German detail string (EXACT current value) -> {base-language: translation}.
# Base languages: en (English), fr (Suisse romande), it (Ticino). German is the source
# and therefore not stored here.
DETAIL_TRANSLATIONS: dict[str, dict[str, str]] = {
    "Alarm bereits übernommen": {
        "en": "Alarm already taken",
        "fr": "Alarme déjà prise en charge",
        "it": "Allarme già preso in carico",
    },
    "Alarm nicht im Pool": {
        "en": "Alarm not in pool",
        "fr": "Alarme absente du pool",
        "it": "Allarme non presente nel pool",
    },
    "Auto-Fetch (SharePoint/Graph) ist noch nicht aktiv": {
        "en": "Auto-fetch (SharePoint/Graph) is not active yet",
        "fr": "La récupération automatique (SharePoint/Graph) n'est pas encore active",
        "it": "Il recupero automatico (SharePoint/Graph) non è ancora attivo",
    },
    "Benutzer inaktiv": {
        "en": "User inactive",
        "fr": "Utilisateur inactif",
        "it": "Utente inattivo",
    },
    "Benutzer nicht gefunden": {
        "en": "User not found",
        "fr": "Utilisateur introuvable",
        "it": "Utente non trovato",
    },
    "Benutzername bereits vergeben": {
        "en": "Username already taken",
        "fr": "Nom d'utilisateur déjà utilisé",
        "it": "Nome utente già in uso",
    },
    "CSV-Kopfzeile fehlt oder enthält keine Spalte 'name'": {
        "en": "CSV header missing or has no 'name' column",
        "fr": "En-tête CSV manquant ou sans colonne 'name'",
        "it": "Intestazione CSV mancante o senza colonna 'name'",
    },
    "Datei ist nicht UTF-8 kodiert": {
        "en": "File is not UTF-8 encoded",
        "fr": "Le fichier n'est pas encodé en UTF-8",
        "it": "Il file non è codificato in UTF-8",
    },
    "Datensatz nicht gefunden": {
        "en": "Record not found",
        "fr": "Enregistrement introuvable",
        "it": "Record non trovato",
    },
    "Der letzte aktive Bearbeiter kann nicht deaktiviert oder herabgestuft werden.": {
        "en": "The last active editor cannot be deactivated or demoted.",
        "fr": "Le dernier éditeur actif ne peut pas être désactivé ni rétrogradé.",
        "it": "L'ultimo editor attivo non può essere disattivato né declassato.",
    },
    "Divera nicht konfiguriert (kein Access Key)": {
        "en": "Divera not configured (no access key)",
        "fr": "Divera non configuré (aucune clé d'accès)",
        "it": "Divera non configurato (nessuna chiave di accesso)",
    },
    "Einsatz nicht gefunden": {
        "en": "Incident not found",
        "fr": "Intervention introuvable",
        "it": "Intervento non trovato",
    },
    "Einsatz ist archiviert": {
        "en": "Incident is archived",
        "fr": "L'intervention est archivée",
        "it": "L'intervento è archiviato",
    },
    "Falscher Token-Typ": {
        "en": "Wrong token type",
        "fr": "Type de jeton incorrect",
        "it": "Tipo di token errato",
    },
    "Interner Fehler": {
        "en": "Internal error",
        "fr": "Erreur interne",
        "it": "Errore interno",
    },
    "Kein Auto-Fetch konfiguriert (manueller Upload)": {
        "en": "No auto-fetch configured (manual upload)",
        "fr": "Aucune récupération automatique configurée (téléversement manuel)",
        "it": "Nessun recupero automatico configurato (caricamento manuale)",
    },
    "Kein Refresh-Token": {
        "en": "No refresh token",
        "fr": "Aucun jeton de rafraîchissement",
        "it": "Nessun token di aggiornamento",
    },
    "Keine Wetterdaten für diese Koordinate": {
        "en": "No weather data for this coordinate",
        "fr": "Aucune donnée météo pour cette coordonnée",
        "it": "Nessun dato meteo per questa coordinata",
    },
    "kind muss 'photo' oder 'audio' sein": {
        "en": "kind must be 'photo' or 'audio'",
        "fr": "kind doit être 'photo' ou 'audio'",
        "it": "kind deve essere 'photo' o 'audio'",
    },
    "Bearbeiter-Berechtigung erforderlich": {
        "en": "Editor permission required",
        "fr": "Autorisation d'éditeur requise",
        "it": "Autorizzazione editor richiesta",
    },
    "lat und lng müssen beide oder keine gesetzt sein": {
        "en": "lat and lng must both be set or both omitted",
        "fr": "lat et lng doivent être tous deux définis ou tous deux omis",
        "it": "lat e lng devono essere entrambi impostati o entrambi omessi",
    },
    "Medium nicht gefunden": {
        "en": "Media not found",
        "fr": "Média introuvable",
        "it": "Media non trovato",
    },
    "near muss 'lng,lat' sein": {
        "en": "near must be 'lng,lat'",
        "fr": "near doit être 'lng,lat'",
        "it": "near deve essere 'lng,lat'",
    },
    "Nicht angemeldet": {
        "en": "Not signed in",
        "fr": "Non connecté",
        "it": "Non connesso",
    },
    "Nicht gefunden": {
        "en": "Not found",
        "fr": "Introuvable",
        "it": "Non trovato",
    },
    "Objekt nicht gefunden": {
        "en": "Object not found",
        "fr": "Objet introuvable",
        "it": "Oggetto non trovato",
    },
    "Person nicht gefunden": {
        "en": "Person not found",
        "fr": "Personne introuvable",
        "it": "Persona non trovata",
    },
    "Refresh-Token widerrufen": {
        "en": "Refresh token revoked",
        "fr": "Jeton de rafraîchissement révoqué",
        "it": "Token di aggiornamento revocato",
    },
    "Traccar nicht konfiguriert": {
        "en": "Traccar not configured",
        "fr": "Traccar non configuré",
        "it": "Traccar non configurato",
    },
    "Ungültiges Refresh-Token": {
        "en": "Invalid refresh token",
        "fr": "Jeton de rafraîchissement invalide",
        "it": "Token di aggiornamento non valido",
    },
    "Ungültiges Webhook-Secret": {
        "en": "Invalid webhook secret",
        "fr": "Secret de webhook invalide",
        "it": "Secret del webhook non valido",
    },
    "Wetterdienst nicht konfiguriert": {
        "en": "Weather service not configured",
        "fr": "Service météo non configuré",
        "it": "Servizio meteo non configurato",
    },
    "Zu viele Anfragen — bitte kurz warten.": {
        "en": "Too many requests — please wait a moment.",
        "fr": "Trop de requêtes — merci de patienter un instant.",
        "it": "Troppe richieste — attendere un momento.",
    },
    # Body-size middleware details (string detail, surfaced the same way).
    "Ungültige Content-Length": {
        "en": "Invalid Content-Length",
        "fr": "Content-Length invalide",
        "it": "Content-Length non valido",
    },
}

# Module-level cached locale (e.g. "de-CH", "fr-CH", "en", ...). Defaults to German so a
# config-less deployment (and the test DB) leaves details unchanged.
_locale: str = DEFAULT_LOCALE


def get_locale() -> str:
    """Return the currently cached deployment locale."""
    return _locale


def set_locale(loc: str | None) -> None:
    """Set the cached deployment locale; None/empty normalizes to the German default."""
    global _locale
    _locale = loc.strip() if (loc and loc.strip()) else DEFAULT_LOCALE


def translate_detail(detail: str) -> str:
    """Translate a German detail string to the cached locale's base language.

    Returns the original German unchanged when the locale is German, the detail is not in
    the table, or there's no translation for that base language.
    """
    base = _locale.split("-", 1)[0].lower()
    if base == "de":
        return detail
    return DETAIL_TRANSLATIONS.get(detail, {}).get(base, detail)
