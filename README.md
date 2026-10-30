# Mellis

**A calm assistant for people with type 1 diabetes and their caregivers.** Mellis reads your Nightscout, helps you
count a meal (also from a photo), reminds you about the second part of a split bolus, warns about a coming low and
answers questions about what your glucose is doing. It works with **Trio** and **Loop**, and can send a bolus or
carbs to the loop straight from the phone, every command confirmed with Face ID.

You install Mellis yourself, the way you build Trio or Loop: **your own server, your own AI key, your own Apple
Developer account.** There is no central service, no accounts and no analytics; your data stays with you and the AI
provider you choose (OpenAI or Anthropic).

Documentation (Polish): **https://mheblewski.github.io/Mellis/**

> [!NOTE]
> **Mellis is currently available in Polish only** (app, notifications, AI answers, installers and documentation).
> English is planned for version 1.1.

> [!WARNING]
> **Mellis is a DIY project, not a medical device.** It has no CE mark and no FDA clearance. Dose, carb and setting
> suggestions are hints; you always decide. The AI can be wrong, notifications can be late or never arrive. Do not
> turn off your CGM or loop alarms, and discuss therapy changes with your diabetes team. You build and run Mellis at
> your own risk; the authors accept no liability for its use (see the licence, sections 15 and 16).

## Quick start

1. On a small Linux server (Ubuntu 24.04 or Debian 12, 1 GB RAM, also with Nightscout on the same server):

   ```sh
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.2/scripts/install-server.sh)"
   ```

2. On your Mac, the command the server installer prints at the end (it carries your server address and setup code):

   ```sh
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.2/scripts/install-app.sh)" -- --server https://<your server> --code <setup code>
   ```

   It builds the iOS app with your Apple Developer account, installs it on your iPhone and pairs it with the server.

The step-by-step guide, including what to prepare first, is in the
[installation docs](https://mheblewski.github.io/Mellis/instalacja/).

## Requirements

- A Linux server with Docker (the installer sets it up): Ubuntu 24.04 / Debian 12, at least 1 GB RAM.
- A Nightscout site and a read-only token. Trio or Loop for remote commands (optional).
- An AI API key: OpenAI or Anthropic (paid per use; you set a monthly limit during installation).
- An Apple Push Notification key (`.p8`, Key ID, Team ID).
- A Mac with current Xcode and a paid Apple Developer account; an iPhone with iOS 17 or later (widgets and Live Activity: iOS 18).

## Repository layout

| Path | What |
|---|---|
| `apps/api`, `apps/worker` | Node.js (NestJS) API and background worker |
| `apps/ios` | SwiftUI app, widgets and Live Activity (XcodeGen project) |
| `modules/`, `shared/`, `infra/` | domain modules, shared primitives, database (Postgres + pgvector) and migrations |
| `knowledge/` | the knowledge base the assistant cites (sources and licences in `knowledge/LICENSES.md`) |
| `deploy/` | Docker Compose stack, Caddy, backup script, admin SQL |
| `scripts/` | server and app installers, version sync, evaluation tools |
| `docs-site/` | the user documentation (MkDocs) |
| `docs/` | design notes for developers |

Development: `npm ci`, `npm run build`, `npm test`; iOS: `cd apps/ios && xcodegen generate && swift test`. See
[docs/local-development.md](docs/local-development.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Support

Mellis is free for every family and will stay free. If it helps you, you can support its development on Suppi.
Support is entirely voluntary and unlocks no features.

<a href="https://suppi.pl/mellis" target="_blank"><img width="182" src="https://suppi.pl/api/widget/button.svg?fill=0E5A61&textColor=ffffff" alt="Wesprzyj Mellis na Suppi"/></a>

## Licence

Mellis is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public
License, version 3** ([LICENSE](LICENSE)). If you run a modified version for other people, also as a network service,
you must offer them its source code under the same licence.

The name **Mellis** and the hummingbird logo are **not** licensed under the AGPL: see [NOTICE](NOTICE). Forks must
use a different name and icon.

Knowledge base documents keep their own licences and attribution: [knowledge/LICENSES.md](knowledge/LICENSES.md).

## Credits

Mellis stands on the work of the DIY diabetes community: [Nightscout](https://nightscout.github.io/),
[Trio](https://github.com/nightscout/Trio), [Loop](https://loopkit.github.io/loopdocs/),
[OpenAPS](https://openaps.org/) and [AndroidAPS](https://androidaps.readthedocs.io/). Their documentation and
algorithms (oref) inform the forecasts and the knowledge base; see [knowledge/LICENSES.md](knowledge/LICENSES.md) and
[knowledge/SOURCES.md](knowledge/SOURCES.md) for every source and its licence. Mellis is not affiliated with or
endorsed by any of these projects.

## Privacy

Your family's server is the only place Mellis keeps your data; the authors have no access to it. What goes to
Nightscout, the AI provider, Apple and the other services, and how to delete everything:
[Polityka prywatności](https://mheblewski.github.io/Mellis/pomoc/prywatnosc/) (Polish).

## Security

Please report vulnerabilities privately, see [SECURITY.md](SECURITY.md). Never post health data, keys or tokens in
issues.
