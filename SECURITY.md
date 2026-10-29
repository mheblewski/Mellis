# Security policy

Mellis handles health data and can send insulin commands to a loop, so security reports matter a lot to us.

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub: the repository's **Security** tab →
**Report a vulnerability** (private vulnerability reporting). Please include:

- what is affected (server, iOS app, installer, a specific version or commit),
- how to reproduce it, and what an attacker could do with it,
- no real health data, keys or tokens: use a test setup.

We will acknowledge the report as soon as we can (this is a volunteer project, usually within a few days), keep you
informed, and credit you in the release notes unless you prefer otherwise. Please give us a reasonable time to ship a
fix before publishing details.

## Supported versions

Only the latest release receives security fixes. Update the server with `mellis update` and the app
installer on your Mac (see the documentation, "Aktualizacje").

## Scope notes

- Each Mellis server is run by its owner; we have no access to any installation and cannot revoke keys for you.
- Remote bolus commands are signed on the phone and checked again by Trio or Loop; reports about bypassing the
  phone-side confirmation or the server-side signature checks are especially welcome.
