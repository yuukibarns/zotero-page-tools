const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
let JSDOM;
try { ({JSDOM}=require('jsdom')); }
catch { ({JSDOM}=createRequire(require('node:path').resolve(__dirname, '../zotero-latex-suite/package.json'))('jsdom')); }
const tools = require('./page-tools.js');
const manifest = require('./manifest.json');
for (const field of ['id', 'update_url', 'strict_max_version']) {
  assert.ok(manifest.applications.zotero[field], `Zotero requires ${field}`);
}
assert.equal(manifest.version, require('./package.json').version);
assert.equal(new URL(manifest.applications.zotero.update_url).protocol, 'https:');
(async () => {
  assert.deepEqual(tools.parsePages('1-3, 7, 3, 10-12',12),[0,1,2,6,9,10,11]);
  assert.deepEqual(tools.parsePages('all',3),[0,1,2]);
  for (const value of ['', '0', '4', '2-1', '1,', 'x', '1-9999999999999999']) assert.throws(()=>tools.parsePages(value,3));
  const original = Uint8Array.from([1,2,3]);
  const document = {numPages:3,getData:async()=>original};
  const app = {pdfDocument:document,pdfViewer:{currentPageNumber:2,pagesRotation:90}};
  const reader = {type:'pdf',_internalReader:{_lastView:{_iframeWindow:{PDFViewerApplication:app}}},_item:{getField:()=> 'Test / document.pdf'}};
  const ctx = tools.context(reader);
  assert.equal(ctx.page,2);assert.equal(ctx.rotation,90);
  assert.match(tools.filename(reader,[1]),/Test _ document-page-2.pdf/);
  assert.throws(()=>tools.context({type:'epub'}),/PDF reader/);
  assert.throws(()=>tools.context({type:'pdf'}),/not ready/);
  let queueCalls=0;
  const worker = {_enqueue:async fn=>{queueCalls++;return fn();},_query:async(action,data,transfer)=>{
    assert.equal(action,'pdf.deletePages');assert.deepEqual(data.pageIndexes,[0,2]);
    assert.notEqual(data.buf,original.buffer);assert.equal(transfer[0],data.buf);
    new Uint8Array(data.buf)[0]=99;return {buf:Uint8Array.from([4,5]).buffer};
  }};
  assert.deepEqual([...await tools.extractPDF(ctx,[1],worker)],[4,5]);
  assert.deepEqual([...original],[1,2,3],'source PDF bytes never modified');
  assert.deepEqual([...await tools.extractPDF(ctx,[0,1,2],worker)],[1,2,3]);assert.equal(queueCalls,1);
  await assert.rejects(tools.extractPDF(ctx,[],worker),/Invalid/);
  const dom = new JSDOM('<body></body>');
  const win = dom.window;
  let renderOptions, canvas;
  const page = {rotate:90,getViewport:({scale,rotation})=>{assert.equal(rotation,180);return {width:600*scale,height:800*scale};},render:opts=>{renderOptions=opts;return {promise:Promise.resolve()};}};
  document.getPage=async pageNumber=>{assert.equal(pageNumber,2);return page;};
  const create=win.document.createElement.bind(win.document);
  win.document.createElement=name=>{
    const el=create(name);
    if(name==='canvas'){canvas=el;el.getContext=()=>({});el.toDataURL=()=> 'data:image/png;base64,AQID';}
    return el;
  };
  ctx.win=win;
  assert.equal(await tools.renderImage(ctx),'data:image/png;base64,AQID');
  assert.equal(renderOptions.background,'white');assert.equal(renderOptions.annotationMode,0);
  assert.equal(canvas.width,0,'render canvas memory released');
  // Simulate Gecko hiding PDFPageProxy methods and blocking TypedArray access.
  // These are boundary-contract regressions, not a replacement for Gecko UI tests.
  const hiddenPage = { rotate: 90 };
  document.getPage = async () => hiddenPage;
  await assert.rejects(tools.renderImage(ctx), /getViewport/);
  let waivers = 0;
  assert.equal(await tools.renderImage(ctx, value => value, value => {
    waivers++;
    return value === hiddenPage ? page : value;
  }), 'data:image/png;base64,AQID');
  assert.equal(waivers, 2, 'both page and render task cross the bridge');
  document.getPage = async () => page;
  const blockedBytes = new Proxy(original, { get(_target, key) {
    if (key === 'then') return undefined;
    throw new Error('TypedArray access over Xrays');
  } });
  document.getData = async () => blockedBytes;
  await assert.rejects(tools.extractPDF(ctx, [1], worker), /Xrays/);
  let clones = 0;
  const copyBytes = data => {
    assert.equal(data, blockedBytes);clones++;
    return Uint8Array.from(original);
  };
  assert.deepEqual([...await tools.extractPDF(ctx, [1], worker, copyBytes)], [4,5]);
  assert.deepEqual([...await tools.extractPDF(ctx, [0,1,2], worker, copyBytes)], [1,2,3]);
  assert.equal(clones, 2);
  assert.deepEqual([...original], [1,2,3]);
  document.getData = async () => original;
  app.pdfDocument={};await assert.rejects(tools.extractPDF(ctx,[1],worker),/changed/);app.pdfDocument=document;
  // Public reader hooks, duplicate toolbar rendering, busy actions and shutdown.
  const listeners=new Map(),errors=[];
  const env={Zotero:{Reader:{registerEventListener:(name,handler)=>listeners.set(name,handler),unregisterEventListener:name=>listeners.delete(name)},logError:e=>errors.push(e),getMainWindow:()=>win},
    Components:{},Services:{prompt:{alert:()=>{}}}};
  const stop=tools.install(env,'test');
  const event={reader,doc:win.document,append:node=>win.document.body.append(node)};
  listeners.get('renderToolbar')(event);listeners.get('renderToolbar')(event);
  assert.equal(win.document.querySelectorAll('[data-pdf-page-tools]').length,1);
  assert.equal(win.document.querySelectorAll('button').length,3);
  const menu=[];listeners.get('createViewContextMenu')({reader,append:item=>menu.push(item)});
  assert.equal(menu.length,3);assert.equal(menu[0].onCommand(),undefined,'no privileged Promise returned to content');
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(errors.length,1,'errors are visible, not silent');
  stop();assert.equal(listeners.size,0);assert.equal(win.document.querySelectorAll('button').length,0);
  const files=new Map([['/source.pdf',original]]),folders=new Set(['/tmp']);let serial=0,clipboardValue,saveTarget='/export.pdf',promptPages='1,3';
  class File {
    constructor(path){this.path=path;}clone(){return new File(this.path);}append(part){this.path+='/'+part;}
    exists(){return files.has(this.path)||folders.has(this.path);}isDirectory(){return folders.has(this.path);}isSymlink(){return false;}
    create(type){if(type==='dir')folders.add(this.path);else files.set(this.path,new Uint8Array());}
    createUnique(){this.path+='-'+(++serial);files.set(this.path,new Uint8Array());}remove(){files.delete(this.path);}
    equals(other){return this.path===other.path;}get leafName(){return this.path.split('/').pop();}set leafName(value){this.path=this.path.slice(0,this.path.lastIndexOf('/')+1)+value;}
  }
  const clipboard={setData:t=>clipboardValue=t};
  const classes={
    '@mozilla.org/widget/transferable;1':{createInstance:()=>({values:new Map(),init(){},addDataFlavor(){},setTransferData(type,value){this.values.set(type,value);}})},
    '@mozilla.org/widget/clipboard;1':{getService:()=>clipboard},
    '@mozilla.org/supports-string;1':{createInstance:()=>({data:''})}
  };
  class Picker {
    constructor(){this.modeSave=1;this.returnOK=0;this.returnReplace=2;this.file=saveTarget;}init(){}appendFilter(){}async show(){return 0;}
  }
  const io={write:async(path,bytes)=>files.set(path,Uint8Array.from(bytes)),move:async(from,to)=>{files.set(to,files.get(from));files.delete(from);}};
  reader._item.getFilePathAsync=async()=>'/source.pdf';
  const env2={...env,IOUtils:io,ChromeUtils:{importESModule:()=>({FilePicker:Picker})},
    Components:{classes,utils:{cloneInto: data => Uint8Array.from(data)},interfaces:{nsIFile:{DIRECTORY_TYPE:'dir',NORMAL_FILE_TYPE:'file'},nsIClipboard:{kGlobalClipboard:1}}},
    Services:{dirsvc:{get:()=>new File('/tmp')},io:{newFileURI:file=>({spec:'file://'+file.path})},prompt:{prompt:(_w,_t,_m,value)=>{value.value=promptPages;return true;},alert:()=>{}}},
    Zotero:{...env.Zotero,File:{pathToFile:path=>new File(path)},PDFWorker:{_enqueue:async fn=>fn(),_query:async(_action,data)=>({buf:Uint8Array.from([data.pageIndexes.length,9]).buffer})}}
  };
  const stop2=tools.install(env2,'test');const menu2=[];
  listeners.get('createViewContextMenu')({reader,append:item=>menu2.push(item)});
  menu2[1].onCommand();await new Promise(resolve=>setTimeout(resolve,10));
  const copied=clipboardValue.values.get('application/x-moz-file');
  assert.ok(copied.path.startsWith('/tmp/zotero-page-tools/'));assert.ok(files.has(copied.path));
  assert.ok(clipboardValue.values.get('text/uri-list').data.includes(copied.path));
  menu2[2].onCommand();await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual([...files.get('/export.pdf')],[1,9],'range save removes only the unwanted page');
  assert.deepEqual(files.get('/source.pdf'),original);
  assert.ok(![...files.keys()].some(path=>path.includes('page-tools-tmp')),'save staging file removed');
  saveTarget='/source.pdf';const beforeErrors=errors.length;
  menu2[2].onCommand();await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(errors.length,beforeErrors+1,'source-overwrite attempt visibly rejected');assert.deepEqual(files.get('/source.pdf'),original);
  stop2();assert.ok(files.has(copied.path),'clipboard PDF survives plugin disable');
  dom.window.close();console.log('Page ranges, source preservation, image rendering, reader hooks and cleanup passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
