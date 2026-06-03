# Wiki.js Clipboard Image Paste

A Tampermonkey userscript that adds direct clipboard image paste support to Wiki.js v2.

Wiki.js v2 does not natively support pasting images directly from the clipboard into the editor. This script fills that gap by intercepting image paste events, uploading the image through Wiki.js' internal asset upload endpoint, and inserting the uploaded image into the active editor.

It works with both:

- Markdown Editor
- Visual Editor / WYSIWYG Editor

## Features

- Paste screenshots directly with `Ctrl + V` / `Cmd + V`
- Uploads images to Wiki.js automatically
- Inserts Markdown image syntax in the Markdown editor
- Inserts images into the Visual Editor using a synthetic paste event so CKEditor updates its internal document model correctly
- Reuses the active Wiki.js authentication token
- Optional deterministic file naming using image hashes to avoid duplicate uploads
- It's by default configured to use localhost` and `127.0.0.1`, if you have Wiki.js hosted in a different hostname change the @match at the script headers to your hostname/URL.

## Why?

Wiki.js has a good editor experience, but the lack of direct clipboard image paste support makes troubleshooting notes and technical documentation slower to write.

This script was created to make workflows like this possible:

Take screenshot
Press Cmd + V / Ctrl + V in Wiki.js
Image is uploaded and inserted automatically
Continue writing
