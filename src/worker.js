import { logger } from "./logger.js";
import mupdf from "mupdf";
import * as Comlink from "comlink";

// muPDF WORKER

function _recursiveSetOutline(pdfDoc, iter, outline) {
  for (const item of outline) {
    if (item.page !== undefined) {
      item.uri = pdfDoc.formatLinkURI({ page: item.page, type: "Fit" });
    }
    iter.insert(item);
    if (item.down && item.down.length > 0) {
      iter.prev();
      if (iter.down() === 1) {
        _recursiveSetOutline(pdfDoc, iter, item.down);
        iter.up();
      }
    }
    iter.next();
  }
}

function _dateToPDFDate(date) {
  // D:YYYYMMDDHHmmSSOHH'mm'
  const pad = (num) => num.toString().padStart(2, "0");
  const timezoneOffset = -date.getTimezoneOffset();
  const offsetHours = pad(Math.floor(Math.abs(timezoneOffset) / 60));
  const offsetMinutes = pad(Math.abs(timezoneOffset) % 60);
  const offsetSign = timezoneOffset >= 0 ? "+" : "-";
  return `D:${date.getFullYear()}${pad(
    date.getMonth() + 1,
  )}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(
    date.getSeconds(),
  )}${offsetSign}${offsetHours}'${offsetMinutes}'`;
}

function _updateMetadata(pdfDoc) {
  const trailer = pdfDoc.getTrailer();
  let info = trailer.get("Info");

  if (!info) {
    logger.warn("Could not find Info dictionary in PDF. So created one.");
    info = pdfDoc.newDictionary();
    trailer.put("Info", info);
  }

  // ModDate
  const pdfDateString = _dateToPDFDate(new Date());
  info.put("ModDate", pdfDoc.newString(pdfDateString));
  logger.info(`ModDate metadata set to: "${pdfDateString}"`);

  // Producer
  const producer = "MuPDF.js";
  info.put("Producer", pdfDoc.newString(producer));
  logger.info(`PDF Producer metadata set to '${producer}'.`);
}

class FileWorker {
  constructor() {
    this.pdf = null;
    this.pdfDoc = null;
  }

  async openFile(fileBuffer, fileName) {
    logger.info(`Opening file: ${fileName}`);
    this.pdf = mupdf.Document.openDocument(fileBuffer, fileName);
    if (this.pdf.needsPassword()) {
      logger.warn("File needs a password.");
      throw new Error("Password required");
    }
    this.pdfDoc = this.pdf.asPDF();
    logger.info("File opened successfully in worker.");
  }

  authenticatePassword(password) {
    if (!this.pdf) {
      logger.error("authenticatePassword called before openFile.");
      return false;
    }
    logger.info("Attempting to authenticate with password.");
    const authenticated = this.pdf.authenticatePassword(password);
    if (authenticated) {
      logger.info("Password authentication successful in worker.");
      this.pdfDoc = this.pdf.asPDF();
    } else {
      logger.warn("Password authentication failed in worker.");
    }
    return authenticated;
  }

  getOutline() {
    if (!this.pdf) {
      logger.error("getOutline called before openFile.");
      return null;
    }
    try {
      logger.info("Loading outline from PDF.");
      const outline = this.pdf.loadOutline();
      logger.info("Outline loaded successfully.");
      return outline;
    } catch (e) {
      logger.error("Failed to load outline:", e);
      throw new Error("Failed to load outline");
    }
  }

  setOutline(outline) {
    if (!this.pdfDoc) {
      logger.error("setOutline called before PDF document is available.");
      return;
    }

    logger.info("Setting new outline.");

    const trailer = this.pdfDoc.getTrailer();
    const root = trailer.get("Root");
    const outlines = root.get("Outlines");

    if (outlines && outlines.isDictionary()) {
      logger.debug("Deleting existing outlines.");
      root.delete("Outlines");
    }

    const iter = this.pdfDoc.outlineIterator();
    _recursiveSetOutline(this.pdfDoc, iter, outline);
    iter.destroy();
    logger.info("New outline set successfully.");
  }

  getFile() {
    if (!this.pdfDoc) {
      logger.error("getFile called before PDF document is available.");
      return null;
    }
    _updateMetadata(this.pdfDoc);
    logger.info("Saving PDF to buffer.");
    const buffer = this.pdfDoc.saveToBuffer({ garbage: true, clean: true });
    logger.info("PDF saved successfully.");
    return buffer.asUint8Array();
  }

  renderPage(pageNumber, requestId) {
    logger.debug(
      `Worker rendering page: ${pageNumber}, request ID: ${requestId}`,
    );
    if (
      !this.pdf ||
      pageNumber === null ||
      isNaN(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > this.pdf.countPages()
    ) {
      logger.warn(`Invalid page number requested: ${pageNumber}`);
      return { png: null, requestId };
    }
    const page = this.pdf.loadPage(pageNumber - 1);
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(2, 2),
      mupdf.ColorSpace.DeviceRGB,
    );
    const png = pixmap.asPNG();
    pixmap.destroy();
    page.destroy();
    logger.debug(`Page ${pageNumber} rendered successfully.`);
    return { png, requestId };
  }

  countPages() {
    return this.pdf ? this.pdf.countPages() : 0;
  }

  parseToc(tocString) {
    let lines = tocString.split("\n");
    const root = { down: [] };
    const stack = [{ node: root, level: -1 }];

    // Convert spaces to tabs
    const getIndentSize = (line) => (line.match(/^ */) || [""])[0].length;

    const levels = lines.map(getIndentSize).filter((size) => size > 0);

    if (levels.length > 0) {
      const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
      const indentSize = levels.reduce(gcd);

      if (indentSize > 1) {
        lines = lines.map((line) => {
          const spaces = getIndentSize(line);
          const tabs = "\t".repeat(spaces / indentSize);
          return tabs + line.substring(spaces);
        });
      }
    }

    // Parse
    for (const line of lines) {
      if (line.trim() === "") continue;

      const level = (line.match(/^\t*/) || [""])[0].length;
      const content = line.substring(level);

      const match = content.match(/^(?:(\d+):\s*)?(.*)$/);
      if (!match) continue;

      const [, pageNumStr, title] = match;
      const item = { title: title.trim() };
      if (pageNumStr) {
        const pageNum = parseInt(pageNumStr, 10);
        if (!isNaN(pageNum)) {
          item.page = pageNum - 1; // MuPDF page numbers are 0-indexed
        }
      }

      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      const parent = stack[stack.length - 1].node;
      if (!parent.down) {
        parent.down = [];
      }
      parent.down.push(item);

      stack.push({ node: item, level: level });
    }

    return root.down;
  }

  formatToc(outline, depth = 0) {
    let result = "";
    for (const item of outline) {
      result += "\t".repeat(depth);
      if (item.page !== undefined) {
        result += `${item.page + 1}: ${item.title}\n`;
      } else {
        result += `${item.title}\n`;
      }
      if (item.down) {
        result += this.formatToc(item.down, depth + 1);
      }
    }
    return result;
  }
}

Comlink.expose(new FileWorker());
self.postMessage("ready");
