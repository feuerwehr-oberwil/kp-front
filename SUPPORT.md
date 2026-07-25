# Support

## Who is behind this

KP Front is maintained by one person, in their own time, alongside a role in the fire service
this was built for. It is not a company and there is no support desk. Everything here is meant
to set expectations honestly rather than to lower them.

That said: this software runs real incidents at Feuerwehr Oberwil. When something is broken for
you, it is very likely broken for us too, and that is the strongest support guarantee on offer.

## What you can expect

| | |
| --- | --- |
| **Security reports** | Highest priority. See [`SECURITY.md`](SECURITY.md) – private advisory or email. |
| **Bugs that break an incident** | Taken seriously and quickly, because we run this too. |
| **Other bugs, questions, ideas** | Answered as time allows. Best effort, no SLA, no guaranteed response time. |
| **Uptime of your deployment** | Yours. This is self-hosted software; nobody is watching your instance. |
| **Managed hosting** | Not offered – see [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) §7. |

Please don't read silence as indifference. A polite reminder on a quiet thread is welcome, not
a nuisance.

## Where to ask what

- **Setting up a station, "how do I…", "is this the right tool for us"** →
  [Discussions](https://github.com/feuerwehr-oberwil/kp-front/discussions). Start with
  [`docs/SETUP.md`](docs/SETUP.md); if it did not answer your question, that is a documentation
  bug and we want to know.
- **Something is broken** →
  [open an issue](https://github.com/feuerwehr-oberwil/kp-front/issues/new?template=bug_report.md).
- **Something is missing** →
  [open a feature request](https://github.com/feuerwehr-oberwil/kp-front/issues/new?template=feature_request.md).
  Describe the situation at the Einsatz, not the solution you have in mind – the useful part is
  the case we haven't thought of.
- **A vulnerability** → [`SECURITY.md`](SECURITY.md). Never a public issue.
- **No GitHub account, or it's easier in German** → email
  [bastian@eichenbergers.ch](mailto:bastian@eichenbergers.ch). We would rather hear it in a
  three-line mail than not at all.

## What makes a report land faster

- The version (the app menu shows `v<version> · <commit> · <date>`; `/admin` → System has it too).
- What you did, what you expected, what happened instead.
- Whether the device was online, offline, or somewhere in between – a lot of behaviour depends
  on it.
- A screenshot. Dragging one into the issue form works.

**Never paste real operational data** – incident addresses, names from your roster, photos from
an Einsatz. Redact or describe. We do not need your data to fix your bug.

## What this project will not do for you

- Configure your station, import your geodata, or build your object plans.
  [`docs/STATION-DATA.md`](docs/STATION-DATA.md) is the guide; the work is yours.
- Guarantee suitability for your canton's requirements, or any certification. KP Front is a tool,
  not an approved system, and the operational responsibility stays with your command.
- Keep a fork working. If you modify it, you maintain it – though upstreaming the change is
  usually the cheaper path, and contributions are welcome
  ([`CONTRIBUTING.md`](CONTRIBUTING.md)).

## If this project stops

It is one maintainer, so the question is fair. KP Front is AGPL-3.0-or-later, the whole thing is
in this repository, deployment is a documented `docker compose up`, and your data is in your own
Postgres. If maintenance stops, a running deployment keeps running, and anyone can fork it. That
is the point of the licence.
