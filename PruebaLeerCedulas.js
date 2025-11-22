// package.json: { "type":"module", "dependencies": { "playwright":"^1.47.0", "express":"^4" } }
import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

// ======================= Ajustes robustos para PaaS =======================
const NAV_TIMEOUT_MS = Number(process.env.NAV_TIMEOUT_MS || 60000);
const SEL_TIMEOUT_MS = Number(process.env.SEL_TIMEOUT_MS || 30000);
const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
];

async function launchBrowser() {
  return chromium.launch({ headless: true, args: LAUNCH_ARGS });
}

async function newPage(browser) {
  const context = await browser.newContext({
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    ignoreHTTPSErrors: true,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(SEL_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  return page;
}

async function navigateAndWait(page, url) {
  // Navegación “suave” y espera explícita de campos reales
  await page.goto(url, { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForLoadState('domcontentloaded', { timeout: NAV_TIMEOUT_MS }).catch(() => {});
  await page.waitForSelector(
    'input#nombre, input[formcontrolname="nombre"], input#curp, input[formcontrolname="curp"]',
    { timeout: SEL_TIMEOUT_MS }
  );
}

// ======================= Utilidades de scraping =======================
async function listarInputs(page) {
  const scrape = async frame => frame.evaluate(() => {
    const vis = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    return Array.from(document.querySelectorAll('input, select, textarea'))
      .filter(vis)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        id: el.id || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        formcontrolname: el.getAttribute('formcontrolname') || '',
        labelText: (() => {
          const lbl = el.id && document.querySelector(`label[for="${el.id}"]`);
          return lbl ? lbl.textContent.trim() : '';
        })()
      }));
  });
  const items = [{ frame: 'main', inputs: await scrape(page) }];
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    items.push({ frame: f.url(), inputs: await scrape(f) });
  }
  return items;
}

// ======================= Endpoints =======================
app.get('/inspect-campos', async (_req, res) => {
  const browser = await launchBrowser();
  const page = await newPage(browser);
  try {
    await navigateAndWait(page, 'https://cedulaprofesional.sep.gob.mx/');
    const mapa = await listarInputs(page);
    res.json({ ok: true, frames: mapa });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    await browser.close();
  }
});

app.post('/consulta-cedula', async (req, res) => {
  const { nombre, paterno, materno, curp } = req.body || {};
  if (!nombre && !curp) {
    return res.status(400).json({ error: 'Proporcione al menos {nombre,paterno,materno} o {curp}.' });
  }

  const browser = await launchBrowser();
  const page = await newPage(browser);

  try {
    await navigateAndWait(page, 'https://cedulaprofesional.sep.gob.mx/');

    // Relleno por label con fallback a selectores estáticos
    const fillIf = async (labelText, css, val) => {
      if (!val) return;
      try { await page.getByLabel(new RegExp(labelText, 'i')).fill(val); }
      catch { await page.locator(css).fill(val); }
    };

    if (curp) {
      await fillIf('CURP', 'input#curp, input[formcontrolname="curp"]', curp);
    } else {
      await fillIf('Nombre\\(s\\)*', 'input#nombre, input[formcontrolname="nombre"]', nombre);
      await fillIf('Primer Apellido', 'input#primerApellido, input[formcontrolname="primerApellido"]', paterno);
      await fillIf('Segundo Apellido', 'input#segundoApellido, input[formcontrolname="segundoApellido"]', materno);
    }

    // Buscar y esperar resultados/“sin resultados”
    await page.getByRole('button', { name: /buscar/i }).click();
    const gotRows = await Promise.race([
      page.waitForSelector('table tbody tr', { timeout: 25000 }).then(() => true).catch(() => false),
      page.waitForSelector('text=/sin resultados|no se encontraron/i', { timeout: 25000 }).then(() => false).catch(() => false),
    ]);

    const queryObj = { nombre, paterno, materno, curp };
    if (!gotRows) return res.json({ ok: true, query: queryObj, coincidencias: 0, resultados: [] });

    // [Cédula, Nombre, Ap1, Ap2, Género, Institución, Profesión, Entidad, Año, Constancia]
    const resultados = await page.$$eval('table tbody tr', rows =>
      rows.map(r => {
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

    // Variables derivadas útiles
    const total = resultados.length;
    const primerRegistro = resultados[0] || null;
    const cedulas = resultados.map(r => r.cedula);
    const universidades = Array.from(new Set(resultados.map(r => r.universidad).filter(Boolean)));
    const entidades = Array.from(new Set(resultados.map(r => r.entidad).filter(Boolean)));
    const aniosNum = resultados.map(r => Number(String(r.anno).replace(/[^\d]/g, ''))).filter(Number.isFinite);
    const ultimoAnno = aniosNum.length ? Math.max(...aniosNum) : null;

    if (String(req.query.only || '').toLowerCase() === 'vars') {
      return res.json({ ok: true, query: queryObj, total, primerRegistro, cedulas, universidades, entidades, aniosNum, ultimoAnno });
    }

    res.json({ ok: true, query: queryObj, coincidencias: total, resumen: { total, primerRegistro, cedulas, universidades, entidades, aniosNum, ultimoAnno }, resultados });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    await browser.close();
  }
});

app.get('/diag/httpbin', async (_req, res) => {
  try {
    const r = await fetch('https://httpbin.org/get', { cache: 'no-store' });
    res.json({ ok: r.ok, status: r.status });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(process.env.PORT || 8080, () => console.log('Playwright listo'));