---
id: mellis-split-advice-v1
title: "Mellis split-advice.v1 (2026-10-22): kiedy i jak aplikacja dzieli bolus na tłusty posiłek – proporcja WBT/WW i udział tłuszczu zamiast gramów, 70/30 i 60/40, uzasadnienie i źródła"
year: 2026
url: https://github.com/mheblewski/Mellis/tree/main/knowledge/split-advice
licence: "Own text (Mellis)"
mode: SUMMARY_ONLY
language: pl
retrieved: 2026-10-21
topics: [split-bolus, fat-protein, glucomind-rule]
index: true
corpus_v7: split-advice/glucomind-split-advice-v1.md
---

*Mellis own document (the app's split-advice rule and its rationale).*

# Mellis: jak aplikacja decyduje o podziale bolusa na posiłek (split-advice.v1, 22.10.2026)

How the Mellis app decides to split a meal bolus (split-advice.v1). Rule used by the app's bolus cards; this text explains why.

## Reguła
- Aplikacja nie patrzy na gramy tłuszczu i białka, tylko na ich proporcję do węglowodanów w tym posiłku:
  - WBT na WW = ((4 × białko + 9 × tłuszcz) / 100) / (węglowodany / 10), czyli wymienniki białkowo-tłuszczowe na wymiennik węglowodanowy (metoda warszawska, Pańkowska);
  - udział tłuszczu w energii posiłku = 9 × tłuszcz / (4 × węglowodany + 4 × białko + 9 × tłuszcz).
- Od 0,5 WBT/WW albo od 35% energii z tłuszczu: podział 70/30 – 70% węglowodanów z ich dawką teraz, reszta węglowodanów z dawką po ok. 60 min.
- Od 0,8 WBT/WW albo od 40% energii z tłuszczu: podział 60/40 – reszta po ok. 90 min.
- Nigdy mniej niż 60% dawki od razu. Posiłek poniżej 10 g węglowodanów albo druga część poniżej 4 g: jeden bolus.
- Jeśli podobny posiłek tego dziecka wcześniej dał spadek w pierwszych 2 h i późny wzrost, zalecenie idzie o stopień wyżej (70/30 → 60/40; tuż pod progiem → 70/30).
- Dzieli się tylko dawkę na węglowodany. Insulina na białko i tłuszcz (WBT) to osobne przypomnienie ok. 2,5 h po posiłku. Aplikacja nie dolicza automatycznie insuliny ponad ICR.
- Przykład: pół małych frytek z McDonald's i 6 nuggetsów (ok. 34 g W, 18 g B, 20 g T) = ok. 0,75 WBT/WW, tłuszcz ok. 46% energii → 60/40, druga część po ok. 90 min.

## Dlaczego proporcja, a nie gramy (Why a ratio and not grams)
- Badania nad tłustymi posiłkami używały zwykle 30–40 g tłuszczu (porcje starszych nastolatków i dorosłych). Mała porcja dziecka z 15–20 g tłuszczu przechodziła pod progiem w gramach, choć w proporcji do jej węglowodanów jest bardzo tłusta.
- Przegląd badań u dzieci (Furthner i wsp., Nutrients 2021) stwierdza brak uzgodnionego progu, od którego liczyć tłuszcz i białko, oraz że posiłków testowych zwykle nie dostosowywano do wieku.
- W badaniu dzieci 4–17 lat z posiłkiem dobranym do wieku (van der Hoogt 2017: ok. 40 g W, 15 g T, 27 g B) posiłek tłusto-białkowy i tak wymagał ok. 30% więcej insuliny i dłuższej opieki (do 6 h).
- ISPAD 2022 (żywienie): dostosowanie dawki, gdy u danego dziecka widać wpływ tłuszczu i białka na glukozę po posiłku; indywidualnie.
- Proporcja skaluje się sama z wielkością porcji: ten sam tłuszcz przy talerzu 80 g węglowodanów (dorosły) daje ok. 0,35 WBT/WW i jeden bolus.

## Dlaczego co najmniej 60% od razu i dlaczego 60/40 przy bardzo tłustym posiłku
- Lopez i wsp., Diabet Med 2017 (dzieci i młodzież na pompie, posiłek tłusto-białkowy): pełny bolus oraz podziały 70/30 i 60/40 tak samo kontrolowały pierwsze 2 h; więcej insuliny w drugiej części zmniejszało wzrost po 4–5 h; potrzeba co najmniej 60% od razu.
- Lopez i wsp. 2014: sam bolus przedłużony nie kontroluje wczesnego wzrostu.
- Smart i wsp., Diabetes Care 2013 (dzieci 8–17 lat): tłuszcz i białko podnoszą glukozę od ok. 3 h po posiłku, efekty się sumują; białko chroni przed wczesnym spadkiem.
- Po tłustym posiłku opisywano wczesny spadek, a potem podwyższoną glukozę do ok. 5 h (przegląd Furthner 2021) – cały bolus od razu działa, zanim węglowodany zdążą się wchłonąć.
- Szpital dziecięcy John Hunter (Paterson, Smith, King, Smart 2019): w praktyce podział 60/40 lub 70/30 na 2–3 h przy posiłkach tłusto-białkowych.

## Dlaczego nie dokładać insuliny automatycznie
- Pełna metoda warszawska (dodatkowa insulina na WBT w bolusie) u dzieci zwiększała liczbę niedocukrzeń: 35,7% vs 9,5% posiłków (Kordonouri 2012); więcej niedocukrzeń także w Lopez 2018. Dawki 145–160% ICR zwiększały ryzyko niedocukrzenia (Smith 2021, Paterson 2020).

## Pętla (Trio) a tłusty posiłek
- Pętla sama dodaje insulinę przy późnym wzroście, ale to zwykle nie wystarcza: u dzieci z MiniMed 670G tryb automatyczny nie poprawił glukozy po pizzy i lazanii względem ręcznego (Lim 2023); Control-IQ u nastolatków dodawał 26–55% insuliny, a czas w zakresie i tak spadał (Marigliano 2026).
- Gdy wszystkie węglowodany są wpisane od razu, pętla nie zapobiegnie wczesnemu spadkowi – dlatego aplikacja przy podziale wysyła resztę węglowodanów razem z drugą częścią dawki.

## Prognoza na karcie
- Prognoza w aplikacji nie zakłada opóźnionego wchłaniania przy tłustym posiłku; tłuszcz i białko mogą jednak podnosić glukozę później (od 0,5 WBT/WW albo 35% tłuszczu) – stąd podział dawki. To tylko prognoza, zakłada, że pętla nic więcej nie zrobi.
