# Mellis user documentation

The site at https://mheblewski.github.io/Mellis/ (MkDocs Material, Polish), published by `.github/workflows/docs.yml`
on every push to main that changes this folder.

Preview locally:

```bash
python3 -m venv .venv && .venv/bin/pip install -r docs-site/requirements.txt
.venv/bin/mkdocs serve -f docs-site/mkdocs.yml
```

Writing rules: short sentences, one step per numbered item, every command in its own block, neutral wording about the
patient ("podopieczny", not "dziecko"), the caregiver as "opiekun". The banner in `overrides/main.html` says the
release is not out yet: remove it when 1.0 ships.
