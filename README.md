# PDF Page Tools

Independent Zotero 10 plugin. No LaTeX Suite dependency or runtime
packages. Install the XPI through Tools → Plugins → Install Plugin From File.
The manifest points to this repository's update feed. The feed is initially empty;
install new builds manually until downloadable releases are added to it.
Reopen an already-open PDF to show the new toolbar controls. The PDF right-click
menu also provides all three actions, including in existing readers.

- **Copy page as image:** clean full page, white background, PNG at up to 144 DPI.
  Reader zoom does not affect resolution. Maximum 16 million pixels / 8192px per
  side prevents excessive memory use. Uses the last-focused split PDF view.
- **Copy page as PDF file:** puts a reference to a real one-page PDF file on the
  clipboard. Paste into a supporting file manager or app as a file/attachment.
  It is not an image suitable for direct pasting into a note. Files are stored
  in the OS temporary directory under `zotero-page-tools`, with unique filenames,
  a private folder and user-only file permissions. They survive plugin shutdown
  so paste keeps working; the OS may remove them on reboot or temp cleanup.
  You can delete these temporary files manually when no longer needed.
- **Save pages as PDF…:** enter physical page numbers such as `1-3, 7, 10-12`,
  or `all`, then choose an output file. Defaults to the current page. Duplicates
  are removed; pages stay in original document order. Printed page labels may
  differ from physical page numbers.

PDF export works on a copy of the original PDF bytes via Zotero's existing PDF
worker. Text/vector content and annotations already embedded in the PDF are
retained; Zotero annotation overlays are not added. Image copying excludes
annotation overlays. Temporary viewer rotations affect images, not PDF exports.
The source attachment is never edited, and saving over it is refused.
Reading Mode is not supported; switch to the original PDF. Encrypted PDFs may
be rejected by the export worker even if readable in the viewer.

This first build uses private reader/PDF-worker internals, isolated in
`context()` and `extractPDF()`, and is version-bounded to Zotero 10.
Run `npm install` and `npm test` for unit tests, then `npm run test:zotero` to
test one-page and range extraction against the installed Zotero worker.
The integration test verifies retained text and an unchanged source PDF.
Native Gecko/Wayland clipboard, save
dialogs and the live reader must still be validated manually.
