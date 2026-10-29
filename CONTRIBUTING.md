# Contributing to Mellis

Thank you for helping. Mellis is a DIY project for people with type 1 diabetes; please keep safety first in every
change.

## Before you start

- For anything bigger than a small fix, open an issue first and describe what you want to change and why.
- Changes to dosing, forecasts, alerts or remote commands need a clear explanation, tests, and sources where a rule
  comes from the literature. Mellis suggests; it never decides for the caregiver.
- Discussions are welcome in Polish or English.

## No personal health data

Never put real health data in issues, pull requests, tests or fixtures: no glucose readings, doses, meals, Nightscout
addresses or tokens, patient names, screenshots with real values, API keys or `.p8` files. Use synthetic data.
For problems with a server, attach the report from `mellis` → **Status i logi** → **Raport do zgłoszenia**: it
contains no keys, medical data, names or server address.

## Development

```sh
npm ci
npm run build          # TypeScript
npm test               # unit tests (Postgres integration tests: RUN_POSTGRES_INTEGRATION=1 with TEST_DATABASE_URL)
bash scripts/tests/install-server.test.sh
bash scripts/install-app.test.sh
cd apps/ios && xcodegen generate && swift test
```

Details: [docs/local-development.md](docs/local-development.md). Database migrations are immutable once released: add
a new numbered migration and record its checksum in `infra/db/migration-checksums.json`.

## Sign your commits (DCO)

Mellis uses the [Developer Certificate of Origin](https://developercertificate.org/). By signing off a commit you
certify that you wrote the change or otherwise have the right to submit it under the project's licence. Add the
sign-off with `git commit -s`, which appends:

```
Signed-off-by: Your Name <your.email@example.com>
```

Pull requests with unsigned commits cannot be merged.

## Licence

By contributing you agree that your contribution is licensed under the GNU Affero General Public License v3.0
([LICENSE](LICENSE)). The name "Mellis" and the logo are not covered by that licence (see [NOTICE](NOTICE)).
