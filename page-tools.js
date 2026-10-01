/* No dependency on LaTeX Suite, Obsidian or an external PDF service. */
var PageTools = (() => {
  function parsePages(value, count) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid PDF page count");
    const input = String(value).trim();
    if (input.toLowerCase() === "all") return Array.from({ length: count }, (_, i) => i);
    if (!input) throw new Error("Enter page numbers or ranges, for example 1-3, 7");
    const pages = new Set();
    for (const part of input.split(',')) {
      const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(part);
      if (!match) throw new Error("Invalid page range: " + part);
      const from = Number(match[1]), to = Number(match[2] || match[1]);
      if (from < 1 || to > count || from > to) throw new Error(`Page numbers must be between 1 and ${count}, in ascending ranges`);
      for (let page = from; page <= to; page++) pages.add(page - 1);
    }
    return [...pages].sort((a, b) => a - b);
  }
  function context(reader) {
    if (reader.type !== 'pdf') throw new Error("This action requires a PDF reader");
    const view = reader._internalReader?._lastView;
    const frame = view?._iframeWindow;
    const win = frame?.wrappedJSObject || frame;
    const app = win?.PDFViewerApplication;
    if (!app?.pdfDocument || !app.pdfViewer) throw new Error("PDF not ready, or Reading Mode is active. Switch to the original PDF view.");
    const page = app.pdfViewer.currentPageNumber, count = app.pdfDocument.numPages;
    if (!Number.isInteger(page) || page < 1 || page > count) throw new Error("Cannot determine the current PDF page");
    return { reader, win, app, document: app.pdfDocument, page, count, rotation: app.pdfViewer.pagesRotation || 0 };
  }
  function ensureCurrent(ctx) {
    if (ctx.app.pdfDocument !== ctx.document) throw new Error("The PDF changed while the action was running. Try again.");
  }
  async function renderImage(ctx, clone = value => value, unwrap = value => value) {
    // Awaiting a content Promise can restore an Xray wrapper. PDFPageProxy's
    // prototype methods are not visible through it; waive only this known proxy.
    const page = unwrap(await ctx.document.getPage(ctx.page));
    ensureCurrent(ctx);
    let scale = 2; // 144 DPI, independent of reader zoom / display scaling
    const rotation = ((page.rotate || 0) + ctx.rotation) % 360;
    let viewport = page.getViewport(clone({ scale, rotation }, ctx.win));
    scale *= Math.min(1, 8192 / Math.max(viewport.width, viewport.height), Math.sqrt(16_000_000 / (viewport.width * viewport.height)));
    viewport = page.getViewport(clone({ scale, rotation }, ctx.win));
    if (!(viewport.width > 0 && viewport.height > 0)) throw new Error("Invalid page dimensions");
    const canvas = ctx.win.document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    try {
      const options = new ctx.win.Object();
      options.canvasContext = canvas.getContext('2d'); options.viewport = viewport;
      options.background = 'white'; options.annotationMode = 0;
      await unwrap(page.render(options)).promise;
      ensureCurrent(ctx);
      return canvas.toDataURL('image/png');
    } finally { canvas.width = 0; canvas.height = 0; }
  }
  async function extractPDF(ctx, pages, worker, copyBytes = data => Uint8Array.from(data)) {
    const selected = new Set(pages);
    if (!selected.size || pages.some(page => !Number.isInteger(page) || page < 0 || page >= ctx.count)) throw new Error("Invalid page selection");
    const data = await ctx.document.getData();
    ensureCurrent(ctx);
    // Clone into the privileged realm BEFORE reading bytes. Iterating a content
    // TypedArray through Xrays is forbidden. Never transfer PDF.js's own buffer.
    const buf = copyBytes(data).buffer;
    const remove = Array.from({ length: ctx.count }, (_, i) => i).filter(i => !selected.has(i));
    if (!remove.length) return new Uint8Array(buf);
    if (typeof worker?._enqueue !== 'function' || typeof worker?._query !== 'function') throw new Error("Unsupported Zotero PDF worker");
    const result = await worker._enqueue(() => worker._query('pdf.deletePages', { buf, pageIndexes: remove }, [buf]), true);
    ensureCurrent(ctx);
    if (!result?.buf || result.buf.byteLength === 0) throw new Error("The PDF worker returned no output");
    return new Uint8Array(result.buf);
  }
  function filename(reader, pages) {
    const raw = reader._item?.getField('title') || 'document';
    const name = raw.replace(/\.pdf$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 100) || 'document';
    return `${name}-${pages.length === 1 ? 'page-' + (pages[0] + 1) : 'pages'}.pdf`;
  }
  function install(env, id) {
    const { Zotero, Components: C, Services, ChromeUtils, IOUtils, atob } = env;
    const copyBytes = data => C.utils.cloneInto(data, globalThis);
    const busy = new WeakSet(), roots = new Set();
    let stopped = false;
    const parent = reader => reader._window || Zotero.getMainWindow();
    const fileFrom = path => Zotero.File.pathToFile(path);
    function transferable() {
      const t = C.classes['@mozilla.org/widget/transferable;1'].createInstance(C.interfaces.nsITransferable);
      t.init(null); return t;
    }
    function clipboard(t) {
      C.classes['@mozilla.org/widget/clipboard;1'].getService(C.interfaces.nsIClipboard)
        .setData(t, null, C.interfaces.nsIClipboard.kGlobalClipboard);
    }
    function copyImage(url) {
      const bytes = Uint8Array.from(atob(url.split(',')[1]), character => character.charCodeAt(0));
      const image = C.classes['@mozilla.org/image/tools;1'].getService(C.interfaces.imgITools)
        .decodeImageFromArrayBuffer(bytes.buffer, 'image/png');
      const t = transferable();t.addDataFlavor('application/x-moz-nativeimage');t.setTransferData('application/x-moz-nativeimage', image);clipboard(t);
    }
    function copyFile(file) {
      const t = transferable(); t.addDataFlavor('application/x-moz-file'); t.setTransferData('application/x-moz-file', file);
      const uri = Services.io.newFileURI(file).spec;
      for (const [type, value] of [['text/uri-list', uri + '\r\n'], ['x-special/gnome-copied-files', 'copy\n' + uri]]) {
        const string = C.classes['@mozilla.org/supports-string;1'].createInstance(C.interfaces.nsISupportsString);string.data = value;
        t.addDataFlavor(type);t.setTransferData(type, string);
      }
      clipboard(t);
    }
    async function temporaryPDF(bytes, name) {
      const dir = Services.dirsvc.get('TmpD', C.interfaces.nsIFile).clone();
      dir.append('zotero-page-tools');
      if (!dir.exists()) dir.create(C.interfaces.nsIFile.DIRECTORY_TYPE, 0o700);
      if (!dir.isDirectory() || dir.isSymlink()) throw new Error("Unsafe temporary PDF directory");
      dir.permissions = 0o700;
      const file = dir.clone();file.append(name);file.createUnique(C.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o600);
      try { await IOUtils.write(file.path, bytes);return file; }
      catch (error) { file.remove(false);throw error; }
    }
    async function savePDF(reader, ctx) {
      const input = { value: String(ctx.page) };
      if (!Services.prompt.prompt(parent(reader), 'Save pages as PDF', `Physical page numbers (1–${ctx.count}). Example: 1-3, 7. Use “all” for every page.`, input, null, {})) return;
      const pages = parsePages(input.value, ctx.count);
      const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
      const picker = new FilePicker();picker.init(parent(reader), 'Save pages as PDF', picker.modeSave);
      picker.appendFilter('PDF', '*.pdf');picker.defaultExtension = 'pdf';picker.defaultString = filename(reader, pages);
      const result = await picker.show();
      if (result !== picker.returnOK && result !== picker.returnReplace) return;
      ensureCurrent(ctx);
      // Never allow the selected output path to overwrite the source attachment.
      const source = await reader._item.getFilePathAsync();
      if (source && fileFrom(source).equals(fileFrom(picker.file))) throw new Error("Choose a different filename; the source PDF must not be overwritten");
      const bytes = await extractPDF(ctx, pages, Zotero.PDFWorker, copyBytes);
      if (stopped) return;
      const temporary = fileFrom(picker.file);temporary.leafName += '.page-tools-tmp';
      temporary.createUnique(C.interfaces.nsIFile.NORMAL_FILE_TYPE, 0o600);
      try {
        await IOUtils.write(temporary.path, bytes);
        if (!stopped) await IOUtils.move(temporary.path, picker.file, { noOverwrite: result !== picker.returnReplace });
      } finally { if (temporary.exists()) temporary.remove(false); }
    }
    async function run(reader, action) {
      if (stopped || busy.has(reader)) return;
      busy.add(reader);
      for (const root of roots) if (root.reader === reader) root.node.querySelectorAll('button').forEach(b => b.disabled = true);
      try {
        const ctx = context(reader);
        if (action === 'image') {
          const image = await renderImage(ctx, (value, win) => C.utils.cloneInto(value, win), value => C.utils.waiveXrays(value));
          if (!stopped) copyImage(image);
        } else if (action === 'pdf') {
          const bytes = await extractPDF(ctx, [ctx.page - 1], Zotero.PDFWorker, copyBytes);
          if (!stopped) { const file = await temporaryPDF(bytes, filename(reader, [ctx.page - 1])); if (!stopped) copyFile(file); }
        } else await savePDF(reader, ctx);
      } catch (error) { if (!stopped) { Zotero.logError(error);Services.prompt.alert(parent(reader), 'PDF Page Tools', String(error)); } }
      finally {
        busy.delete(reader);
        for (const root of roots) if (root.reader === reader) root.node.querySelectorAll('button').forEach(b => b.disabled = false);
      }
    }
    const actions = [['image', 'Copy page as image'], ['pdf', 'Copy page as PDF file'], ['save', 'Save pages as PDF…']];
    function toolbar({ reader, doc, append }) {
      if (reader.type !== 'pdf' || stopped) return;
      for (const root of roots) if (root.reader === reader) { root.node.remove();root.win?.removeEventListener('unload', root.unload);roots.delete(root); }
      const node = doc.createElement('div');node.dataset.pdfPageTools = 'true';node.setAttribute('role', 'group');node.setAttribute('aria-label', 'PDF Page Tools');
      node.style.cssText = 'display:flex;align-items:center;gap:3px;margin-inline:5px';
      for (const [action, label] of actions) {
        const button = doc.createElement('button');button.type = 'button';button.textContent = action === 'image' ? 'Copy image' : action === 'pdf' ? 'Copy PDF' : 'Save PDF…';
        button.title = label;button.setAttribute('aria-label', label);
        button.style.cssText = 'font:inherit;font-size:11px;padding:3px 6px;white-space:nowrap;color:inherit;background:transparent;border:1px solid GrayText;border-radius:4px;cursor:pointer';
        // Do not return a privileged Promise into a content callback.
        button.addEventListener('click', () => { void run(reader, action); });node.append(button);
      }
      append(node);
      const root = { node, reader, win: doc.defaultView, unload: () => { node.remove();roots.delete(root); } };
      roots.add(root);root.win?.addEventListener('unload', root.unload, { once: true });
    }
    function menu({ reader, append }) {
      if (reader.type !== 'pdf' || stopped) return;
      for (const [action, label] of actions) append({ label, disabled: busy.has(reader), onCommand() { void run(reader, action); } });
    }
    Zotero.Reader.registerEventListener('renderToolbar', toolbar, id);
    Zotero.Reader.registerEventListener('createViewContextMenu', menu, id);
    return () => {
      stopped = true;
      Zotero.Reader.unregisterEventListener('renderToolbar', toolbar);
      Zotero.Reader.unregisterEventListener('createViewContextMenu', menu);
      for (const root of roots) { root.node.remove();root.win?.removeEventListener('unload', root.unload); } roots.clear();
      // Clipboard PDFs deliberately survive shutdown; deleting them would break paste.
    };
  }
  return { parsePages, context, renderImage, extractPDF, filename, install };
})();
if (typeof module !== 'undefined') module.exports = PageTools;
