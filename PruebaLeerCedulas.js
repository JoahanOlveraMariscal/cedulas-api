// PruebaLeerCedulas.js
// package.json: { "type":"module", "dependencies": { "playwright":"^1.47.0", "express":"^4" } }

import express from 'express';
import { chromium } from 'playwright';

const app  = express();
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);

// ======================= Parámetros por ENV =======================
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 180000);
const SEL_TIMEOUT_MS = Number(process.env.SEL_TIMEOUT_MS || 90000);
const PORT           = Number(process.env.PORT || 8080);

// Flags seguros para PaaS (Render/Fly/Docker)
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--single-process',
  '--no-zygote',
  '--disable-gpu',
  '--disable-web-security',
  '--window-size=1280,900',
];

// ======================= Navegador (pool simple) =======================
// Una sola instancia de Chromium y múltiples contextos/páginas por solicitud.
let browserPromise = null;
async function ensureBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({ headless: true, args: LAUNCH_ARGS });
  }
  return browserPromise;
}

// Crea un nuevo contexto+página (y enruta descargas pesadas)
async function newPage() {
  const browser = await ensureBrowser();
  const context = await browser.newContext({
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(SEL_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  // Evita recursos pesados innecesarios
  await page.route('**/*', r => {
    const url = r.request().url();
    if (/\.(mp4|avi|m3u8|webm|mov|woff2?|ttf|otf)$/i.test(url)) return r.abort();
    r.continue();
  });

  return { context, page };
}

// ======================= Utilidades multi-frame =======================
async function waitAnySelectorInAnyFrame(page, selectors, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const f of page.frames()) {
      for (const sel of selectors) {
        const loc = f.locator(sel);
        try { if (await loc.first().isVisible({ timeout: 250 })) return true; } catch {}
      }
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function getLocatorInAnyFrameByLabel(page, labelRegex) {
  for (const f of page.frames()) {
    const loc = f.getByLabel(labelRegex);
    try { if (await loc.first().isVisible({ timeout: 300 })) return loc.first(); } catch {}
  }
  return null;
}

async function getLocatorInAnyFrame(page, css) {
  for (const f of page.frames()) {
    const loc = f.locator(css);
    try { if (await loc.first().isVisible({ timeout: 300 })) return loc.first(); } catch {}
  }
  return null;
}

async function fillAny(page, labelText, css, value) {
  if (!value) return false;
  const byLabel = await getLocatorInAnyFrameByLabel(page, new RegExp(labelText, 'i'));
  if (byLabel) { await byLabel.fill(value); return true; }
  const byCss = await getLocatorInAnyFrame(page, css);
  if (byCss) { await byCss.fill(value); return true; }
  return false;
}

async function clickBuscar(page) {
  for (const f of page.frames()) {
    const btn = f.getByRole('button', { name: /buscar/i });
    try { if (await btn.isVisible({ timeout: 500 })) { await btn.click(); return true; } } catch {}
  }
  for (const f of page.frames()) {
    const btn = f.locator('button:has-text("Buscar")');
    try { if (await btn.first().isVisible({ timeout: 500 })) { await btn.first().click(); return true; } } catch {}
  }
  return false;
}

async function waitRowsInAnyFrame(page, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const f of page.frames()) {
      if (await f.locator('table tbody tr').count() > 0) return true;
    }
    await page.waitForTimeout(250);
  }
  throw new Error('Timeout esperando filas de resultados.');
}

async function waitTextInAnyFrame(page, regex, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    for (const f of page.frames()) {
      try { if (await f.getByText(regex).first().isVisible({ timeout: 250 })) return true; } catch {}
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function collectRows(page) {
  for (const f of page.frames()) {
    const n = await f.locator('table tbody tr').count();
    if (n > 0) {
      return f.$$eval('table tbody tr', trs =>
        trs.map(r => {
          const t = Array.from(r.querySelectorAll('td')).map(td => (td.textContent || '').trim());
          return {
            cedula: t[0] || '',
            nombre: t[1] || '',
            paterno: t[2] || '',
            materno: t[3] || '',
            carrera: t[6] || '',
            universidad: t[5] || '',
            entidad: t[7] || '',
            anno: t[8] || '',
            status: 0,
            tipo: 'C1'
          };
        })
      );
    }
  }
  return [];
}

// ======================= Navegación robusta =======================
async function navigateAndWait(page, url) {
  await page.goto(url, { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  const ok = await waitAnySelectorInAnyFrame(page, [
    'input#nombre', 'input[formcontrolname="nombre"]',
    'input#primerApellido', 'input[formcontrolname="primerApellido"]',
    'input#segundoApellido', 'input[formcontrolname="segundoApellido"]',
    'input#curp', 'input[formcontrolname="curp"]'
  ], SEL_TIMEOUT_MS);
  if (!ok) throw new Error('No se localizaron campos (posible cambio de layout o bloqueo remoto).');
}

// ======================= Endpoints =======================
app.get('/', (_req, res) => res.json({ ok: true, msg: 'cedulas-api up' }));
app.get('/diag/ping', (_req, res) => res.json({ ok: true, pid: process.pid, ts: Date.now() }));
app.get('/diag/httpbin', async (_req, res) => {
  try { const r = await fetch('https://httpbin.org/get', { cache: 'no-store' }); res.json({ ok: r.ok, status: r.status }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/inspect-campos', async (_req, res) => {
  const { context, page } = await newPage();
  try {
    await navigateAndWait(page, 'https://cedulaprofesional.sep.gob.mx/');
    const frames = [];
    for (const f of page.frames()) {
      const inputs = await f.evaluate(() => {
        const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
        return Array.from(document.querySelectorAll('input, select, textarea'))
          .filter(vis)
          .map(el => ({
            tag: el.tagName.toLowerCase(),
            id: el.id || '',
            fcn: el.getAttribute('formcontrolname') || '',
            ph: el.getAttribute('placeholder') || ''
          }));
      });
      frames.push({ url: f.url(), inputs });
    }
    res.json({ ok: true, frames });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally { await context.close(); }
});

app.get('/diag/snap', async (_req, res) => {
  const { context, page } = await newPage();
  try {
    await page.goto('https://cedulaprofesional.sep.gob.mx/', { timeout: NAV_TIMEOUT_MS }).catch(()=>{});
    await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(()=>{});
    const png  = await page.screenshot({ fullPage: true }).catch(()=>null);
    const html = await page.content().catch(()=> '');
    const frames = page.frames().map(f => ({ url: f.url() }));
    res.json({
      ok: true,
      title: await page.title().catch(()=>null),
      url: page.url(),
      htmlPreview: (html || '').slice(0, 4000),
      frames,
      screenshotBase64: png ? Buffer.from(png).toString('base64') : null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally { await context.close(); }
});

app.get('/diag/self', async (_req,res) => {
  try {
    const { context, page } = await newPage();
    const ua = await page.evaluate(()=>navigator.userAgent);
    await context.close();
    res.json({ ok: true, ua });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post('/consulta-cedula', async (req, res) => {
  const { nombre, paterno, materno, curp } = req.body || {};
  if (!nombre && !curp) return res.status(400).json({ error: 'Proporcione al menos {nombre,paterno,materno} o {curp}.' });

  const { context, page } = await newPage();
  try {
    await navigateAndWait(page, 'https://cedulaprofesional.sep.gob.mx/');

    if (curp) {
      await fillAny(page, 'CURP', 'input#curp, input[formcontrolname="curp"]', curp);
    } else {
      await fillAny(page, 'Nombre\\(s\\)*', 'input#nombre, input[formcontrolname="nombre"]', nombre);
      await fillAny(page, 'Primer Apellido', 'input#primerApellido, input[formcontrolname="primerApellido"]', paterno);
      await fillAny(page, 'Segundo Apellido', 'input#segundoApellido, input[formcontrolname="segundoApellido"]', materno);
    }

    const clicked = await clickBuscar(page);
    if (!clicked) throw new Error('No se pudo accionar el botón “Buscar”.');

    const got = await Promise.race([
      waitRowsInAnyFrame(page, 45000).then(() => true).catch(() => false),
      waitTextInAnyFrame(page, /sin resultados|no se encontraron/i, 45000).then(() => false).catch(() => false),
    ]);

    const queryObj = { nombre, paterno, materno, curp };
    if (!got) return res.json({ ok: true, query: queryObj, coincidencias: 0, resultados: [] });

    const resultados = await collectRows(page);
    const total = resultados.length;
    const primerRegistro = resultados[0] || null;
    const cedulas = resultados.map(r => r.cedula);
    const universidades = Array.from(new Set(resultados.map(r => r.universidad).filter(Boolean)));
    const entidades = Array.from(new Set(resultados.map(r => r.entidad).filter(Boolean)));
    const aniosNum = resultados.map(r => Number(String(r.anno).replace(/[^\d]/g, ''))).filter(Number.isFinite);
    const ultimoAnno = aniosNum.length ? Math.max(...aniosNum) : null;

    res.json({
      ok: true,
      query: queryObj,
      coincidencias: total,
      resumen: { total, primerRegistro, cedulas, universidades, entidades, aniosNum, ultimoAnno },
      resultados
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally { await context.close(); }
});

// ======================= Arranque servidor =======================
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('Playwright listo en puerto', PORT);
});
server.keepAliveTimeout = 75_000;
server.headersTimeout   = 90_000;
server.requestTimeout   = 0;