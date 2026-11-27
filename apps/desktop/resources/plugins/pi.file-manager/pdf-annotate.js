"use strict";

/**
 * Writing PDF annotations back into the file.
 *
 * pdf.js renders Highlight / Underline / StrikeOut annotations from the PDF itself,
 * so an annotation that lives only in the viewer disappears on reload. These are
 * standard annotation objects appended to the page's /Annots, which means any other
 * reader shows them too.
 *
 * Coordinates arrive from the viewer as fractions of the page box measured from the
 * **top-left** (what the DOM knows); PDF user space is points from the bottom-left and
 * can differ from the CSS size, so the conversion happens here, once.
 */

const { PDFDocument, PDFName, PDFArray, PDFString } = require("./vendor/pdf-lib.min.js");

const SUBTYPES = { highlight: "Highlight", underline: "Underline", strike: "StrikeOut" };
const COLORS = {
  highlight: [1, 0.85, 0.15],
  underline: [0.85, 0.1, 0.1],
  strike: [0.85, 0.1, 0.1],
};

/** QuadPoints wants upper-left, upper-right, lower-left, lower-right — per rect. */
function quadsFor(pageWidth, pageHeight, rects) {
  const quads = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    const x0 = rect.x0 * pageWidth;
    const x1 = rect.x1 * pageWidth;
    const yTop = pageHeight - rect.y0 * pageHeight;
    const yBottom = pageHeight - rect.y1 * pageHeight;
    quads.push(x0, yTop, x1, yTop, x0, yBottom, x1, yBottom);
    minX = Math.min(minX, x0);
    maxX = Math.max(maxX, x1);
    minY = Math.min(minY, yBottom);
    maxY = Math.max(maxY, yTop);
  }
  return { quads, rect: [minX, minY, maxX, maxY] };
}

/**
 * Append annotations to a PDF and return the saved bytes.
 *
 * `ops` is one annotation per page: `{ page, kind, rects: [{x0,y0,x1,y1}], text }`,
 * where the rects are fractions of that page's box. Nothing is deleted: existing
 * /Annots are extended, and an untouched document round-trips byte-identical only
 * in content — the file is rewritten, which the caller has to accept.
 */
async function appendAnnotations(bytes, ops) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const pages = doc.getPages();
  const ctx = doc.context;
  let added = 0;
  const skipped = [];

  for (const [index, op] of ops.entries()) {
    const page = pages[(op.page ?? 1) - 1];
    const subtype = SUBTYPES[op.kind];
    if (!page || !subtype || !Array.isArray(op.rects) || op.rects.length === 0) {
      skipped.push({ index, page: op.page, reason: page ? "bad-kind-or-rects" : "no-such-page" });
      continue;
    }
    const { width, height } = page.getSize();
    const { quads, rect } = quadsFor(width, height, op.rects);
    const annotation = ctx.obj({
      Type: "Annot",
      Subtype: subtype,
      Rect: rect,
      QuadPoints: quads,
      C: op.color ?? COLORS[op.kind],
      CA: op.alpha ?? 0.45,
      F: 4,
      T: PDFString.of(op.author || "PI-Desktop"),
      Contents: PDFString.of(op.text || ""),
      NM: PDFString.of(`pi-${Date.now()}-${index}`),
    });
    const ref = ctx.register(annotation);
    // `lookup(..., PDFArray)` asserts and throws when the page has no /Annots yet, so
    // read it as a plain object and only treat it as an array when it is one.
    const existing = page.node.get(PDFName.of("Annots"));
    if (existing instanceof PDFArray) {
      existing.push(ref);
    } else if (existing) {
      skipped.push({ index, page: op.page, reason: "annots-not-an-array" });
      continue;
    } else {
      page.node.set(PDFName.of("Annots"), ctx.obj([ref]));
    }
    added += 1;
  }

  if (added === 0) return { bytes, added, skipped };
  const saved = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes: Buffer.from(saved), added, skipped };
}

/**
 * Same contract as main.js `atomicWrite`, for bytes rather than text: a PDF with a
 * highlight appended is binary, and writing it as utf8 corrupts every byte above 0x7f.
 */
async function writeFileAtomicBytes(abs, bytes, mode) {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const dir = path.dirname(abs);
  const suffix = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`;
  const tmp = path.join(dir, `.${path.basename(abs)}.${suffix}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(tmp, "w");
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    if (mode != null) await fs.chmod(tmp, mode).catch(() => {});
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tmp, abs);
        return;
      } catch (error) {
        const transient = error?.code === "EPERM" || error?.code === "EBUSY" || error?.code === "EACCES";
        if (!transient || attempt >= 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { appendAnnotations, writeFileAtomicBytes };
