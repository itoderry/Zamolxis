---
name: scanner
description: Scan a page from a connected scanner (Canon/WIA) with the scan_document tool and save/open the image.
---
# Scan a document
`scan_document` acquires a page via Windows WIA and saves it (default a .jpg under exports), then opens it. The Windows scan dialog may ask the user to pick the scanner/source. Pass `dest` to control the output path. To then make a searchable PDF or OCR it, hand the saved file to your shell/PDF tools.
