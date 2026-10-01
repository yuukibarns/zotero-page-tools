// Optional integration: real installed Zotero PDF worker, no profile or files modified.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const tools = require('./page-tools.js');
const archive=process.env.ZOTERO_ARCHIVE || '/usr/lib/zotero/app/omni.ja';
const source=execFileSync('unzip',['-p',archive,'resource/document-worker/worker.js'],{encoding:'utf8',maxBuffer:10_000_000});
function fixture() {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>'];
  for(let i=0;i<3;i++) objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 6 0 R >> >> /Contents ${7+i} 0 R >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(let i=0;i<3;i++) {const text=`BT /F1 18 Tf 50 700 Td (Page ${i+1}) Tj ET`;objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);}
  let pdf='%PDF-1.4\n',offsets=[0];
  objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
  const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets.slice(1)) pdf+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
const pending=new Map();let id=0;
const sandbox={console,TextEncoder,TextDecoder,URL,Uint8Array,Uint16Array,Uint32Array,Int32Array,Float32Array,Float64Array,ArrayBuffer,DataView,setTimeout,clearTimeout,performance,atob,btoa,crypto:require('node:crypto').webcrypto,navigator:{userAgent:'Node',platform:'Linux'}};
// Worker initializes this rendering-only constant; extraction never uses it.
sandbox.DOMMatrix=class {constructor(){this.a=this.d=1;this.b=this.c=this.e=this.f=0;}};
sandbox.self=sandbox;
sandbox.postMessage=message=>{
  if(message.responseID) {
    const waiter=pending.get(message.responseID);pending.delete(message.responseID);
    if(message.error)waiter.reject(new Error(JSON.stringify(message.error)));else waiter.resolve(message.data);
  } else if(message.action==='FetchData') {
    try {
      const path=/^(cmaps|standard_fonts)\//.test(message.data)?'resource/reader/pdf/web/'+message.data:'resource/document-worker/'+message.data;
      const bytes=execFileSync('unzip',['-p',archive,path],{maxBuffer:20_000_000});
      sandbox.onmessage({data:{responseID:message.id,data:Uint8Array.from(bytes).buffer}});
    }catch(error){sandbox.onmessage({data:{responseID:message.id,error:String(error)}});}
  }
};
vm.runInNewContext(source,sandbox,{timeout:10000});
const query=(action,data)=>new Promise((resolve,reject)=>{const request=++id;pending.set(request,{resolve,reject});sandbox.onmessage({data:{id:request,action,data}});});
(async()=>{
  const bytes=fixture(),original=Uint8Array.from(bytes),document={numPages:3,getData:async()=>bytes};
  const ctx={document,app:{pdfDocument:document},count:3};
  const worker={_enqueue:async fn=>fn(),_query:query};
  const selected=await tools.extractPDF(ctx,[1],worker);
  const data=await query('pdf.getFulltext',{buf:Uint8Array.from(selected).buffer});
  assert.equal(data.totalPages,1);assert.match(data.text,/Page 2/);assert.doesNotMatch(data.text,/Page [13]/);
  assert.deepEqual(bytes,original,'original three-page PDF unchanged');
  const range=await tools.extractPDF(ctx,tools.parsePages('1,3',3),worker);
  const rangeText=await query('pdf.getFulltext',{buf:Uint8Array.from(range).buffer});
  assert.equal(rangeText.totalPages,2);assert.match(rangeText.text,/Page 1/);assert.match(rangeText.text,/Page 3/);assert.doesNotMatch(rangeText.text,/Page 2/);
  console.log('Installed Zotero worker extracts one page and disjoint ranges; text preserved and source unchanged.');
})().catch(error=>{console.error(error);process.exitCode=1;});
