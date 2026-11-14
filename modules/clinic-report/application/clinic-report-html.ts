import { plDecimal as f, type ClinicReportData, type PeriodMetrics } from './clinic-report-data';

/**
 * The clinic report as one HTML document of fixed A4 pages (210 × 297 mm sections), printed by the app to PDF page by
 * page. Same design as the mockup the roles reviewed (docs/product/clinic-report-review.md).
 */
const PETROL = '#0e5a61';
const VLOW = '#9b1c22'; const LOW = '#e0443c'; const TIR = '#2f9e55'; const HIGH = '#f2b134'; const VHIGH = '#e07b1f';
const WD = ['pon.', 'wt.', 'śr.', 'czw.', 'pt.', 'sob.', 'niedz.'];
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const hm = (t: string) => t.replace(/^0(\d)/, '$1');
const pct = (x: number | null | undefined, k = 1) => `${f(x, k)}%`;

/** The difference only: no green/red judgement of a change (role review 2026-11-12). */
function change(cur: PeriodMetrics, prev: PeriodMetrics | null, key: keyof PeriodMetrics, k: number, unit: string): string {
  if (!prev) return '';
  const v = (cur[key] as number) - (prev[key] as number);
  const minimal = ({ gmi: 0.1, vlow: 0.1, mean: 1 } as Record<string, number>)[key] ?? 0.5;
  if (Math.abs(v) < minimal) return '<span class="chg same">bez zmian</span>';
  return `<span class="chg">${v > 0 ? '+' : '−'}${f(Math.abs(v), k)} ${unit}</span>`;
}

function dailyProfile(d: ClinicReportData): string {
  const W = 720; const H = 236; const XL = 46; const XR = 40; const Y0 = 14; const B = 24;
  const y = (g: number) => Y0 + (H - B - Y0) * (1 - (Math.min(Math.max(g, 40), 350) - 40) / 310);
  const step = (W - XL - XR) / 96;
  const xc = (i: number) => XL + step * (i + 0.5);
  const xm = (m: number) => XL + (step * m) / 15;
  const bw = step * 0.62;
  let parts = '';
  d.profile.forEach((s, i) => {
    if (!s) return;
    const [p10, p25, , p75, p90] = s;
    const x = xc(i);
    const whisk = (a: number, b: number, col: string) => (b > a ? `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(a).toFixed(1)}" y2="${y(b).toFixed(1)}" stroke="${col}" stroke-width="1.1" stroke-linecap="round"/>` : '');
    const seg = (a: number, b: number, col: string) => (b > a ? `<rect x="${(x - bw / 2).toFixed(1)}" y="${y(b).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(y(a) - y(b), 0.8).toFixed(1)}" rx="${(bw / 2).toFixed(1)}" fill="${col}"/>` : '');
    parts += whisk(Math.max(p10, 70), Math.min(p90, 180), '#c3c9d0') + whisk(Math.max(p10, 180), p90, '#f2c230') + whisk(p10, Math.min(p90, 70), LOW);
    parts += seg(Math.max(p25, 70), Math.min(p75, 180), '#d5dae0') + seg(Math.max(p25, 180), p75, '#f2c230') + seg(p25, Math.min(p75, 70), '#ee5a52');
  });
  const med = d.profile.map((s, i) => (s ? [xc(i), y(s[2])] : null)).filter((p): p is number[] => p !== null);
  const medPath = `M${med.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' L')}`;
  const dots = med.filter((_, k) => k % 2 === 0).map(([a, b]) => `<circle cx="${a.toFixed(1)}" cy="${b.toFixed(1)}" r="1.7"/>`).join('');
  const grid = [100, 150, 200, 250, 300].map((g) => `<line x1="${XL}" x2="${W - XR}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" stroke="#eef0f3"/><text x="${W - XR + 6}" y="${(y(g) + 3.5).toFixed(1)}">${g}</text>`).join('');
  const xaxis = Array.from({ length: 25 }, (_, h) => `<line x1="${xm(h * 60).toFixed(1)}" x2="${xm(h * 60).toFixed(1)}" y1="${H - B}" y2="${H - B + (h % 3 === 0 ? 5 : 3)}" stroke="#9aa3ad"/>${h % 3 === 0 ? `<text x="${xm(h * 60).toFixed(1)}" y="${H - 7}" text-anchor="middle">${String(h).padStart(2, '0')}:00</text>` : ''}`).join('');
  const pill = (g: number, col: string) => `<line x1="${XL}" x2="${W - XR}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" stroke="${col}" stroke-width="1.5"/><rect x="4" y="${(y(g) - 8).toFixed(1)}" width="${XL - 8}" height="16" rx="8" fill="${col}"/><text x="${4 + (XL - 8) / 2}" y="${(y(g) + 3.6).toFixed(1)}" text-anchor="middle" class="pill">${g}</text>`;
  const marks = [...new Map(d.changes.filter((c) => c.startMinute !== null && c.startMinute > 0).map((c) => [c.startMinute as number, c])).values()].slice(0, 4)
    .map((c) => `<line x1="${xm(c.startMinute as number).toFixed(1)}" x2="${xm(c.startMinute as number).toFixed(1)}" y1="${Y0}" y2="${H - B}" stroke="${PETROL}" stroke-dasharray="3,3"/><text x="${(xm(c.startMinute as number) + 3).toFixed(1)}" y="${Y0 + 9}" class="mark">${esc(c.label.split(' ')[0])} (${c.date})</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" xmlns="http://www.w3.org/2000/svg">
<rect x="${XL}" y="${Y0}" width="${W - XL - XR}" height="${H - B - Y0}" fill="#fff" stroke="#cfd5dc"/>${grid}<text x="${W - XR + 6}" y="${Y0 - 3}">mg/dl</text>
<line x1="${XL}" x2="${W - XR}" y1="${y(54).toFixed(1)}" y2="${y(54).toFixed(1)}" stroke="${VLOW}" stroke-dasharray="3,3"/><text x="${W - XR + 6}" y="${(y(54) + 3.5).toFixed(1)}" fill="${VLOW}">54</text>
${marks}${parts}${pill(180, '#f0a531')}${pill(70, LOW)}
<path d="${medPath}" fill="none" stroke="#1b2430" stroke-width="1.6" stroke-linejoin="round"/><g fill="#1b2430">${dots}</g>
<line x1="${XL}" x2="${W - XR}" y1="${H - B}" y2="${H - B}" stroke="#9aa3ad"/>${xaxis}</svg>`;
}

function dayRow(days: ClinicReportData['days'], perRow: number, uid: number): string {
  const W = 720; const H = 126; const XL = 28; const XR = 6; const T = 14; const Bm = 14;
  const y = (g: number) => T + (H - T - Bm) * (1 - (Math.min(Math.max(g, 40), 330) - 40) / 290);
  const dw = (W - XL - XR) / perRow;
  const out: string[] = [`<rect x="${XL}" y="${y(180).toFixed(1)}" width="${(dw * days.length).toFixed(1)}" height="${(y(70) - y(180)).toFixed(1)}" fill="#eef7f1"/>`];
  for (const [g, col] of [[70, LOW], [180, '#f0a531']] as Array<[number, string]>) {
    out.push(`<line x1="${XL}" x2="${(XL + dw * days.length).toFixed(1)}" y1="${y(g).toFixed(1)}" y2="${y(g).toFixed(1)}" stroke="${col}" stroke-width=".6" stroke-dasharray="2,2"/><text x="${XL - 3}" y="${(y(g) + 3).toFixed(1)}" text-anchor="end" class="ax">${g}</text>`);
  }
  let path = '';
  days.forEach((day, k) => {
    const x0 = XL + dw * k;
    out.push(`<line x1="${x0.toFixed(1)}" x2="${x0.toFixed(1)}" y1="${T - 10}" y2="${H - Bm + 2}" stroke="#9aa3ad" stroke-width="${k ? 1 : 0.6}"/>`);
    out.push(`<text x="${(x0 + 4).toFixed(1)}" y="${T - 2}" class="dl">${WD[day.weekday]} ${Number(day.date.slice(8))}.${day.date.slice(5, 7)}</text>`);
    for (const hh of [6, 12, 18]) {
      const xx = x0 + (dw * hh) / 24;
      out.push(`<line x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${H - Bm}" y2="${H - Bm + 2.5}" stroke="#9aa3ad" stroke-width=".6"/><text x="${xx.toFixed(1)}" y="${H - 2}" text-anchor="middle" class="ax">${hh}</text>`);
    }
    let prev: number | null = null;
    for (const [m, v] of day.points) { path += `${prev === null || m - prev > 25 ? 'M' : 'L'}${(x0 + (dw * m) / 1440).toFixed(1)},${y(v).toFixed(1)} `; prev = m; }
  });
  const end = XL + dw * days.length;
  out.push(`<line x1="${end.toFixed(1)}" x2="${end.toFixed(1)}" y1="${T - 10}" y2="${H - Bm + 2}" stroke="#9aa3ad" stroke-width=".6"/>`);
  out.push(`<clipPath id="r${uid}lo"><rect x="0" y="${y(70).toFixed(1)}" width="${W}" height="${H}"/></clipPath><clipPath id="r${uid}hi"><rect x="0" y="0" width="${W}" height="${y(180).toFixed(1)}"/></clipPath>`);
  out.push(`<path d="${path}" fill="none" stroke="#1b2430" stroke-width="1.1" stroke-linejoin="round"/>`);
  out.push(`<path d="${path}" fill="none" stroke="${LOW}" stroke-width="1.6" clip-path="url(#r${uid}lo)"/><path d="${path}" fill="none" stroke="#e8a317" stroke-width="1.6" clip-path="url(#r${uid}hi)"/>`);
  return `<svg viewBox="0 0 ${W} ${H}" class="dayrow" xmlns="http://www.w3.org/2000/svg">${out.join('')}</svg>`;
}

const tint = (v: number, lo: number, hi: number, rgb: string) => {
  const a = v <= lo ? 0 : Math.min(1, (v - lo) / (hi - lo));
  return a > 0 ? `background:rgba(${rgb},${(0.08 + 0.42 * a).toFixed(2)})` : '';
};

export function renderClinicReportHtml(d: ClinicReportData): string {
  const c = d.current; const p = d.previous;
  const who = `${esc(d.patient.name)}${d.patient.birthYear ? `, rocznik ${d.patient.birthYear}` : ''}`;
  const sub = `${who} · ${d.period.from}–${d.period.to}`;
  const footer = (n: number) => `<footer><span>Mellis — aplikacja rodzinna, nie wyrób medyczny. Dane z Nightscout.</span><span>Strona ${n} z 4</span></footer>`;
  const head = (title: string) => `<header class="top"><div><div class="brand">MELLIS</div><h1 style="font-size:13pt">${title}</h1></div><div class="small">${sub}</div></header>`;
  const ok = (good: boolean) => `<span class="dot ${good ? 'ok' : 'warn'}"></span>`;

  const row = (label: string, key: keyof PeriodMetrics, unit = '%', k = 1, goal = '', dunit = 'p.p.') =>
    `<tr><td>${label}</td><td class="num strong">${f(c[key] as number, k)}${unit}</td><td class="num muted">${p ? `${f(p[key] as number, k)}${unit}` : '–'}</td><td class="num">${change(c, p, key, k, dunit)}</td><td class="num muted">${goal}</td></tr>`;
  const cgm = [
    row('Czas w zakresie 70–180', 'tir', '%', 1, '&gt;70%'), row('Czas 70–140', 'titr'),
    row('Poniżej 70', 'tbr', '%', 1, '&lt;4%'), row('Poniżej 54', 'vlow', '%', 1, '&lt;1%'),
    row('Powyżej 180', 'tar', '%', 1, '&lt;25%'), row('Powyżej 250', 'vhigh', '%', 1, '&lt;5%'),
    row('Średnia glukoza (mg/dl)', 'mean', '', 0, '', 'mg/dl'), row('GMI', 'gmi'), row('Współczynnik zmienności', 'cv', '%', 1, '≤36%'),
    row('Aktywność CGM', 'wear', '%', 0, '&gt;70%'), row('Praca w pętli zamkniętej', 'loop', '%', 0),
  ].join('');
  const bands: Array<[string, string, number, string]> = [['&gt;250', 'poziom 2', c.vhigh, VHIGH], ['181–250', 'poziom 1', c.high, HIGH], ['70–180', 'w zakresie', c.tir, TIR], ['54–69', 'poziom 1', c.low, LOW], ['&lt;54', 'poziom 2', c.vlow, VLOW]];
  const bar = bands.map(([, , v, col]) => `<div class="seg" style="flex:${Math.max(v, 1.6).toFixed(2)};background:${col}"></div>`).join('');
  const barLabels = bands.map(([r, n, v]) => `<div class="bl" style="flex:${Math.max(v, 6).toFixed(2)}"><b>${pct(v)}</b> <span>${r} · ${n}</span></div>`).join('');
  const changes = d.changes.length
    ? d.changes.map((x) => `<tr><td>${x.date}</td><td>${esc(x.label)}</td><td class="num">${x.before}</td><td class="num strong">${x.after}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">Brak zmian ustawień w Trio w tym okresie.</td></tr>';
  const tod = d.blocks.map((b) => `<tr><td>${String(b.hour).padStart(2, '0')}:00–${String(b.hour + 3).padStart(2, '0')}:00</td>`
    + `<td class="num" style="${tint(b.tir < 70 ? 70 - b.tir : 0, 0, 20, '224,123,31')}">${pct(b.tir)}</td><td class="num" style="${tint(b.tbr, 4, 10, '224,68,60')}">${pct(b.tbr)}</td>`
    + `<td class="num" style="${tint(b.tar, 25, 45, '224,123,31')}">${pct(b.tar)}</td><td class="num">${b.median}</td><td class="num">${b.episodes}</td><td class="num">${b.level2}</td></tr>`).join('');
  const ins = d.insulin;
  const share = (x: number) => (ins.tdd ? `${f((100 * x) / ins.tdd, 0)}%` : '–');
  const basalRows = d.basal.map((b) => `<tr class="${(b.smbZeroShare ?? 0) >= 50 ? 'flag' : ''}"><td>${hm(b.from)}–${hm(b.to)}</td><td class="num">${f(b.value, 2)}</td><td class="num">${b.smbZeroShare ? `${b.smbZeroShare}%` : '–'}</td><td class="num">${b.maxTemp !== null ? f(b.maxTemp, 1) : '–'}</td></tr>`).join('');
  const icrRows = d.icr.map((r) => `<tr><td>${hm(r.from)}–${hm(r.to)}</td><td class="num strong">${f(r.value)}</td><td class="num muted">${r.before !== null ? f(r.before) : ''}</td></tr>`).join('');
  const isfRows = d.isf.map((r) => `<tr><td>${hm(r.from)}–${hm(r.to)}</td><td class="num">${f(r.value, 0)}</td><td class="num strong">${r.used ?? '–'}</td></tr>`).join('');
  const targetRows = d.target.map((r) => `<tr><td>${hm(r.from)}–${hm(r.to)}</td><td class="num">${f(r.value, 0)}</td></tr>`).join('');
  const lowRows = d.lowRows.map((r) => `<tr><td>${String(r.hour).padStart(2, '0')}:00–${String(r.hour + 3).padStart(2, '0')}:00</td><td class="num strong">${r.n}</td><td class="num">${r.level2}</td><td class="num">${r.under2h}</td><td class="num">${r.from2to4h}</td><td class="num">${r.over4h}</td><td class="num">${r.iobMedian !== null ? f(r.iobMedian) : '–'}</td><td class="num">${r.carbsBefore}</td></tr>`).join('');
  // "3 rzeczy na wizytę" (plan to 9/10, 4.2): the first three patterns, lows first, one sentence each, on page 1.
  const topThree = d.patterns.length
    ? `<div class="card" style="margin:6pt 0"><h3>Na wizytę</h3>${d.patterns.slice(0, 3).map((x, i) => `<div style="margin-top:2pt"><b>${i + 1}. ${esc(x.title)}.</b> ${esc(x.sentence)}</div>`).join('')}</div>`
    : '';
  const patterns = d.patterns.length
    ? d.patterns.map((x) => `<div class="card"><h3>${esc(x.title)}</h3>${esc(x.sentence)}</div>`).join('')
    : '<p class="muted">W tym okresie nic się nie powtarza.</p>';
  const questions = d.questions.length
    ? d.questions.map((q) => `<div class="q"><div class="box"></div><div><b>${esc(q.label)}:</b> ${esc(q.text)}</div></div>`).join('')
    : '<p class="muted">Dane nie wskazują tematów do omówienia.</p>';
  const dayRows = Array.from({ length: Math.ceil(d.days.length / 2) }, (_, i) => dayRow(d.days.slice(i * 2, i * 2 + 2), 2, i)).join('');
  const dyn = d.dynamicIsf;
  const lastChange = d.changes[d.changes.length - 1];

  return `<!doctype html><html lang="pl"><head><meta charset="utf-8"><meta name="viewport" content="width=794"><title>Raport dla poradni diabetologicznej</title>
<style>
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: #fff; }
body { font-family: -apple-system, "SF Pro Text", "Helvetica Neue", Arial, sans-serif; color: #18202a; font-size: 8.6pt; line-height: 1.36; -webkit-print-color-adjust: exact; print-color-adjust: exact; -webkit-text-size-adjust: none; }
.page { background: #fff; width: 210mm; height: 297mm; padding: 11mm 13mm 10mm; position: relative; overflow: hidden; page-break-after: always; }
.page:last-child { page-break-after: auto; }
header.top { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2.2pt solid ${PETROL}; padding-bottom: 5pt; }
.brand { color: ${PETROL}; font-weight: 700; font-size: 9pt; letter-spacing: .5pt; }
h1 { font-size: 16pt; margin: 0; font-weight: 700; letter-spacing: -.2pt; }
.meta { display: grid; grid-template-columns: 1.1fr 1.3fr 1.6fr 1fr; gap: 2pt 10pt; margin: 7pt 0 4pt; }
.meta div span, .fill span { display: block; color: #6b7480; font-size: 7pt; text-transform: uppercase; letter-spacing: .5pt; }
.meta div b { font-size: 9pt; font-weight: 600; }
.fillrow { display: flex; gap: 16pt; margin-bottom: 6pt; }
.fill b { display: inline-block; min-width: 70pt; border-bottom: .8pt solid #9aa3ad; height: 11pt; }
h2 { font-size: 9.8pt; margin: 10pt 0 4pt; color: ${PETROL}; text-transform: uppercase; letter-spacing: .6pt; font-weight: 700; }
h2 small { text-transform: none; letter-spacing: 0; color: #6b7480; font-weight: 400; font-size: 7.8pt; margin-left: 6pt; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-size: 7pt; text-transform: uppercase; letter-spacing: .3pt; color: #6b7480; font-weight: 600; border-bottom: 1pt solid #cfd5dc; padding: 2.6pt 5pt; vertical-align: bottom; }
td { padding: 2.8pt 5pt; border-bottom: .6pt solid #e8ebef; vertical-align: top; }
td:first-child { white-space: nowrap; }
tr:last-child td { border-bottom: none; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; } th.num { text-align: right; }
.strong { font-weight: 700; } .muted { color: #6b7480; }
.chg { font-weight: 600; } .chg.same { color: #8a929c; font-weight: 400; }
.kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5pt; margin-top: 7pt; }
.kpi { border: 1pt solid #e1e5ea; border-radius: 6pt; padding: 5pt 7pt; }
.kpi .label { color: #6b7480; font-size: 7pt; text-transform: uppercase; letter-spacing: .4pt; }
.kpi .value { font-size: 15pt; font-weight: 700; letter-spacing: -.3pt; }
.kpi .goal { font-size: 7pt; color: #6b7480; }
.dot { display: inline-block; width: 6pt; height: 6pt; border-radius: 50%; margin-right: 3pt; } .dot.ok { background: ${TIR}; } .dot.warn { background: ${HIGH}; }
.changes td { padding: 2pt 5pt; }
.cgmwrap { display: grid; grid-template-columns: 1fr 104pt; gap: 10pt; align-items: stretch; }
.barwrap { display: flex; gap: 5pt; } .tirbar { width: 16pt; display: flex; flex-direction: column; border-radius: 3pt; overflow: hidden; }
.barlabels { display: flex; flex-direction: column; font-size: 7.2pt; } .bl { display: flex; flex-direction: column; justify-content: center; line-height: 1.15; } .bl span { color: #6b7480; }
.chart { width: 100%; height: auto; font-size: 9px; fill: #4a535e; font-family: -apple-system, Helvetica, Arial; }
.chart .pill { fill: #fff; font-weight: 700; font-size: 9.5px; } .chart .mark { fill: ${PETROL}; font-size: 8px; }
.legend { display: flex; flex-wrap: wrap; gap: 3pt 12pt; font-size: 7.2pt; color: #6b7480; margin-top: 1pt; } .legend span { white-space: nowrap; }
.legend i { display: inline-block; width: 5pt; height: 10pt; border-radius: 2.5pt; margin-right: 4pt; vertical-align: -2pt; }
.two { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12pt; align-items: start; }
tr.flag td { background: #fff6e6; }
.card { border: 1pt solid #e1e5ea; border-radius: 6pt; padding: 7pt 9pt; margin-bottom: 6pt; } .card h3 { margin: 0 0 2pt; font-size: 9pt; }
.q { display: grid; grid-template-columns: 12pt 1fr; gap: 3pt 6pt; margin-bottom: 6pt; } .box { width: 9pt; height: 9pt; border: .9pt solid #6b7480; border-radius: 2pt; margin-top: 1.5pt; }
.lines div { border-bottom: .7pt solid #c6ccd3; height: 15pt; }
.minis { display: flex; flex-direction: column; gap: 9pt; margin-top: 6pt; }
.dayrow { width: 100%; height: auto; display: block; font-family: -apple-system, Helvetica, Arial; } .dayrow .dl { font-size: 9.5px; fill: #18202a; font-weight: 600; } .dayrow .ax { font-size: 8px; fill: #8a929c; }
.small { font-size: 7.2pt; color: #6b7480; margin: 3pt 0 0; }
footer { position: absolute; bottom: 6mm; left: 13mm; right: 13mm; display: flex; justify-content: space-between; color: #8a929c; font-size: 6.8pt; border-top: .6pt solid #e1e5ea; padding-top: 3pt; }
</style></head><body>

<section class="page">
<header class="top"><div><div class="brand">MELLIS</div><h1>Raport dla poradni diabetologicznej</h1></div><div class="small" style="text-align:right">Dane z CGM, pompy i decyzji pętli.<br>Bez zaleceń dawkowania.</div></header>
<div class="meta">
<div><span>Pacjent</span><b>${who}</b></div>
<div><span>Okres</span><b>${d.period.from}–${d.period.to} (14 dni)</b></div>
<div><span>System</span><b>${esc(d.loopName)} (AID)</b></div>
<div><span>Wygenerowano</span><b>${d.generatedOn}</b></div>
</div>
<div class="fillrow"><div class="fill"><span>Masa ciała</span><b></b> kg</div><div class="fill"><span>Dawka dobowa na kg</span><b></b> j/kg</div></div>
${topThree}
<table class="changes"><tr><th colspan="2">Zmiany ustawień w okresie</th><th class="num">Przed</th><th class="num">Po</th></tr>${changes}</table>
<div class="kpis">
<div class="kpi"><div class="label">W zakresie 70–180</div><div class="value">${pct(c.tir)}</div><div class="goal">${ok(c.tir > 70)}cel &gt;70%</div></div>
<div class="kpi"><div class="label">Poniżej 70</div><div class="value">${pct(c.tbr)}</div><div class="goal">${ok(c.tbr < 4)}cel &lt;4%</div></div>
<div class="kpi"><div class="label">Poniżej 54</div><div class="value">${pct(c.vlow)}</div><div class="goal">${ok(c.vlow < 1)}cel &lt;1%</div></div>
<div class="kpi"><div class="label">GMI</div><div class="value">${pct(c.gmi)}</div><div class="goal">średnia ${c.mean} mg/dl</div></div>
<div class="kpi"><div class="label">Zmienność (CV)</div><div class="value">${pct(c.cv)}</div><div class="goal">${ok(c.cv <= 36)}cel ≤36%</div></div>
</div>
<h2>Wyniki CGM <small>cele: konsensus ATTD (Battelino 2019)</small></h2>
<div class="cgmwrap"><table>
<tr><th>Miara</th><th class="num">Ostatnie 14 dni<br>${d.period.from}–${d.period.to}</th><th class="num">Poprzednie 14 dni<br>${d.period.prevFrom}–${d.period.prevTo}</th><th class="num">Różnica</th><th class="num">Cel</th></tr>
${cgm}</table>
<div class="barwrap"><div class="tirbar">${bar}</div><div class="barlabels">${barLabels}</div></div></div>
<p class="small">Różnica względem poprzednich 14 dni (p.p. = punkty procentowe), bez oceny: pokazuje kierunek, nie przyczynę.${lastChange ? ` Zmiany ustawień z tego okresu obejmują tylko część dni — to za mało, by ocenić ich skutek.` : ''}</p>
<h2>Profil dobowy glukozy <small>14 dni nałożonych na jedną dobę, co 15 minut</small></h2>
${dailyProfile(d)}
<div class="legend"><span><i style="background:#1b2430;height:1.8pt;width:12pt;vertical-align:2pt"></i>mediana</span><span><i style="background:#d5dae0"></i>25.–75. percentyl</span><span><i style="background:#f2c230"></i>część powyżej 180</span><span><i style="background:#ee5a52"></i>część poniżej 70</span><span><i style="background:#c3c9d0;width:1.2pt"></i>10.–90. percentyl</span>${d.changes.length ? `<span><i style="background:none;border-left:1pt dashed ${PETROL};border-radius:0;width:0"></i>pory zmienionych ustawień</span>` : ''}</div>
${footer(1)}
</section>

<section class="page">
${head('Pory dnia, insulina i ustawienia')}
<h2>Pory dnia</h2>
<table><tr><th>Pora</th><th class="num">W zakresie</th><th class="num">Poniżej 70</th><th class="num">Powyżej 180</th><th class="num">Mediana (mg/dl)</th><th class="num">Epizody &lt;70</th><th class="num">w tym &lt;54</th></tr>${tod}</table>
<p class="small">Wyróżnienie: czerwone — czas poniżej 70 powyżej 4%; pomarańczowe — powyżej 180 ponad 25% albo w zakresie poniżej 70%. Epizody wg ATTD 2023 (definicja na str. 3).</p>
<h2>Insulina i węglowodany <small>średnio na dobę</small></h2>
<table><tr><th>Składnik</th><th class="num">Na dobę</th><th class="num">Udział</th><th>Uwagi</th></tr>
<tr><td>Całkowita dawka dobowa (TDD)</td><td class="num strong">${f(ins.tdd)} j</td><td class="num">100%</td><td></td></tr>
<tr><td>Bolusy do posiłków</td><td class="num">${f(ins.mealUnits)} j</td><td class="num">${share(ins.mealUnits)}</td><td class="muted">${f(ins.mealBoluses)} bolusa na dobę do ${f(ins.meals)} posiłku (posiłek = jedzenie w odstępach do 45 min)</td></tr>
<tr><td>Korekty ręczne</td><td class="num">${f(ins.correctionUnits)} j</td><td class="num">${share(ins.correctionUnits)}</td><td class="muted">${f(ins.corrections)} na dobę</td></tr>
<tr><td>Mikrobolusy pętli (SMB)</td><td class="num">${f(ins.smb)} j</td><td class="num">${share(ins.smb)}</td><td></td></tr>
<tr><td>Baza</td><td class="num">${f(ins.basal)} j</td><td class="num">${share(ins.basal)}</td><td class="muted">profil: ${f(ins.scheduledBasal)} j; różnica to bazy tymczasowe pętli</td></tr>
<tr><td>Zapisane węglowodany</td><td class="num strong">${ins.carbs} g</td><td></td><td></td></tr></table>
<h2>Ustawienia w ${esc(d.loopName)} <small>stan na ${d.generatedOn}</small></h2>
<div class="two"><div>
<table><tr><th>Baza</th><th class="num">j/h</th><th class="num">Limit SMB = 0 j<br>w decyzjach pętli</th><th class="num">Maks. baza<br>tymczasowa</th></tr>${basalRows}
<tr><td class="strong">Suma</td><td class="num strong">${f(ins.scheduledBasal, 2)} j</td><td></td><td></td></tr></table>
<p class="small">Wyróżnione: godziny, w których pętla liczyła limit mikrobolusa 0 j w większości decyzji. Maks. baza tymczasowa: najczęstsza wartość z decyzji pętli, j/h.</p>
</div><div>
<table><tr><th>ICR</th><th class="num">g/j</th><th class="num">przed zmianą</th></tr>${icrRows}</table>
<table style="margin-top:7pt"><tr><th>ISF</th><th class="num">profil</th><th class="num">w decyzjach pętli<br>(mediana)</th></tr>${isfRows}</table>
<table style="margin-top:7pt"><tr><th>Cel</th><th class="num">mg/dl</th></tr>${targetRows}</table>
<table style="margin-top:7pt"><tr><th colspan="2">Ustawienia pętli</th></tr>
<tr><td>Czas działania insuliny (DIA)</td><td class="num strong">${d.dia !== null ? `${f(d.dia, 0)} h` : '–'}</td></tr>
${dyn.formula ? `<tr><td>Dynamiczny ISF</td><td class="num">${dyn.formula}${dyn.factor ? `, wsp. ${f(dyn.factor)}` : ''}</td></tr>` : ''}
${dyn.limit !== null ? `<tr><td>— górna granica</td><td class="num">${f(dyn.limit)} (osiągnięta w ${dyn.clampedShare}% decyzji)</td></tr>` : ''}
</table></div></div>
${footer(2)}
</section>

<section class="page">
${head('Epizody poniżej 70, wzorce i pytania')}
<h2>Epizody poniżej 70 mg/dl <small>${d.episodes.total} epizodów, w tym ${d.episodes.level2} poniżej 54</small></h2>
<table><tr><th>Pora</th><th class="num">Epizody</th><th class="num">w tym &lt;54</th><th class="num">Ostatni bolus<br>&lt;2 h przed</th><th class="num">2–4 h<br>przed</th><th class="num">&gt;4 h<br>przed</th><th class="num">IOB na początku<br>(mediana, j)</th><th class="num">Węgle zapisane<br>w 3 h przed</th></tr>${lowRows}</table>
<p class="small">Pętla wstrzymała bazę przed ${d.episodes.zeroBasalBefore} z ${d.episodes.total} epizodów. Dla porównania: ${d.shareAfterMealBolus}% doby przypada na 0,5–5 h po bolusie do posiłku. Węglowodany przy spadku zapisane w pętli: ${d.rescues.count} z ${d.episodes.total} epizodów${d.rescues.medianGrams !== null ? ` (mediana ${f(d.rescues.medianGrams, 0)} g)` : ''}; przy pozostałych brak zapisu.</p>
<h2>Wzorce <small>powtarzają się w obu tygodniach</small></h2>
${patterns}
<h2>Pytania rodziców</h2>
${questions}
<div style="margin:8pt 0 2pt" class="small">Pytania własne</div><div class="lines"><div></div><div></div><div></div></div>
<div style="margin:10pt 0 2pt" class="small">Ustalenia poradni</div><div class="lines"><div></div><div></div><div></div></div>
<h2>Metoda</h2>
<p class="small">Źródło: odczyty CGM, bolusy, mikrobolusy, bazy tymczasowe i zapisane decyzje pętli z Nightscout. Odsetki czasu liczone z odczytów co 5 min. Epizod (ATTD 2023): co najmniej 15 min poniżej 70 mg/dl, koniec po co najmniej 15 min powyżej 70; poziom 2: co najmniej 15 min poniżej 54. Bolus do posiłku: bolus z węglowodanami zapisanymi w ciągu 30 min. Wzorzec jest pokazywany, gdy powtarza się w co najmniej 3 dniach i w obu tygodniach; pojedyncza noc poniżej 54 jest wymieniona osobno. Raport nie zawiera przeliczeń zmian ani zaleceń dawkowania.</p>
${footer(3)}
</section>

<section class="page">
${head('Dni po kolei')}
<h2 style="margin-top:8pt">14 dni <small>doby oddzielone kreską o północy; linia czerwona poniżej 70, żółta powyżej 180</small></h2>
<div class="minis">${dayRows}</div>
${footer(4)}
</section>
</body></html>`;
}
