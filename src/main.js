import { logger } from "./logger.js";
import * as Comlink from "comlink";
import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { history, indentWithTab } from "@codemirror/commands";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";

// UTILS

function debounce(func, delay) {
  let timeout;
  return function (...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), delay);
  };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// WORKER SETUP

const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});

const fileWorker = Comlink.wrap(worker);

const workerReady = new Promise((resolve) => {
  worker.addEventListener(
    "message",
    (e) => {
      if (e.data === "ready") {
        resolve();
      }
    },
    { once: true },
  );
});

// VIEW SWITCHING

function switchView(viewName) {
  logger.info(`Switching to view: ${viewName}`);
  document.body.dataset.view = viewName;
  if (viewName === "app") {
    updateLayout();
  }
}

// FILE MANAGEMENT

let currentFile = null;
let initialTocString = null;
let isExampleFile = false;

function setTitle(fileName) {
  document.title = `${
    window.navigator.standalone ? "" : "TocToc: "
  }${fileName}`;
}

const delayOpen = false;
async function openFile(file, isExample = false) {
  if (!file) return;
  logger.info(`Opening file: ${file.name}`);

  switchView("loading");

  if (delayOpen) {
    await sleep(500);
  }

  currentFile = file;
  isExampleFile = isExample;

  try {
    await workerReady;
    const fileBuffer = await file.arrayBuffer();
    logger.debug("File buffer created, opening with worker.");
    await fileWorker.openFile(
      Comlink.transfer(fileBuffer, [fileBuffer]),
      file.name,
    );
  } catch (e) {
    logger.error("Error opening file:", e);
    if (e.message.includes("Password required")) {
      let isRetry = false;
      while (true) {
        const promptMessage = isRetry
          ? "Incorrect password. Please try again:"
          : "This PDF is password protected. Please enter the password:";
        const password = prompt(promptMessage);

        if (password === null) {
          logger.warn("User cancelled password entry.");
          switchView("welcome");
          return;
        }

        const authenticated = await fileWorker.authenticatePassword(password);
        if (authenticated) {
          logger.info("Password authentication successful.");
          break;
        } else {
          logger.warn("Incorrect password entered.");
          isRetry = true;
        }
      }
    } else {
      alert("Error opening the file: " + e.message);
      switchView("welcome");
      return;
    }
  }

  let outline;
  try {
    outline = await fileWorker.getOutline();
    logger.debug("Outline loaded from worker.");
  } catch (e) {
    logger.error("Failed to get outline:", e);
    alert("Failed to load the outline.");
    outline = null;
  }

  const tocString = outline
    ? await fileWorker.formatToc(outline)
    : "1: First page";

  setupEditor(tocString);
  initialTocString = editor.state.doc.toString();
  setTitle(file.name);

  switchView("app");
  editor.focus();
}

async function saveFile() {
  logger.info("Saving file...");
  try {
    const tocString = editor.state.doc.toString();
    logger.debug("Parsing ToC string.");
    const newOutline = await fileWorker.parseToc(tocString);

    if (!newOutline) {
      throw new Error(
        "Could not parse the Table of Contents. Please check the format.",
      );
    }

    logger.debug("Setting new outline in worker.");
    await fileWorker.setOutline(newOutline);
    logger.debug("Retrieving file buffer from worker.");
    const buffer = await fileWorker.getFile();

    const blob = new Blob([buffer], { type: "application/pdf" });
    const originalFilename = currentFile ? currentFile.name : "document.pdf";
    const newFilename = originalFilename.replace(/(\.pdf)$/i, "_toc$1");

    logger.info(`Downloading file as: ${newFilename}`);
    downloadBlob(blob, newFilename);
    initialTocString = tocString;
  } catch (e) {
    logger.error("An error occurred while saving the PDF:", e);
    alert("An error occurred while saving the PDF: " + e.message);
  }
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

const exampleFileName = "/LADR4e.pdf";
const exampleFileDisplayName = "example.pdf";
async function loadExampleFile() {
  logger.info("Loading example file.");
  try {
    const response = await fetch(exampleFileName);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const blob = await response.blob();
    const file = new File([blob], exampleFileDisplayName, {
      type: "application/pdf",
    });
    await openFile(file, true);
  } catch (e) {
    logger.error("Could not load initial file:", e);
    alert("Could not load the example file.");
    switchView("welcome");
  }
}

// TEXT EDITOR

let editor;

function setupEditor(tocString) {
  if (editor) {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: tocString },
    });
  } else {
    const state = EditorState.create({
      doc: tocString,
      extensions: [
        history(),
        highlightActiveLine(),
        indentUnit.of("\t"),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet || update.docChanged) {
            handleSelectionChange();
          }
        }),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      ],
    });
    editor = new EditorView({
      state,
      parent: tocEditorEl,
    });
  }
  const firstLine = editor.state.doc.line(1);
  editor.dispatch({
    selection: { anchor: firstLine.to, head: firstLine.to },
    userEvent: "move.toEndOfFirstLine",
  });

  setCurrentLinePageNumber(1, true);
}

const debounceTimeout = 150;

const debouncedSetCurrentLinePageNumber = debounce(
  setCurrentLinePageNumber,
  debounceTimeout,
);

function handleSelectionChange() {
  if (!editor) return;

  const { from } = editor.state.selection.main;
  const line = editor.state.doc.lineAt(from);

  if (line.text) {
    const match = line.text.match(/^\s*(\d+):/);
    const pageNumber = match ? parseInt(match[1], 10) : null;
    debouncedSetCurrentLinePageNumber(pageNumber, false);
  } else {
    debouncedSetCurrentLinePageNumber(null, false);
  }
}

// UI LOGIC

const pageImg = document.getElementById("page");
const fileInput = document.getElementById("fileInput");
const ctaButton = document.getElementById("ctaButton");
const openButton = document.getElementById("openButton");
const saveButton = document.getElementById("saveButton");
const helpButton = document.getElementById("helpButton");
const tocEditorEl = document.getElementById("tocEditor");

let currentPageUrl = null;
let currentPageNumber = null;
pageImg.style.display = "none";
let renderRequestCounter = 0;

async function setCurrentLinePageNumber(pageNumber, force = false) {
  if (!force && pageNumber === currentPageNumber) {
    return;
  }
  logger.debug(`Setting current line page number to: ${pageNumber}`);

  if (currentPageUrl) {
    URL.revokeObjectURL(currentPageUrl);
    currentPageUrl = null;
  }

  const pageCount = await fileWorker.countPages();
  if (
    pageNumber === null ||
    isNaN(pageNumber) ||
    pageNumber < 1 ||
    pageNumber > pageCount
  ) {
    pageImg.src = "";
    pageImg.style.display = "none";
    currentPageNumber = null;
    return;
  }

  try {
    const requestId = ++renderRequestCounter;
    const result = await fileWorker.renderPage(pageNumber, requestId);

    if (result.requestId !== renderRequestCounter) {
      return;
    }

    if (result.png) {
      const blob = new Blob([result.png], { type: "image/png" });
      currentPageUrl = URL.createObjectURL(blob);
      pageImg.src = currentPageUrl;
      pageImg.style.display = "block";
      currentPageNumber = pageNumber;
    } else {
      throw new Error("Rendered page was empty.");
    }
  } catch (e) {
    logger.error("Failed to render page", e);
    pageImg.src = "";
    pageImg.style.display = "none";
    currentPageNumber = null;
  }
}

fileInput.addEventListener("change", async function (event) {
  if (event.target.files.length > 0) {
    await openFile(event.target.files[0], false);
  }
});

ctaButton.addEventListener("click", function () {
  fileInput.click();
});

function checkForUnsavedChanges() {
  const hasUnsavedChanges =
    initialTocString !== null &&
    editor &&
    editor.state.doc.toString() != initialTocString;
  if (hasUnsavedChanges && !isExampleFile) {
    if (
      !confirm(
        "You have unsaved changes. Are you sure you want to open a new file and discard them?",
      )
    ) {
      editor.focus();
      return false;
    }
  }
  return true;
}

openButton.addEventListener("click", function () {
  if (checkForUnsavedChanges()) {
    fileInput.click();
    editor.focus();
  }
});

saveButton.addEventListener("click", function () {
  saveFile();
  editor.focus();
});

helpButton.addEventListener("click", function () {
  window.open("index.html?help=true", "_blank");
  editor.focus();
});

// SPLIT PANE LOGIC

const PANE_PROPORTION_STORAGE_KEY = "tocTocPaneProportion";
const MIN_PANE_SIZE_PX = 0;

const separator = document.querySelector(".separator");
const splitPanes = document.querySelector(".split-panes");

let isResizing = false;

function handleMouseUp() {
  isResizing = false;
  document.body.classList.remove("resizing-active");
  document.removeEventListener("mousemove", handleMouseMove);
  document.removeEventListener("mouseup", handleMouseUp);
  separator.classList.remove("resizing");

  const currentProportion = getComputedStyle(
    document.documentElement,
  ).getPropertyValue("--pane-proportion");
  localStorage.setItem(PANE_PROPORTION_STORAGE_KEY, currentProportion);
}

separator.addEventListener("mousedown", (e) => {
  e.preventDefault();
  isResizing = true;
  document.body.classList.add("resizing-active");
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", handleMouseUp);
  separator.classList.add("resizing");
});

function handleMouseMove(e) {
  if (!isResizing) return;

  const containerRect = splitPanes.getBoundingClientRect();
  const isVertical = splitPanes.classList.contains("vertical");

  let proportion;
  if (isVertical) {
    const newHeight = containerRect.bottom - e.clientY;
    proportion = (newHeight / containerRect.height) * 100;
  } else {
    const newWidth = e.clientX - containerRect.left;
    proportion = (newWidth / containerRect.width) * 100;
  }

  const minProportion =
    (MIN_PANE_SIZE_PX /
      (isVertical ? containerRect.height : containerRect.width)) *
    100;
  const maxProportion = 100 - minProportion;

  const clampedProportion = Math.max(
    minProportion,
    Math.min(proportion, maxProportion),
  );

  document.documentElement.style.setProperty(
    "--pane-proportion",
    `${clampedProportion}%`,
  );
}

function updateLayout(isVertical) {
  if (document.body.dataset.view !== "app") {
    return;
  }
  splitPanes.classList.toggle("vertical", isVertical);
  splitPanes.classList.toggle("horizontal", !isVertical);
}

const resizeObserver = new ResizeObserver(() => {
  updateLayout(window.innerHeight > window.innerWidth);
});

resizeObserver.observe(document.body);

const savedProportion = localStorage.getItem(PANE_PROPORTION_STORAGE_KEY);
if (savedProportion) {
  document.documentElement.style.setProperty(
    "--pane-proportion",
    savedProportion,
  );
}

updateLayout(window.innerHeight > window.innerWidth);

// DRAG AND DROP

function isValidDrag(event) {
  const view = document.body.dataset.view;
  if (view === "loading") {
    return false;
  }

  const dt = event.dataTransfer;
  if (dt.types && dt.types.includes("Files")) {
    if (dt.items && dt.items.length === 1) {
      const item = dt.items[0];
      if (item.kind === "file" && item.type === "application/pdf") {
        return true;
      }
    }
  }
  return false;
}

document.body.addEventListener("dragover", (event) => {
  if (isValidDrag(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
});

document.body.addEventListener("drop", async (event) => {
  if (isValidDrag(event)) {
    event.preventDefault();
    event.stopPropagation();

    if (!checkForUnsavedChanges()) {
      return;
    }

    logger.info("File dropped");
    const file = event.dataTransfer.files[0];
    await openFile(file, false);
  }
});

// INITIALIZATION

const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has("example")) {
  window.history.replaceState({}, document.title, window.location.pathname);
  loadExampleFile();
}

if (window.navigator.standalone) {
  document.body.classList.add("standalone");
}
