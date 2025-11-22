// package.json: { "type":"module", "dependencies": { "playwright":"^1.47.0", "express":"^4" } }
import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json());

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

async function ensureReady(page) {
  await page.goto('https://cedulaprofesional.sep.gob.mx/', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});
  // Intentar asegurar pestaña “Datos generales”
  await page.getByRole('tab', { name: /datos generales/i }).click({ timeout: 3000 }).catch(()=>{});
}

app.get('/inspect-campos', async (_req, res) => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'es-MX' });
  try {
    await ensureReady(page);
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

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'es-MX' });
  try {
    await page.goto('https://cedulaprofesional.sep.gob.mx/', { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Relleno robusto
    const fillIf = async (labelText, css, val) => {
      if (!val) return;
      try { await page.getByLabel(new RegExp(labelText, 'i')).fill(val, { timeout: 6000 }); }
      catch { await page.locator(css).fill(val, { timeout: 6000 }); }
    };

    if (curp) {
      await fillIf('CURP', 'input#curp, input[formcontrolname="curp"]', curp);
    } else {
      await fillIf('Nombre\\(s\\)*', 'input#nombre, input[formcontrolname="nombre"]', nombre);
      await fillIf('Primer Apellido', 'input#primerApellido, input[formcontrolname="primerApellido"]', paterno);
      await fillIf('Segundo Apellido', 'input#segundoApellido, input[formcontrolname="segundoApellido"]', materno);
    }

    await page.getByRole('button', { name: /buscar/i }).click({ timeout: 10000 });

    const gotRows = await Promise.race([
      page.waitForSelector('table tbody tr', { timeout: 20000 }).then(() => true).catch(() => false),
      page.waitForSelector('text=/sin resultados|no se encontraron/i', { timeout: 20000 }).then(() => false).catch(() => false),
    ]);

    const queryObj = { nombre, paterno, materno, curp };

    if (!gotRows) {
      return res.json({ ok: true, query: queryObj, coincidencias: 0, resumen: {}, resultados: [] });
    }

    // Parse de filas
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
          status: 0,   // el portal no lo expone
          tipo: 'C1'   // convención
        };
      })
    );

    // ⇨ RESUMEN/VARIABLES DERIVADAS (guardadas y devueltas)
    const total = resultados.length;
    const primerRegistro = resultados[0] || null;

    const cedulas = resultados.map(r => r.cedula);
    const carreras = resultados.map(r => r.carrera);
    const universidades = Array.from(new Set(resultados.map(r => r.universidad).filter(Boolean)));
    const entidades = Array.from(new Set(resultados.map(r => r.entidad).filter(Boolean)));
    const aniosNum = resultados
      .map(r => Number(String(r.anno).replace(/[^\d]/g, '')))
      .filter(n => Number.isFinite(n));
    const ultimoAnno = aniosNum.length ? Math.max(...aniosNum) : null;

    // Variables “planas” por si quiere leerlas fácil en cliente
    const vars = {
      total,
      primerRegistro,
      cedulas,
      carreras,
      universidades,
      entidades,
      aniosNum,
      ultimoAnno
    };

    // Opción: solo variables (útil para dashboards). Ej: ?only=vars
    if (String(req.query.only || '').toLowerCase() === 'vars') {
      return res.json({ ok: true, query: queryObj, ...vars });
    }

    // Respuesta completa (incluye variables y lista cruda)
    res.json({
      ok: true,
      query: queryObj,
      coincidencias: total,
      resumen: vars,
      resultados
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    await browser.close();
  }
});

app.listen(process.env.PORT || 8080, () => console.log('Playwright listo'));