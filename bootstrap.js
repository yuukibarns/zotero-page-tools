var controller;
async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const scope = {};
  Services.scriptloader.loadSubScript(rootURI + "page-tools.js", scope);
  controller = scope.PageTools.install({ Zotero, Components, Services, ChromeUtils,
    IOUtils: typeof IOUtils !== 'undefined' ? IOUtils : Zotero.getMainWindow().IOUtils,
    atob: text => Zotero.getMainWindow().atob(text) }, id);
}
function shutdown() { controller?.(); controller = null; }
function install() {}
function uninstall() {}
